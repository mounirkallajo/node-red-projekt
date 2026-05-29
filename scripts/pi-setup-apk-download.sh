#!/bin/sh
set -e
APK_DIR="$HOME/.node-red/mobile-releases"
APK_FILE="$APK_DIR/mobile-tracking.apk"
LINK_FILE="$APK_DIR/app.apk"

mkdir -p "$APK_DIR"
if [ ! -f "$APK_FILE" ]; then
  echo "FEHLT: $APK_FILE"
  echo "Zuerst APK vom PC kopieren."
  exit 1
fi

ln -sf "$APK_FILE" "$LINK_FILE"
echo "OK: $LINK_FILE -> mobile-tracking.apk"
echo ""
echo "In ~/.node-red/settings.js eintragen (module.exports = { ... }):"
echo ""
echo "    httpStatic: ["
echo "        { path: '$APK_DIR', root: '/mobile/download' }"
echo "    ],"
echo ""
echo "Danach: sudo systemctl restart nodered"
echo "Test:   curl -o /tmp/test.apk http://127.0.0.1:1880/mobile/download/app.apk && ls -lh /tmp/test.apk"
