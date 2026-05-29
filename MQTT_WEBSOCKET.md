# Mobile MQTT over WebSocket

The mobile WebView publishes tracking points with MQTT over WebSocket at:

```text
wss://<app-host>/mqtt
```

The existing MQTT TCP listener on `1883` stays unchanged for Node-RED, OwnTracks, and the native Android service.

## Mosquitto

Install the WebSocket listener:

```sh
sudo cp server/mosquitto-mobile-websocket.conf /etc/mosquitto/conf.d/mobile-websocket.conf
sudo systemctl restart mosquitto
```

This adds:

```text
listener 9001 127.0.0.1
protocol websockets
```

## HTTPS `/mqtt`

The WebView is loaded from HTTPS, so it must connect to `wss://.../mqtt`.
Expose the local Mosquitto WebSocket listener through the same HTTPS origin.

With Tailscale Serve:

```sh
sudo tailscale serve --bg --https=443 --set-path /mqtt http://127.0.0.1:9001
```

With nginx, include `server/nginx-mqtt-location.conf` in the existing HTTPS server block.

## App Overrides

Defaults:

```text
WebView MQTT WS URL: wss://<current-host>/mqtt
Native MQTT TCP host: <current-hostname>
Native MQTT TCP port: 1883
```

Optional runtime overrides:

```js
window.MOBILE_MQTT_WS_URL = 'wss://example.ts.net/mqtt';
window.MOBILE_MQTT_TCP_HOST = 'example.ts.net';
window.MOBILE_MQTT_TCP_PORT = 1883;
```

LocalStorage overrides are still supported:

```js
localStorage.setItem('gpsTrackingMqttUrl', 'wss://example.ts.net/mqtt');
localStorage.setItem('gpsTrackingMqttHost', 'example.ts.net');
localStorage.setItem('gpsTrackingMqttPort', '1883');
```

