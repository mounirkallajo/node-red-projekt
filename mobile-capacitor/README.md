# GPS Tracking Capacitor App

Die App ist ein **nativer WebView-Wrapper** um die bestehende Web-Karte. Beim Start lädt sie direkt (ohne Browser-Umweg):

```text
https://raspberrypi.tail47e91f.ts.net/map
```

Die Oberfläche ist **1:1 identisch** mit `/map` im Browser — sie läuft aber **innerhalb der App** (eigenes Icon, kein Chrome-Tab).

Server-URL steht in `capacitor.config.json` unter `server.url`. Nach Änderung: `npm run sync`, neu bauen, APK kopieren.

Die Node-RED-Seite `/mobile/` dient nur zum APK-Download.

## Android per Browser installieren

1. APK in Android Studio bauen: **Build → Build APK(s)**
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

Nach Änderungen an `www/` oder `capacitor.config.json`:

```powershell
npm run sync
```

APK kopieren:

```powershell
npm run apk:copy
```

## Server-URL

Standard: `https://raspberrypi.tail47e91f.ts.net` (in `www/bootstrap.js`).

Andere URL: in `capacitor.config.json` / `bootstrap.js` anpassen, neu bauen, oder später per Capacitor Preferences (`gpsTrackingServerBase`).

## Hinweis

Tailscale muss auf dem Handy aktiv sein, sonst erreicht die App den Pi nicht. Updates an der Karte wirken sofort in Browser **und** App — es gibt keine separate App-Oberfläche mehr.
