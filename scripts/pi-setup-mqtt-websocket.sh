#!/bin/sh
set -e

WS_PORT="${MQTT_WS_PORT:-9001}"
MOSQUITTO_CONF="/etc/mosquitto/conf.d/mobile-websocket.conf"
SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
SOURCE_CONF="$SCRIPT_DIR/mosquitto-mobile-websocket.conf"

if [ ! -f "$SOURCE_CONF" ]; then
  SOURCE_CONF="$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)/server/mosquitto-mobile-websocket.conf"
fi

if [ ! -f "$SOURCE_CONF" ]; then
  echo "FEHLT: mosquitto-mobile-websocket.conf"
  exit 1
fi

if ! command -v mosquitto >/dev/null 2>&1; then
  echo "Mosquitto ist nicht installiert."
  echo "Installieren: sudo apt-get update && sudo apt-get install -y mosquitto"
  exit 1
fi

echo "Installiere Mosquitto WebSocket Listener auf 127.0.0.1:$WS_PORT ..."
tmp_conf="$(mktemp)"
sed "s/listener 9001 127.0.0.1/listener $WS_PORT 127.0.0.1/" "$SOURCE_CONF" > "$tmp_conf"
sudo install -m 0644 "$tmp_conf" "$MOSQUITTO_CONF"
rm -f "$tmp_conf"

echo "Starte Mosquitto neu ..."
sudo systemctl restart mosquitto
sudo systemctl --no-pager --full status mosquitto | sed -n '1,8p'

echo ""
echo "Pruefe lokale Listener:"
if command -v ss >/dev/null 2>&1; then
  ss -ltn | grep -E "(:1883|:$WS_PORT)" || true
fi

echo ""
echo "Mosquitto WebSocket ist lokal auf http://127.0.0.1:$WS_PORT bereit."
echo "Die Mobile WebView erwartet denselben HTTPS-Origin unter /mqtt."

if [ "${1:-}" = "--configure-tailscale" ]; then
  if ! command -v tailscale >/dev/null 2>&1; then
    echo "tailscale CLI nicht gefunden; /mqtt muss im vorhandenen Reverse Proxy gesetzt werden."
    exit 0
  fi
  echo "Setze Tailscale Serve Pfad /mqtt -> http://127.0.0.1:$WS_PORT ..."
  sudo tailscale serve --bg --https=443 --set-path /mqtt "http://127.0.0.1:$WS_PORT"
  sudo tailscale serve status
else
  echo ""
  echo "Falls Tailscale Serve das HTTPS fuer die App bereitstellt:"
  echo "  sudo tailscale serve --bg --https=443 --set-path /mqtt http://127.0.0.1:$WS_PORT"
  echo ""
  echo "Falls nginx/Caddy genutzt wird, /mqtt als WebSocket-Reverse-Proxy auf 127.0.0.1:$WS_PORT legen."
  echo "nginx-Beispiel liegt im Repo unter server/nginx-mqtt-location.conf."
fi

