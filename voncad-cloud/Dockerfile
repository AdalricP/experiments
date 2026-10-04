# Voncad Cloud: API + MCP + web in one container.
#   docker build -t voncad-cloud . && docker run -p 8000:8000 voncad-cloud
FROM python:3.11-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
        libgl1 libglib2.0-0 libgomp1 libfontconfig1 libxrender1 fonts-dejavu-core curl \
    && rm -rf /var/lib/apt/lists/*

# non-root user (Hugging Face Spaces runs as uid 1000)
RUN useradd -m -u 1000 voncad
WORKDIR /app
COPY server/requirements.txt server/requirements.txt
RUN pip install --no-cache-dir -r server/requirements.txt
COPY server server
COPY web web
# server code stays root-owned (read-only to the runtime user); only /data is writable
RUN mkdir -p /data && chown -R voncad /data
USER voncad

ENV VONCAD_DATA=/data PORT=8000 PYTHONUNBUFFERED=1
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s CMD curl -fs http://localhost:${PORT}/v1/health || exit 1
WORKDIR /app/server
CMD ["sh", "-c", "uvicorn app:app --host 0.0.0.0 --port ${PORT} --proxy-headers --forwarded-allow-ips='*'"]
