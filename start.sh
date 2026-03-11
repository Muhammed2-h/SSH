#!/bin/sh

# Install Tailscale if not present
if ! command -v tailscale > /dev/null 2>&1; then
  curl -fsSL https://tailscale.com/install.sh | sh
fi

# Bring up Tailscale in userspace networking mode (no root/TUN required)
if [ -n "$TAILSCALE_AUTHKEY" ]; then
  tailscaled --tun=userspace-networking --socks5-server=localhost:1055 &
  sleep 3
  tailscale up --authkey="$TAILSCALE_AUTHKEY" --accept-routes --hostname=railway-terminal
  echo "Tailscale is up"
else
  echo "No TAILSCALE_AUTHKEY set, skipping Tailscale"
fi

# Start the Node app
node server.js
