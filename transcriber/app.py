# The transcriber: Whisper (faster-whisper, CPU, int8) behind one HTTP endpoint.
# Space sends one person's audio clip at a time and gets the words back with
# timings. It keeps nothing: the clip lives in memory for the length of the call.
#
# Runs as its own Railway service (`transcriber`) so a long
# transcription can never make the office lag, and sleeps when idle. Railway has
# no GPUs, so the model is picked for CPU: see README "Choosing the model".

from __future__ import annotations

import hmac
import io
import os
import threading
import time

from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.concurrency import run_in_threadpool
from faster_whisper import WhisperModel

MODEL = os.environ.get("WHISPER_MODEL", "small")
LANGUAGE = os.environ.get("WHISPER_LANGUAGE", "en") or None  # "" = detect per clip
KEY = os.environ.get("TRANSCRIBER_KEY", "")
# Optional vocabulary hint: names and jargon Whisper would otherwise spell its own way,
# e.g. WHISPER_PROMPT="Acme, HighLevel, sub-account, Slack".
PROMPT = os.environ.get("WHISPER_PROMPT", "") or None
MAX_BYTES = 4 * 1024 * 1024  # ~30 s clips are ~100 KB; this is a generous ceiling
MAX_SECONDS = 100  # Space sends ~30 s clips; a long one could tie the service up for everyone

app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)  # nothing to browse here
_model: WhisperModel | None = None
_lock = threading.Lock()  # one clip at a time: CPU-bound, parallel runs only slow each other down


def model() -> WhisperModel:
    global _model
    if _model is None:
        _model = WhisperModel(MODEL, device="cpu", compute_type="int8", cpu_threads=os.cpu_count() or 2,
                              download_root=os.environ.get("WHISPER_MODELS", "/models"))
    return _model


@app.get("/health")
def health():
    return {"ok": True, "model": MODEL, "loaded": _model is not None}


@app.post("/transcribe")
async def transcribe(request: Request, x_transcriber_key: str = Header(default="")):
    if not KEY or not hmac.compare_digest(x_transcriber_key, KEY):
        raise HTTPException(401, "bad key")
    body = await request.body()
    if not body or len(body) > MAX_BYTES:
        raise HTTPException(413, "empty or too large")
    t0 = time.time()
    # Whisper is CPU-bound: run it off the event loop so /health still answers while it works.
    out, info = await run_in_threadpool(_run, body)
    return {"segments": out, "duration": round(info.duration, 2), "language": info.language, "took": round(time.time() - t0, 2), "model": MODEL}


def _run(body: bytes):
    with _lock:
        m = model()  # a load failure stays a 500: Space keeps the audio and tries again later
        try:
            return _decode(m, body)
        except HTTPException:
            raise
        except Exception as e:  # a clip that can't be decoded won't get better: 422, Space drops just that clip
            raise HTTPException(422, f"can't read this clip: {str(e)[:120]}")


def _decode(m: WhisperModel, body: bytes):
    segments, info = m.transcribe(
        io.BytesIO(body),
        language=LANGUAGE,
        vad_filter=True,  # skips silence, which is also where Whisper invents words
        beam_size=1,
        condition_on_previous_text=False,
        initial_prompt=PROMPT,
    )
    # transcribe() is lazy: the length is known before any decoding work starts.
    if info.duration > MAX_SECONDS:
        raise HTTPException(413, f"clip is {info.duration:.0f}s; at most {MAX_SECONDS}s")
    out = [{"start": round(s.start, 2), "end": round(s.end, 2), "text": s.text.strip()} for s in segments if s.text.strip()]
    return out, info
