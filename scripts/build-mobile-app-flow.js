const fs = require('fs');
const path = require('path');

const flowFile = path.join(__dirname, '..', 'flows.json');
const bridgeJsFile = path.join(__dirname, '..', 'mobile', 'capacitor-bridge.js');
const bridgeJs = fs.readFileSync(bridgeJsFile, 'utf8');
const mqttJsFile = path.join(__dirname, '..', 'node_modules', 'mqtt', 'dist', 'mqtt.min.js');
const mqttJs = fs.existsSync(mqttJsFile) ? fs.readFileSync(mqttJsFile, 'utf8') : '';
const flow = JSON.parse(fs.readFileSync(flowFile, 'utf8'));
const tabId = 'mobile_app_tab_20260521';
const wsConfig = flow.find((n) => n && n.type === 'websocket-listener' && n.path === '/ws/live-tracking');
const wsConfigId = wsConfig ? wsConfig.id : 'mobile_app_ws_listener_20260521';
const mqttBroker = flow.find((n) => n && n.type === 'mqtt-broker' && (n.name === 'Geoinfos' || n.broker === 'localhost'));
const mqttBrokerId = mqttBroker ? mqttBroker.id : 'b52642ed9b384c87';

const installHtml = `<!doctype html>
<html lang="de">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Mobile App installieren</title>
  <style>
    html,body{margin:0;min-height:100%;font-family:Arial,sans-serif;background:#101820;color:#eef6ff}
    main{max-width:720px;margin:0 auto;padding:20px 16px 32px}
    .card{background:#fff;color:#101820;border-radius:12px;padding:18px;box-shadow:0 18px 50px rgba(0,0,0,.28);margin-bottom:14px}
    h1{margin:0 0 8px;font-size:26px}h2{margin:0 0 8px;font-size:18px}
    .muted{color:#526371;line-height:1.5;margin:0 0 12px}
    code{background:#eef3f7;border-radius:6px;padding:2px 5px;font-size:13px}
    .btn{display:inline-block;margin-top:8px;margin-right:8px;background:#00a3ff;color:#fff;text-decoration:none;font-weight:700;border-radius:10px;padding:12px 16px;border:0;font-size:16px}
    .btn.secondary{background:#dfe8ef;color:#173247}
    .btn[disabled]{opacity:.45;pointer-events:none}
    ol{padding-left:20px;line-height:1.55;margin:8px 0 0}
    .status{margin-top:10px;padding:10px 12px;border-radius:8px;background:#eef8ff;color:#12466b;font-size:14px}
    .status.warn{background:#fff4df;color:#7a4d00}
    .hidden{display:none}
  </style>
</head>
<body>
  <main>
    <div class="card">
      <h1>GPS Tracking App</h1>
      <p class="muted">Installiere die Android-App — sie öffnet dieselbe Web-Karte wie im Browser (<code>/map</code>). Profil und GPS-Einstellungen nur in der App.</p>
      <a id="installBtn" class="btn" href="/mobile/download/app.apk">Android App installieren</a>
      <a class="btn secondary" href="/map">Zur Web-Karte</a>
      <div id="apkStatus" class="status warn hidden">APK noch nicht auf dem Server. Bitte zuerst in Android Studio bauen und auf den Pi kopieren.</div>
    </div>
    <div class="card">
      <h2>Installation auf Android</h2>
      <ol>
        <li>Button <strong>Android App installieren</strong> tippen.</li>
        <li>Download bestätigen (<code>Mobile-Tracking.apk</code>).</li>
        <li>APK öffnen. Falls nötig: <strong>Unbekannte Apps installieren</strong> für den Browser erlauben.</li>
        <li>App starten — dieselbe Karte wie <code>/map</code>. Profil-Button oben rechts (nur in der App).</li>
        <li>Server/Tailscale: <code>https://raspberrypi.tail47e91f.ts.net</code></li>
      </ol>
    </div>
    <div class="card">
      <h2>Server</h2>
      <p class="muted">Tracking: MQTT <code>mobile_app/&lt;user&gt;/&lt;device&gt;</code> · Tailscale muss auf dem Handy aktiv sein.</p>
    </div>
  </main>
  <script>
    fetch('/mobile/api/apk-info', { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (payload) {
        var data = payload && payload.data ? payload.data : {};
        var btn = document.getElementById('installBtn');
        var status = document.getElementById('apkStatus');
        if (data.available) {
          btn.classList.remove('hidden');
          if (data.sizeBytes) {
            status.classList.remove('hidden', 'warn');
            status.textContent = 'APK bereit (' + Math.round(data.sizeBytes / 1048576) + ' MB).';
          }
        } else {
          status.classList.remove('hidden');
        }
      })
      .catch(function () {
        document.getElementById('apkStatus').classList.remove('hidden');
      });
  </script>
</body>
</html>`;

