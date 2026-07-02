# GPS Tracking Capacitor App

Die App startet lokal aus den APK-Assets. `Maplogik` bleibt die eine UI-Quelle:

```text
../Maplogik -> scripts/prepare-www.js -> www/index.html -> Android assets
```

Der Server ist nach dem Start optional. Wenn er erreichbar ist, werden MQTT, HTTP-Sync, Live-Status und Uploads ueber die zentrale Server-Basis-URL aktiviert. Wenn er nicht erreichbar ist, bleibt die lokale Karte/GPS/Offline-Cache-Nutzung aktiv.

Die Node-RED-Seite `/mobile/` dient nur zum APK-Download.

## Android per Browser installieren

1. APK in Android Studio bauen: **Build -> Build APK(s)**
2. Am PC:

```powershell
npm run mobile:apk-copy
```

3. `mobile-releases/mobile-tracking.apk` auf den Pi nach `~/.node-red/mobile-releases/mobile-tracking.apk`
4. Node-RED **Deploy**, dann am Handy: `https://raspberrypi.tail47e91f.ts.net/mobile/`

## Entwicklung

```powershell
cd mobile-capacitor
npm install
npm run sync
npm run open:android
```

Nach Aenderungen an `../Maplogik`, `../mobile/capacitor-bridge.js`, `www/`-Assets oder `capacitor.config.json`:

```powershell
npm run sync
```

APK kopieren:

```powershell
npm run apk:copy
```

## Server-Basis-URL

Der lokale APK-Build setzt `window.MOBILE_DEFAULT_SERVER_BASE_URL` auf:

```text
https://raspberrypi.tail47e91f.ts.net
```

Diese URL wird nur fuer optionale Serverfunktionen verwendet. Sie ist keine Start-URL mehr. In der App kann sie weiterhin ueber das Profil/Server-Feld gespeichert werden.

## Hinweis

Tailscale muss nur fuer Serverfunktionen aktiv sein. Offline-Start, lokale GPS-Anzeige und heruntergeladene Kartenbereiche funktionieren ohne Pi/Node-RED/Tailscale.
