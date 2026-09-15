#!/bin/bash
# Take One Studio — start both servers
set -e

ROOT="$(cd "$(dirname "$0")" && pwd)"
VENV="$ROOT/.venv-mac"
FRONTEND="$ROOT/frontend"

# Check env
if ! grep -q "ANTHROPIC_API_KEY=sk-" "$ROOT/.env" 2>/dev/null; then
  echo "⚠️  ANTHROPIC_API_KEY is not set in .env — Claude QC agents will fail."
  echo "   Edit $ROOT/.env and add: ANTHROPIC_API_KEY=sk-ant-..."
  echo ""
fi

# SSL trust: a corporate TLS-inspecting proxy (e.g. SealSuite SWG) re-signs HTTPS with an
# internal CA that lives in the macOS keychain but NOT in Python's certifi bundle → the
# BytePlus SDK (httpx) fails with SSL CERTIFICATE_VERIFY_FAILED ("Connection error.") on
# Seedream/Seedance while curl/browser work. Build a bundle = certifi + macOS trust anchors
# and point Python (+ Node) at it. Rebuilt each start so a rotated corporate CA is picked up.
# No-op off macOS. Guarded (|| true) so a keychain read never aborts start under `set -e`.
if [[ "$OSTYPE" == darwin* ]] && [ -x "$VENV/bin/python" ]; then
  CA_BUNDLE="$VENV/takeone-ca-bundle.pem"
  CERTIFI="$("$VENV/bin/python" -c 'import certifi;print(certifi.where())' 2>/dev/null || true)"
  if [ -n "$CERTIFI" ] && [ -f "$CERTIFI" ]; then
    { cat "$CERTIFI"
      security find-certificate -a -p /Library/Keychains/System.keychain 2>/dev/null
      security find-certificate -a -p /System/Library/Keychains/SystemRootCertificates.keychain 2>/dev/null
    } > "$CA_BUNDLE" || true
    export SSL_CERT_FILE="$CA_BUNDLE"
    export REQUESTS_CA_BUNDLE="$CA_BUNDLE"
    export NODE_EXTRA_CA_CERTS="$CA_BUNDLE"
    echo "▶ SSL: CA bundle = certifi + macOS trust anchors → $CA_BUNDLE"
  fi
fi

echo "▶ Starting FastAPI backend on http://localhost:8000"
"$VENV/bin/uvicorn" server:app --reload --port 8000 --app-dir "$ROOT" &
BACKEND_PID=$!

echo "▶ Starting Next.js frontend on http://localhost:3000"
cd "$FRONTEND" && npm run dev &
FRONTEND_PID=$!

echo ""
echo "  Backend PID : $BACKEND_PID"
echo "  Frontend PID: $FRONTEND_PID"
echo ""
echo "  Dashboard → http://localhost:3000/dashboard"
echo "  API docs  → http://localhost:8000/docs"
echo ""
echo "Press Ctrl+C to stop both servers."

cleanup() {
  echo ""
  echo "Stopping servers…"
  kill "$BACKEND_PID" "$FRONTEND_PID" 2>/dev/null
  exit 0
}
trap cleanup SIGINT SIGTERM

wait