const apkStatCommand = 'APK="$HOME/.node-red/mobile-releases/mobile-tracking.apk"; if [ -f "$APK" ]; then stat -c \'%s %Y\' "$APK"; else echo MISSING; fi';

const apkInfoParseFunction = String.raw`const out=String(msg.payload||'').trim();
msg.headers={'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'};
if(!out||out==='MISSING'){
  msg.payload={ok:true,data:{available:false}};
  return msg;
}
const parts=out.split(/\s+/);
msg.payload={ok:true,data:{available:true,fileName:'Mobile-Tracking.apk',sizeBytes:Number(parts[0])||0,updatedAt:(Number(parts[1])||0)*1000}};
return msg;`;

const pointFunction = String.raw`msg.statusCode=410;
msg.headers={'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'};
msg.payload={ok:false,message:'Tracking-Punkte werden per MQTT auf mobile_app/<user>/<device> verarbeitet. /mobile/api/points ist nur noch ein Kompatibilitaets-Shim.'};
return msg;`;

const bootstrapFunction = String.raw`const q=(msg.req&&msg.req.query)||{};
const key=String(q.deviceKey||'').trim();
const devices=global.get('devices')||{}, lastByDevice=global.get('lastPositionByDevice')||{}, tracking=global.get('trackingStateByDevice')||{}, routes=global.get('savedRoutesByDevice')||{};
msg.headers={'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'};
msg.payload={ok:true,data:{serverTime:Date.now(),deviceKey:key||null,lastPosition:key?(devices[key]||lastByDevice[key]||null):(global.get('lastPosition')||null),tracking:key?(tracking[key]||null):null,savedRoutes:key?(routes[key]||[]):[]}};
return msg;`;

const regionsGetFunction = String.raw`msg.headers={'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'};
msg.payload={ok:true,data:global.get('mobileOfflineRegions')||{}};
return msg;`;

const regionsPostFunction = String.raw`const body=(msg.req&&msg.req.body&&typeof msg.req.body==='object')?msg.req.body:(msg.payload||{});
const key=String(body.deviceKey||'mobile/webapp').trim();
const store=global.get('mobileOfflineRegions')||{}, list=Array.isArray(store[key])?store[key]:[];
list.push({createdAt:Date.now(),tileCount:Number(body.tileCount)||0,zoomMin:Number(body.zoomMin)||null,zoomMax:Number(body.zoomMax)||null,bounds:body.bounds||null});
store[key]=list.slice(-20); global.set('mobileOfflineRegions',store);
msg.headers={'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'};
msg.payload={ok:true,data:{deviceKey:key,regions:store[key]}};
return msg;`;

