# InfluxDB 2.x (lokal auf dem Raspberry)

Node-RED liest diese **Umgebungsvariablen** (z. B. in der `systemd`-Unit von Node-RED oder in `settings.js` über `process.env` / `environment`).

| Variable | Pflicht | Bedeutung |
|----------|---------|-----------|
| `INFLUX_URL` | ja (wenn aktiv) | Basis-URL, z. B. `http://127.0.0.1:8086` (ohne abschließendes `/`) |
| `INFLUX_ORG` | ja | Organisationsname (wie in der Influx-UI) |
| `INFLUX_BUCKET` | ja | Bucket-Name, z. B. `tracking` |
| `INFLUX_TOKEN` | ja | API-Token mit **Read**, **Write** und **Delete** für dieses Bucket |
| `INFLUX_ENABLED` | nein | `false` oder `0` schaltet alle Influx-Aufrufe aus (nur RAM wie bisher) |

## Token und URL auf dem Raspberry Pi (Node-RED)

Den **API-Token nicht** in `flows.json` speichern. Stattdessen **Umgebungsvariablen** für den Node-RED-Prozess setzen (typisch **systemd**).

**Empfohlen:** Datei nur für root lesbar, vom Dienst eingebunden:

1. `sudo nano /etc/default/nodered-influx` mit z. B.:

   ```
   INFLUX_URL=http://127.0.0.1:8086
   INFLUX_ORG=GPS-System
   INFLUX_BUCKET=tracking
   INFLUX_TOKEN=<hier den Token einfügen>
   ```

2. `sudo chmod 600 /etc/default/nodered-influx`

3. `sudo systemctl edit nodered` — unter `[Service]`:

   ```
   EnvironmentFile=/etc/default/nodered-influx
   ```

4. `sudo systemctl daemon-reload` und `sudo systemctl restart nodered`

Dienstname ggf. anpassen (`systemctl status nodered`). Danach in Node-RED **Deploy**.

## Einmalig auf dem Pi

1. InfluxDB **2.x OSS** installieren und im Browser unter `http://127.0.0.1:8086` einrichten.
2. Bucket anlegen (z. B. `tracking`) und **Retention** setzen (SD-Karte).
3. Token erzeugen mit Zugriff auf Org und Bucket (inkl. Delete für Reset/Löschen).
4. Influx nur an `localhost` binden; von außen weiter über Node-RED/Tailscale.

### Tarball auf Raspberry Pi (`aarch64`), wenn `apt install influxdb2` fehlschlägt

Offizielle Archive liegen unter **`.../influxdb/releases/`** (ohne Unterordner `v2.x.x/` im Pfad). Mit **`curl -fL`** bricht der Download bei 404 ab, statt eine kleine HTML-Fehlerseite als `.tar.gz` zu speichern.

```bash
cd ~
curl -fL -O "https://download.influxdata.com/influxdb/releases/influxdb2-2.9.1_linux_arm64.tar.gz"
ls -lh influxdb2-2.9.1_linux_arm64.tar.gz
```

Die Datei sollte **deutlich größer als einige KB** sein. Dann:

```bash
tar xvfz influxdb2-2.9.1_linux_arm64.tar.gz
sudo cp influxdb2-2.9.1/influxd /usr/local/bin/
sudo chmod +x /usr/local/bin/influxd
sudo mkdir -p /var/lib/influxdb2 /etc/influxdb2
sudo influxd --bolt-path=/var/lib/influxdb2/influxd.bolt --engine-path=/var/lib/influxdb2/engine --http-bind-address=:8086
```

Bei manchen älteren Paketen lag die Binary unter `influxdb2-…/usr/bin/influxd` — bei **2.9.1 linux_arm64** ist sie **`influxdb2-2.9.1/influxd`** (wie nach `tar` in der Liste).

