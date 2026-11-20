# transcriber

Whisper behind one endpoint, for Proximity Office's "Transcribe this room". Its own
Railway service (`transcriber`) so transcribing never makes the office lag. It keeps nothing: each clip exists in
memory for the length of one request.

- `POST /transcribe` with the raw clip (`audio/webm` or `audio/mp4`) and header
  `x-transcriber-key: $TRANSCRIBER_KEY` → `{segments:[{start,end,text}], duration, took, model}`
- `GET /health`

Set the same `TRANSCRIBER_KEY` on this service and the app, and `TRANSCRIBER_URL`
on the app. App Sleeping is on: the first clip after a quiet spell waits for it to
wake (model is baked into the image, so seconds, not a download).

## Choosing the model

`WHISPER_MODEL` (build arg and env, default `small`). Measured 2026-10-23 on six
synthetic English accents, on an M-series Mac (Railway's CPUs are several times slower):

| model | speed | errors |
|---|---|---|
| base | 24× real time | 8–12% |
| **small** | 9× | 7–12% |
| large-v3-turbo | 4× | 7–10% |

Most errors were jargon and number formatting; `WHISPER_PROMPT` (a vocabulary
hint) fixes the jargon. Synthetic voices are too clean to separate the models:
recheck with real pilot audio, and move to `large-v3-turbo` if accents suffer.

Deploy: `../deploy.sh transcriber`.
