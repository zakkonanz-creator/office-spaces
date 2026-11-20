#!/bin/sh
# Railway's TCP proxy gives a random public port (RAILWAY_TCP_PROXY_PORT) and
# forwards it to a fixed port inside the container (7881). Browsers dial the
# address LiveKit *advertises*, so LiveKit must advertise the public host:port.
# It listens on the public port number, and socat relays 7881 → that port.
set -e
# Keys: LIVEKIT_API_KEY + LIVEKIT_API_SECRET (what the Railway template sets), or LIVEKIT_KEYS="key: secret".
if [ -z "$LIVEKIT_KEYS" ] && [ -n "$LIVEKIT_API_KEY" ] && [ -n "$LIVEKIT_API_SECRET" ]; then
  LIVEKIT_KEYS="${LIVEKIT_API_KEY}: ${LIVEKIT_API_SECRET}"
fi
: "${LIVEKIT_KEYS:?set LIVEKIT_API_KEY and LIVEKIT_API_SECRET (or LIVEKIT_KEYS='key: secret')}"
EXT_HOST="${RAILWAY_TCP_PROXY_DOMAIN:?no TCP proxy yet — railway tcp-proxy create --port 7881}"
EXT_PORT="${RAILWAY_TCP_PROXY_PORT:?no TCP proxy port}"
NODE_IP="$(dig +short A "$EXT_HOST" | grep -E '^[0-9.]+$' | head -1)"
[ -n "$NODE_IP" ] || { echo "could not resolve $EXT_HOST" >&2; exit 1; }
echo "advertising ICE/TCP at $NODE_IP:$EXT_PORT ($EXT_HOST); signalling on :${PORT:-7880}"

cat > /tmp/livekit.yaml <<YAML
port: ${PORT:-7880}
rtc:
  tcp_port: ${EXT_PORT}
  node_ip: ${NODE_IP}
  use_external_ip: false
  # UDP can't reach a Railway container; keep the range tiny so nothing waits on it.
  port_range_start: 50000
  port_range_end: 50020
room:
  empty_timeout: 300
keys:
  ${LIVEKIT_KEYS}
logging:
  level: info
YAML

# Relay to the container's own interface address, not 127.0.0.1: LiveKit's
# ICE/TCP listener matches a connection to the interface it arrived on, and
# resets anything that comes in over loopback.
SELF_IP="$(ip -4 -o addr show scope global | awk '{print $4}' | cut -d/ -f1 | head -1)"
[ -n "$SELF_IP" ] || { echo "no global IPv4 on this container" >&2; exit 1; }
echo "relaying TCP 7881 -> ${SELF_IP}:${EXT_PORT}"
socat TCP-LISTEN:7881,fork,reuseaddr,nodelay TCP:"${SELF_IP}":"${EXT_PORT}",nodelay &
exec livekit-server --config /tmp/livekit.yaml
