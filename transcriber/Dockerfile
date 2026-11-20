FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
ARG WHISPER_MODEL=small
ENV WHISPER_MODEL=${WHISPER_MODEL} WHISPER_MODELS=/models HF_HUB_DISABLE_TELEMETRY=1
# Bake the model into the image: a sleeping service wakes in seconds, not a download.
RUN python -c "from faster_whisper import WhisperModel; WhisperModel('${WHISPER_MODEL}', device='cpu', compute_type='int8', download_root='/models')"
COPY app.py .
CMD ["sh", "-c", "uvicorn app:app --host 0.0.0.0 --port ${PORT:-8080}"]