const locationRequestFunction = String.raw`const body=(msg.req&&msg.req.body&&typeof msg.req.body==='object')?msg.req.body:(msg.payload||{});
const key=String(body.deviceKey||'').trim();
function topicPart(value,fallback){
  const cleaned=String(value||'').trim().toLowerCase().replace(/\s+/g,'-').replace(/[^a-z0-9._-]/g,'').replace(/^-+|-+$/g,'');
  return cleaned||fallback;
}
msg.headers={'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'};
if(!key){
  msg.statusCode=400;
  msg.payload={ok:false,message:'deviceKey fehlt'};
  return [msg,null,null];
}
const rawAction=String(body.action||'').trim();
const TRACKING_ACTIONS={tracking_start:1,tracking_stop:1,tracking_reset:1};
let action;
if(rawAction==='sync_saved_items'||rawAction==='syncSavedItems'){action='sync_saved_items';}
else if(TRACKING_ACTIONS[rawAction]){action=rawAction;}
else{action='request_location_update';}
const idPrefix=action==='sync_saved_items'?'sync':(TRACKING_ACTIONS[action]?'trk':'loc');
const requestId=String(body.requestId||(idPrefix+'-'+Date.now()+'-'+Math.random().toString(36).slice(2,8)));
const slash=key.indexOf('/');
const user=topicPart(body.user||(slash>0?key.slice(0,slash):''),'mobile');
const device=topicPart(body.device||(slash>0?key.slice(slash+1):key),'phone');
const commandType=action==='request_location_update'?'mobile:request-location':'mobile:command';
const command={type:commandType,action:action,deviceKey:key,requestId:requestId,requestedAt:Date.now()};
msg.payload={ok:true,data:{deviceKey:key,requestId:requestId,transport:'mqtt'}};
return [
  msg,
  {payload:JSON.stringify(command)},
  {topic:'mobile_app/commands/'+user+'/'+device,payload:JSON.stringify(command),qos:1,retain:false}
];`;

const bridgeJsHeadersFunction = String.raw`msg.headers={'Content-Type':'application/javascript; charset=utf-8','Cache-Control':'no-store'};
return msg;`;

const mqttJsHeadersFunction = String.raw`msg.headers={'Content-Type':'application/javascript; charset=utf-8','Cache-Control':'public, max-age=86400'};
return msg;`;

function httpIn(id, name, method, url, x, y, wires) {
  return { id, type: 'http in', z: tabId, name, url, method, upload: false, swaggerDoc: '', x, y, wires };
}
function response(id, x, y) {
  return { id, type: 'http response', z: tabId, name: '', statusCode: '', headers: {}, x, y, wires: [] };
}
function fn(id, name, func, outputs, x, y, wires) {
  return { id, type: 'function', z: tabId, name, func, outputs, timeout: 0, noerr: 0, initialize: '', finalize: '', libs: [], x, y, wires };
}
function execNode(id, name, command, x, y, wires) {
  return { id, type: 'exec', z: tabId, name, command, addpay: false, append: '', useSpawn: 'false', timer: '', oldrc: false, x, y, wires };
}

