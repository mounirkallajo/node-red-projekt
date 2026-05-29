# Android APK für Browser-Installation

Node-RED liefert die Datei `mobile-tracking.apk` unter:

```text
/mobile/download/app.apk
```

## APK erstellen und bereitstellen

1. In Android Studio die App bauen: **Build → Build APK(s)**
2. Am PC kopieren:

```powershell
node scripts/copy-android-apk.js
```

3. Auf den Raspberry Pi kopieren:

```text
mobile-releases/mobile-tracking.apk
→ ~/.node-red/mobile-releases/mobile-tracking.apk
```

Alternativ im Node-RED-Flow `global.mobileApkPath` auf einen eigenen Pfad setzen.

4. Node-RED **Deploy**, dann im Handy-Browser öffnen:

```text
https://raspberrypi.tail47e91f.ts.net/mobile/
```
