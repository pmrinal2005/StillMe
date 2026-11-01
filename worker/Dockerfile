# LiveKit Cloud Build agent image. No LLM / non-AssemblyAI TTS plugins are installed.
FROM python:3.13-slim
ENV PYTHONUNBUFFERED=1
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY revoice_worker ./revoice_worker
USER nobody
CMD ["python", "-m", "revoice_worker.main", "start"]
