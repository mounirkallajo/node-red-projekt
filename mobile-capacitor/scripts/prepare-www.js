const fs = require('fs');
const path = require('path');

const appRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(appRoot, '..');
const wwwDir = path.join(appRoot, 'www');
const maplogikFile = path.join(repoRoot, 'Maplogik');
const bridgeFile = path.join(repoRoot, 'mobile', 'capacitor-bridge.js');
const cameraPanelFile = path.join(repoRoot, 'camera-panel.js');
const mqttFile = path.join(repoRoot, 'node_modules', 'mqtt', 'dist', 'mqtt.min.js');
const defaultServerBaseUrl = 'https://raspberrypi.tail47e91f.ts.net';

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function copyFile(source, target) {
  if (!fs.existsSync(source)) {
    throw new Error('Required mobile asset missing: ' + source);
  }
  ensureDir(path.dirname(target));
  fs.copyFileSync(source, target);
}

function optionalCopyFile(source, target) {
  if (!fs.existsSync(source)) return false;
  copyFile(source, target);
  return true;
}

function readCameraPanelBrowserScript() {
  if (!fs.existsSync(cameraPanelFile)) {
    throw new Error('Required mobile asset missing: ' + cameraPanelFile);
  }
  const source = fs.readFileSync(cameraPanelFile, 'utf8');
  const payloadMatch = source.match(/msg\.payload\s*=\s*`([\s\S]*)`;\s*return\s+msg;?\s*$/);
  if (!payloadMatch) {
    return source;
  }
  return payloadMatch[1];
}

function packageRoot(packageName) {
  const packageJson = require.resolve(path.join(packageName, 'package.json'), { paths: [appRoot] });
  return path.dirname(packageJson);
}

function copyMapLibreAssets() {
  const mapLibreDist = path.join(packageRoot('maplibre-gl'), 'dist');
  const targetDir = path.join(wwwDir, 'assets', 'maplibre');
  ensureDir(targetDir);
  copyFile(path.join(mapLibreDist, 'maplibre-gl.css'), path.join(targetDir, 'maplibre-gl.css'));
  copyFile(path.join(mapLibreDist, 'maplibre-gl.js'), path.join(targetDir, 'maplibre-gl.js'));

  let rtlPluginPath = '';
  try {
    rtlPluginPath = path.join(packageRoot('@mapbox/mapbox-gl-rtl-text'), 'dist', 'mapbox-gl-rtl-text.js');
  } catch (error) {
    rtlPluginPath = '';
  }
  return optionalCopyFile(rtlPluginPath, path.join(targetDir, 'mapbox-gl-rtl-text.js'));
}

function buildLocalMaplogikHtml(hasRtlPlugin) {
  let html = fs.readFileSync(maplogikFile, 'utf8');
  html = html
    .replace('https://unpkg.com/maplibre-gl@5.14.0/dist/maplibre-gl.css', 'assets/maplibre/maplibre-gl.css')
    .replace('https://unpkg.com/maplibre-gl@5.14.0/dist/maplibre-gl.js', 'assets/maplibre/maplibre-gl.js')
    .replace('/mobile/capacitor-bridge.js', 'mobile/capacitor-bridge.js')
    .replace('/api/camera-panel.js', 'api/camera-panel.js')
    .replace(
      "const MAPLIBRE_RTL_TEXT_PLUGIN_URL = 'https://unpkg.com/@mapbox/mapbox-gl-rtl-text@0.3.0/dist/mapbox-gl-rtl-text.js';",
      "const MAPLIBRE_RTL_TEXT_PLUGIN_URL = '" + (hasRtlPlugin ? 'assets/maplibre/mapbox-gl-rtl-text.js' : '') + "';"
    );

  const mobileConfigScript = [
    '<script>',
    'window.MOBILE_LOCAL_ASSETS = true;',
    'window.__mobileServerAvailable = false;',
    "window.MOBILE_DEFAULT_SERVER_BASE_URL = '" + defaultServerBaseUrl + "';",
    "console.info('MobileStartup local assets loaded');",
    '</script>'
  ].join('');

  return html.replace('<script src="mobile/capacitor-bridge.js"></script>', mobileConfigScript + '\n  <script src="mobile/capacitor-bridge.js"></script>');
}

ensureDir(wwwDir);
const hasRtlPlugin = copyMapLibreAssets();
copyFile(bridgeFile, path.join(wwwDir, 'mobile', 'capacitor-bridge.js'));
ensureDir(path.join(wwwDir, 'api'));
fs.writeFileSync(path.join(wwwDir, 'api', 'camera-panel.js'), readCameraPanelBrowserScript(), 'utf8');
copyFile(mqttFile, path.join(wwwDir, 'mobile', 'mqtt.min.js'));
fs.writeFileSync(path.join(wwwDir, 'index.html'), buildLocalMaplogikHtml(hasRtlPlugin), 'utf8');

console.log('Capacitor www ready (local-first Maplogik assets).');
