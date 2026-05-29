# Deploy flows.json + APK auf den Raspberry Pi (Passwort wird abgefragt).
$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$PiHost = "raspberrypi4@raspberrypi"
$RemoteFlows = "~/.node-red/projects/GPS-System/flows.json"
$RemoteApk = "~/.node-red/mobile-releases/mobile-tracking.apk"
$RemoteMqttSetupDir = "~/.node-red/mqtt-websocket"

Push-Location $ProjectRoot
try {
  Write-Host "Sync Maplogik -> flows.json ..."
  npm run sync:map | Out-Host
  npm run mobile:flow | Out-Host

  if (Test-Path "mobile-capacitor\package.json") {
    Push-Location mobile-capacitor
    npm run apk:copy | Out-Host
    Pop-Location
  }

  $flows = Join-Path $ProjectRoot "flows.json"
  $apk = Join-Path $ProjectRoot "mobile-releases\mobile-tracking.apk"
  if (-not (Test-Path $flows)) { throw "flows.json fehlt: $flows" }
  if (-not (Test-Path $apk)) { throw "APK fehlt: $apk" }

  Write-Host "Ordner auf dem Pi anlegen ..."
  ssh $PiHost "mkdir -p ~/.node-red/mobile-releases ~/.node-red/projects/GPS-System ~/.node-red/mqtt-websocket"

  Write-Host "flows.json hochladen ($([math]::Round((Get-Item $flows).Length/1KB)) KB) ..."
  scp $flows "${PiHost}:${RemoteFlows}"

  Write-Host "APK hochladen ($([math]::Round((Get-Item $apk).Length/1MB, 2)) MB) ..."
  scp $apk "${PiHost}:${RemoteApk}"

  Write-Host "MQTT-WebSocket Setup-Dateien hochladen ..."
  scp (Join-Path $ProjectRoot "server\mosquitto-mobile-websocket.conf") "${PiHost}:${RemoteMqttSetupDir}/mosquitto-mobile-websocket.conf"
  scp (Join-Path $ProjectRoot "server\nginx-mqtt-location.conf") "${PiHost}:${RemoteMqttSetupDir}/nginx-mqtt-location.conf"
  scp (Join-Path $ProjectRoot "scripts\pi-setup-mqtt-websocket.sh") "${PiHost}:${RemoteMqttSetupDir}/pi-setup-mqtt-websocket.sh"

  Write-Host ""
  Write-Host "Fertig. Auf dem Pi:"
  Write-Host "  chmod +x ~/.node-red/mqtt-websocket/pi-setup-mqtt-websocket.sh"
  Write-Host "  sudo ~/.node-red/mqtt-websocket/pi-setup-mqtt-websocket.sh --configure-tailscale"
  Write-Host "  sudo systemctl restart nodered"
  Write-Host "Am Handy APK neu installieren:"
  Write-Host "  https://raspberrypi.tail47e91f.ts.net/mobile/"
} finally {
  Pop-Location
}