const next = flow.filter((n) => n && n.id !== tabId && n.z !== tabId && n.id !== 'mobile_app_ws_listener_20260521');
if (!wsConfig) next.push({ id: wsConfigId, type: 'websocket-listener', path: '/ws/live-tracking', wholemsg: 'false' });
next.push(
  { id: tabId, type: 'tab', label: 'Mobile App', disabled: false, info: 'Capacitor Mobile-App: APK-Download, API-Endpunkte und Installationsseite.' },
  httpIn('mobile_install_http_in', 'Capacitor Install Seite', 'get', '/mobile', 140, 80, [['mobile_install_template']]),
  httpIn('mobile_install_slash_http_in', 'Capacitor Install Seite Slash', 'get', '/mobile/', 140, 120, [['mobile_install_template']]),
  { id: 'mobile_install_template', type: 'template', z: tabId, name: 'Capacitor Install Hinweis', field: 'payload', fieldType: 'msg', format: 'handlebars', syntax: 'mustache', output: 'str', template: installHtml, x: 410, y: 100, wires: [['mobile_install_response']] },
  response('mobile_install_response', 660, 100),
  httpIn('mobile_bridge_js_http_in', 'Cap Bridge JS', 'get', '/mobile/capacitor-bridge.js', 140, 140, [['mobile_bridge_js_template']]),
  { id: 'mobile_bridge_js_template', type: 'template', z: tabId, name: 'Capacitor Bridge JS', field: 'payload', fieldType: 'msg', format: 'handlebars', syntax: 'mustache', output: 'str', template: bridgeJs, x: 410, y: 140, wires: [['mobile_bridge_js_headers_fn']] },
  fn('mobile_bridge_js_headers_fn', 'bridge js headers', bridgeJsHeadersFunction, 1, 660, 140, [['mobile_bridge_js_response']]),
  response('mobile_bridge_js_response', 880, 140),
  httpIn('mobile_mqtt_js_http_in', 'MQTT JS', 'get', '/mobile/mqtt.min.js', 140, 170, [['mobile_mqtt_js_template']]),
  { id: 'mobile_mqtt_js_template', type: 'template', z: tabId, name: 'MQTT Browser Client', field: 'payload', fieldType: 'msg', format: 'handlebars', syntax: 'mustache', output: 'str', template: mqttJs, x: 410, y: 170, wires: [['mobile_mqtt_js_headers_fn']] },
  fn('mobile_mqtt_js_headers_fn', 'mqtt js headers', mqttJsHeadersFunction, 1, 660, 170, [['mobile_mqtt_js_response']]),
  response('mobile_mqtt_js_response', 880, 170),
  httpIn('mobile_apk_info_http_in', 'APK Info', 'get', '/mobile/api/apk-info', 140, 200, [['mobile_apk_info_exec']]),
  execNode('mobile_apk_info_exec', 'apk stat', apkStatCommand, 300, 180, [['mobile_apk_info_parse_fn'], [], []]),
  fn('mobile_apk_info_parse_fn', 'apk info parse', apkInfoParseFunction, 1, 470, 180, [['mobile_apk_info_response']]),
  response('mobile_apk_info_response', 660, 180),
  httpIn('mobile_bootstrap_http_in', 'Mobile Bootstrap', 'get', '/mobile/api/bootstrap', 140, 320, [['mobile_bootstrap_fn']]),
  fn('mobile_bootstrap_fn', 'bootstrap', bootstrapFunction, 1, 410, 320, [['mobile_bootstrap_response']]),
  response('mobile_bootstrap_response', 660, 320),
  httpIn('mobile_points_http_in', 'Capacitor GPS Punkte', 'post', '/mobile/api/points', 140, 390, [['mobile_points_fn']]),
  fn('mobile_points_fn', 'store capacitor points (HTTP disabled)', pointFunction, 1, 410, 390, [['mobile_points_response']]),
  response('mobile_points_response', 660, 390),
  httpIn('mobile_location_request_http_in', 'Capacitor Standort anfordern', 'post', '/mobile/api/request-location', 140, 430, [['mobile_location_request_fn']]),
  fn('mobile_location_request_fn', 'request capacitor location', locationRequestFunction, 3, 410, 430, [['mobile_location_request_response'], ['mobile_live_ws_out'], ['mobile_location_request_mqtt_out']]),
  response('mobile_location_request_response', 660, 420),
  { id: 'mobile_live_ws_out', type: 'websocket out', z: tabId, name: 'Mobile Live Tracking Push', server: wsConfigId, client: '', x: 660, y: 440, wires: [] },
  { id: 'mobile_location_request_mqtt_out', type: 'mqtt out', z: tabId, name: 'Mobile Standort MQTT Command', topic: '', qos: '1', retain: 'false', respTopic: '', contentType: '', userProps: '', correl: '', expiry: '', broker: mqttBrokerId, x: 690, y: 480, wires: [] },
  httpIn('mobile_regions_get_http_in', 'Mobile Regionen lesen', 'get', '/mobile/api/regions', 140, 520, [['mobile_regions_get_fn']]),
  fn('mobile_regions_get_fn', 'regions list', regionsGetFunction, 1, 410, 520, [['mobile_regions_get_response']]),
  response('mobile_regions_get_response', 660, 520),
  httpIn('mobile_regions_post_http_in', 'Mobile Region speichern', 'post', '/mobile/api/regions', 140, 580, [['mobile_regions_post_fn']]),
  fn('mobile_regions_post_fn', 'regions save', regionsPostFunction, 1, 410, 580, [['mobile_regions_post_response']]),
  response('mobile_regions_post_response', 660, 580)
);

fs.writeFileSync(flowFile, JSON.stringify(next, null, 4), 'utf8');
console.log('Capacitor Mobile App flow written.');