Neuere Version: Link „Linux arm64“ unter [InfluxData Downloads](https://www.influxdata.com/downloads/) für **InfluxDB v2** verwenden und **Verzeichnisname** (`influxdb2-2.9.1`) an die entpackte Version anpassen.

**Fehler „gzip: stdin: not in gzip format“:** meist falsche URL oder Download abgebrochen — `ls -lh` prüfen, mit `-fL` erneut laden.

## Datenmodell

- Measurement: `gps_point`
- Tag: `device_id` (Wert = `user/device` aus Owntracks, bzw. `__default__` für Geräte ohne expliziten Schlüssel)
- Fields: `lat`, `lon`, optional `accuracy`, `speed`, `heading`, `battery`

- Measurement: `saved_place` (gespeicherte Orte)
- Tags: `device_id` (wie bei GPS, z. B. `__default__` oder `user/device`), `place_id` (interne ID)
- Fields: `name`, `lat`, `lon`, `color` (Strings bzw. Zahlen wie in der App)

- Measurement: `saved_route` (gespeicherte Routen)
- Tags: `device_id`, `route_id`
- Fields: `name`, `color`, `point_count` (Integer), `points_json` (JSON-Array der Streckenpunkte als String)

- Measurement: `device_registry` (bekannte Geräte, Heartbeat bei gültigem GPS)
- Tag: `device_id` (wie bei GPS)
- Field: `last_seen_ms` (Integer, Unix-Zeit in ms beim Schreiben)

`GET /api/places` und `GET /api/routes` lesen bei aktivem Influx per Flux und **mergen** mit den RAM-Daten (gleiche `id`: Influx gewinnt). **`DELETE /api/places`** und **`DELETE /api/routes`** führen vor dem Filtern denselben Merge aus, damit nach einem Neustart (leere Globals) manuelles Löschen weiter funktioniert, wenn die Daten nur in Influx liegen. Schreiben erfolgt zusätzlich zu den bisherigen Globals. **`DELETE /api/devices/...`** entfernt zugehörige Daten in Influx inkl. **`gps_point`**, **`saved_place`**, **`saved_route`** und **`device_registry`** für dieses `device_id`. **`POST /api/reset` (Tracking-Reset)** löscht nur **`gps_point`**, nicht **`saved_place`** / **`saved_route`**.

Die Influx-Query-API liefert **CSV**; Felder wie `points_json` enthalten viele Kommas. Der Parser im Flow (`splitCsvLine`) muss **gequotete CSV-Zellen** korrekt auswerten (siehe `scripts/apply-influx-splitCsvLine-rfc4180.cjs`). Zusätzlich werden mehrere Flux-Zeilen pro Route zu einer Route mit maximaler Punktanzahl zusammengeführt (`dedupeInfluxSavedRoutesFromRows` in `listSavedRoutes` / vor Delete-Merge).

Skript für diese Erweiterung: [scripts/patch-saved-places-routes-influx.cjs](scripts/patch-saved-places-routes-influx.cjs) (idempotent erneut ausführbar).

**Route speichern:** `POST /api/routes` akzeptiert optional **`points`** (Array mit `lat`/`lon`, mindestens zwei gültige Punkte). Die Karte sendet die Punkte aus der zuvor geladenen Historie mit, damit das Speichern funktioniert, wenn die Historie nur in Influx liegt und die RAM-`historyByDevice`-Listen leer sind (sonst Fallback wie bisher).

**Tracking / MQTT:** In der **Tracking-Logik** bleibt `devices[key].receivedAt` bei **ohne gültigen GPS-Fix** (`!gpsFixOk`) auf der zuletzt gültigen Zeit stehen (vorheriger Eintrag / lastGood / sonst `timestamp` oder 0). Nur bei **gültigem Fix** trägt der neue Payload die aktuelle Empfangszeit. In der **Maplogik** wertet der Verbindungs-Chip für **Verbunden/Offline** nur noch **`receivedAt`** (kein Fallback auf `timestamp`), damit eine reine GPS-Uhrzeit ohne Server-Empfang nie als „live“ gilt. `loadTracking` leert die Verbindungs-Hysterese zu Beginn jedes Reloads.

**Geräteliste (`GET /api/devices`):** Ohne Influx weiter wie früher (nur RAM, gefiltert mit `__trackingSessionEpoch`). **Mit Influx** kommen alle **`device_id` aus `device_registry`** in die Antwort; Positionen aus **`gps_point`** und RAM, sonst Platzhalter (`lat`/`lon` `null`). **`__trackingSessionEpoch`**: wird beim Start der **Tracking-Logik** gesetzt und — falls noch leer — **synchron beim ersten `GET /api/devices`** (`bootstrapEpoch`), damit der **Clamp** (`receivedAt` auf **0**, wenn älter als die Epoche) direkt nach Deploy greift, auch ohne MQTT. **`GET /api/last-position`** (Function **`lastPosition`**) wendet dieselbe Epoche + Clamp an, damit die Karte beim Laden nicht über alte RAM-Werte „Verbunden“ umgeht. **`mapInfluxRowToPoint`**: kein `Date.now()`-Fallback für `receivedAt`/`timestamp`. **`DELETE /api/devices/...`** entfernt Registry, Influx-Messungen und Globals inkl. **`recentSpeedsByKey`** für dieses Gerät.

**Schreiben Orte/Routen:** Zusätzlicher HTTP-Request-Node **„Influx write line protocol“** auf dem Tab **API** (gleiches Verhalten wie „Influx write gps_point“ auf **Tracking**), damit die Speichern-Flows nicht über Tab-Grenzen mit dem Schreib-Node verdrahtet werden müssen (robuster nach Import/Deploy).

Die Änderungen an `flows.json` und `Tracking-logik` sind in [scripts/patch-influx-flow.cjs](scripts/patch-influx-flow.cjs) nachvollziehbar; ein erneuter Lauf schlägt fehl, wenn die Influx-Hilfsfunktionen bereits eingefügt sind.

**Function-Nodes und HTTP:** `httpPostJson` nutzt **`fetch`**, falls vorhanden. Sonst laden die vier Influx-API-Function-Nodes **`http` / `https` als eingebaute Module** (`libs` im Flow → Variablen **`nodeHttp`** / **`nodeHttps`**). Das funktioniert **ohne** `functionGlobalContext`. Zusätzlich bleiben `global.get("influxHttp")` / `http` und `require` als Fallback.

In `settings.js` darf **`functionExternalModules`** nicht auf **`false`** stehen, wenn die Nodes `libs` nutzen (Node-RED-Standard ist meist erlaubt).

Optional weiterhin **`functionGlobalContext`** (z. B. gleicher Pi) — dann reicht einer der Blöcke unten zusätzlich.

In `settings.js` des **Node-RED-Benutzers** (z. B. `/home/raspberrypi4/.node-red/settings.js`; bei anderem Dienst-User `systemctl show nodered -p User`) unter `module.exports = { ... }`:

**Empfohlen (eindeutige Schlüssel):**

```javascript
functionGlobalContext: {
    influxHttp: require("http"),
    influxHttps: require("https")
},
```

**Alternativ** (wenn du schon `http`/`https` nutzt — wird ebenfalls unterstützt):

```javascript
functionGlobalContext: {
    http: require("http"),
    https: require("https")
},
```

**Variante mit nur `require`:**

```javascript
functionGlobalContext: {
    require: require
},
```

Node-RED-Dienst **neu starten**, danach aktuelle `flows.json` **Deploy**.

**Prüfen auf dem Pi** (im Verzeichnis `~/.node-red`), ob Node die Einträge wirklich lädt:

```bash
cd ~/.node-red && node -e "const s=require('./settings.js'); console.log(s.functionGlobalContext && Object.keys(s.functionGlobalContext));"
```

Wenn hier ein Fehler kommt oder `undefined` erscheint, ist `settings.js` syntaktisch falsch oder `functionGlobalContext` steht nicht in `module.exports`.

Skripte: [scripts/fix-influx-http-hybrid.cjs](scripts/fix-influx-http-hybrid.cjs) (aktueller Stand: `fetch` + http-Fallback), älter [scripts/fix-influx-fetch.cjs](scripts/fix-influx-fetch.cjs) (nur `fetch`).
