#!/bin/sh

# Install Tailscale if not present
if ! command -v tailscale > /dev/null 2>&1; then
  echo "Installing Tailscale..."
  curl -fsSL https://tailscale.com/install.sh | sh
fi

# Bring up Tailscale in userspace networking mode (no root/TUN required)
if [ -n "$TAILSCALE_AUTHKEY" ]; then
  echo "Starting tailscaled proxy on port 1055..."
  # Use explicit paths for socket and state to avoid permission issues
  export TS_SOCKET=./tailscaled.sock
  
  tailscaled --tun=userspace-networking --socks5-server=localhost:1055 --socket=$TS_SOCKET --state=./tailscaled.state &
  
  echo "Waiting for tailscaled to start..."
  sleep 5
  
  echo "Authenticating Tailscale node..."
  tailscale --socket=$TS_SOCKET up --authkey="$TAILSCALE_AUTHKEY" --accept-routes --hostname=railway-terminal
  
  echo "Tailscale status:"
  tailscale --socket=$TS_SOCKET status
else
  echo "No TAILSCALE_AUTHKEY set, skipping Tailscale"
fi

echo "Starting Node server..."
node server.js
