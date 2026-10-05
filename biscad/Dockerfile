FROM python:3.11-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
        libgl1 libglib2.0-0 libgomp1 libfontconfig1 libxrender1 fonts-dejavu-core curl \
    && rm -rf /var/lib/apt/lists/*

RUN useradd -m -u 1000 biscad
WORKDIR /app
COPY server/requirements.txt server/requirements.txt
RUN pip install --no-cache-dir -r server/requirements.txt
COPY server server
COPY web web
RUN mkdir -p /data && chown -R biscad /data
USER biscad

ENV BISCAD_DATA=/data PORT=8000 PYTHONUNBUFFERED=1
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s CMD curl -fs http://localhost:${PORT}/v1/health || exit 1
WORKDIR /app/server
CMD ["sh", "-c", "uvicorn app:app --host 0.0.0.0 --port ${PORT} --proxy-headers --forwarded-allow-ips='*'"]
