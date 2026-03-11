#!/bin/sh
set -e

# ─── Install Tailscale if missing ───────────────────────────────────────────
if ! command -v tailscale > /dev/null 2>&1; then
  echo "[start.sh] Installing Tailscale..."
  curl -fsSL https://tailscale.com/install.sh | sh
fi

# ─── Use /tmp for socket + state (always writable, absolute path) ────────────
TS_SOCKET=/tmp/tailscaled.sock
TS_STATE=/tmp/tailscaled.state
export TS_SOCKET

echo "[start.sh] Starting tailscaled (userspace networking, SOCKS5 on :1055)..."
tailscaled \
  --tun=userspace-networking \
  --socks5-server=localhost:1055 \
  --socket="$TS_SOCKET" \
  --state="$TS_STATE" \
  > /tmp/tailscaled.log 2>&1 &

# ─── Wait until socket file appears (up to 20s) ─────────────────────────────
echo "[start.sh] Waiting for tailscaled socket..."
i=0
while [ ! -S "$TS_SOCKET" ]; do
  sleep 1
  i=$((i + 1))
  if [ $i -ge 20 ]; then
    echo "[start.sh] ERROR: tailscaled socket did not appear after 20s"
    echo "[start.sh] tailscaled log:"
    cat /tmp/tailscaled.log || true
    break
  fi
done
echo "[start.sh] tailscaled ready (${i}s)"

# ─── Authenticate ────────────────────────────────────────────────────────────
if [ -n "$TAILSCALE_AUTHKEY" ]; then
  echo "[start.sh] Authenticating with TAILSCALE_AUTHKEY..."
  tailscale \
    --socket="$TS_SOCKET" \
    up \
    --authkey="$TAILSCALE_AUTHKEY" \
    --accept-routes \
    --accept-dns=false \
    --hostname=railway-terminal \
    2>&1 || echo "[start.sh] Note: tailscale up returned non-zero (may already be authenticated)"
else
  echo "[start.sh] No TAILSCALE_AUTHKEY — skipping auto auth (use TS Login button)"
fi

echo "[start.sh] --- Tailscale status ---"
tailscale --socket="$TS_SOCKET" status 2>&1 || true

echo "[start.sh] Starting Node.js..."
exec node server.js
