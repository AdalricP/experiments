#!/usr/bin/env bash
# Run BISCAD on this machine and expose it publicly with a free Cloudflare quick tunnel
# (no account needed). Prints a https://<random>.trycloudflare.com URL anyone can use.
#
#   ./deploy/public.sh            # uses Docker if available, else a local Python venv
#   BISCAD_ADMIN_KEY=bsc_secret ./deploy/public.sh   # also creates an unlimited key for you
set -euo pipefail
cd "$(dirname "$0")/.."
PORT="${PORT:-8000}"

if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  echo "▸ building container…"
  docker build -q -t biscad . >/dev/null
  docker rm -f biscad >/dev/null 2>&1 || true
  docker run -d --name biscad -p "$PORT:8000" -v biscad-data:/data \
    -e BISCAD_ADMIN_KEY="${BISCAD_ADMIN_KEY:-}" biscad >/dev/null
else
  echo "▸ no Docker; using a Python venv (needs Python 3.10–3.12)"
  PY="$(command -v python3.11 || command -v python3.12 || command -v python3.10 || command -v python3)"
  [ -d .venv ] || "$PY" -m venv .venv
  . .venv/bin/activate
  pip install -q -r server/requirements.txt
  mkdir -p data
  (cd server && BISCAD_DATA=../data nohup uvicorn app:app --host 127.0.0.1 --port "$PORT" > ../data/server.log 2>&1 &)
fi

echo -n "▸ waiting for the server"
for _ in $(seq 120); do curl -fs "http://localhost:$PORT/v1/health" >/dev/null && break; echo -n .; sleep 1; done
echo " up at http://localhost:$PORT"

if ! command -v cloudflared >/dev/null 2>&1; then
  echo "▸ installing cloudflared"
  if command -v brew >/dev/null 2>&1; then brew install cloudflared
  else
    OS=$(uname -s | tr A-Z a-z); ARCH=$(uname -m); [ "$ARCH" = x86_64 ] && ARCH=amd64; [ "$ARCH" = aarch64 ] && ARCH=arm64
    curl -fsSL -o /tmp/cloudflared "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-${OS}-${ARCH}"
    chmod +x /tmp/cloudflared; export PATH="/tmp:$PATH"
  fi
fi
echo "▸ opening a public tunnel (Ctrl+C to stop)…"
cloudflared tunnel --no-autoupdate --url "http://localhost:$PORT" 2>&1 | while read -r line; do
  url=$(echo "$line" | grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' || true)
  if [ -n "$url" ]; then
    echo
    echo "  ✓ BISCAD is public:  $url"
    echo "    Studio:  $url/studio.html"
    echo "    MCP:     claude mcp add --transport http biscad $url/mcp"
    echo
  fi
done
