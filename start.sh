#!/bin/sh

# Install Tailscale if not present
if ! command -v tailscale > /dev/null 2>&1; then
  echo "Installing Tailscale..."
  curl -fsSL https://tailscale.com/install.sh | sh
fi

echo "Starting tailscaled in userspace networking mode..."
export TS_SOCKET=./tailscaled.sock

tailscaled --tun=userspace-networking --socks5-server=localhost:1055 --socket=$TS_SOCKET --state=./tailscaled.state 2>&1 &

# Wait for socket to appear (up to 30s)
echo "Waiting for tailscaled socket to be ready..."
WAITED=0
while [ ! -S "$TS_SOCKET" ] && [ $WAITED -lt 30 ]; do
  sleep 1
  WAITED=$((WAITED + 1))
done

if [ ! -S "$TS_SOCKET" ]; then
  echo "ERROR: tailscaled socket not found after 30s"
else
  echo "tailscaled socket ready after ${WAITED}s"
fi

if [ -n "$TAILSCALE_AUTHKEY" ]; then
  echo "Authenticating with TAILSCALE_AUTHKEY..."
  tailscale --socket=$TS_SOCKET up \
    --authkey="$TAILSCALE_AUTHKEY" \
    --accept-routes \
    --accept-dns=false \
    --hostname=railway-terminal 2>&1
else
  echo "No TAILSCALE_AUTHKEY set. Use TS Login button to authenticate manually."
fi

echo "--- Tailscale status ---"
tailscale --socket=$TS_SOCKET status 2>&1

echo "Starting Node server..."
exec node server.js

