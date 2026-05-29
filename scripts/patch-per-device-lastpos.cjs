/**
 * Per-device lastPosition store + API + resets.
 * Run: node scripts/patch-per-device-lastpos.cjs
 */
const fs = require("fs");
const path = require("path");
const root = path.resolve(__dirname, "..");
const flowPath = path.join(root, "flows.json");
const trackingPath = path.join(root, "Tracking-logik");

const TRACKING_SNIPPET_OLD =
  'global.set(\\"lastPosition\\", positionForLastGlobal);\\nif (!global.get(\\"historyCleanedV2\\")) {\\n    ';
const TRACKING_SNIPPET_NEW =
  'global.set(\\"lastPosition\\", positionForLastGlobal);\\n' +
  'let lastPositionByDevice = global.get(\\"lastPositionByDevice\\") || {};\\n' +
  'lastPositionByDevice[key] = positionForLastGlobal;\\n' +
  'global.set(\\"lastPositionByDevice\\", lastPositionByDevice);\\n' +
  'if (!global.get(\\"historyCleanedV2\\")) {\\n    ';

const LASTPOS_API_OLD =
  'let lastPosition = global.get(\\"lastPosition\\") || null;\\n\\nmsg.payload = {\\n    ok: true,\\n    data: lastPosition\\n};\\n\\nreturn msg;';
const LASTPOS_API_NEW =
  'const req = msg.req || {};\\n' +
  'const query = req.query || {};\\n' +
  'let rawKey = typeof query.deviceKey === \\"string\\" ? query.deviceKey.trim() : \\"\\";\\n' +
  'if (!rawKey && typeof query.user === \\"string\\" && typeof query.device === \\"string\\") {\\n' +
  '    const u = query.user.trim();\\n' +
  '    const d = query.device.trim();\\n' +
  '    if (u && d) rawKey = u + \\"/\\" + d;\\n' +
  '}\\n' +
  'const devices = global.get(\\"devices\\") || {};\\n' +
  'const lastPositionByDevice = global.get(\\"lastPositionByDevice\\") || {};\\n' +
  'let data = null;\\n' +
  'if (rawKey) {\\n' +
  '    data = devices[rawKey] || lastPositionByDevice[rawKey] || null;\\n' +
  '} else {\\n' +
  '    data = global.get(\\"lastPosition\\") || null;\\n' +
  '}\\n' +
  'msg.payload = { ok: true, data: data };\\n' +
  "return msg;";

const DELETE_DEVICE_OLD =
  'delete lastGoodPositionByDevice[key];\\n    global.set(\\"lastGoodPositionByDevice\\", lastGoodPositionByDevice);\\n\\n    const lastPosition = global.get(\\"lastPosition\\") || null;\\n    if (lastPosition && lastPosition.key === key) {\\n        global.set(\\"lastPosition\\", null);\\n    }';
const DELETE_DEVICE_NEW =
  'delete lastGoodPositionByDevice[key];\\n    global.set(\\"lastGoodPositionByDevice\\", lastGoodPositionByDevice);\\n\\n    const lastPositionByDeviceDel = global.get(\\"lastPositionByDevice\\") || {};\\n    delete lastPositionByDeviceDel[key];\\n    global.set(\\"lastPositionByDevice\\", lastPositionByDeviceDel);\\n    const lastPosition = global.get(\\"lastPosition\\") || null;\\n    if (lastPosition && lastPosition.key === key) {\\n        global.set(\\"lastPosition\\", null);\\n    }';

const RESET_DEVICE_OLD =
  'delete lastGoodPositionByDevice[deviceKey];\\n        global.set(\\"lastGoodPositionByDevice\\", lastGoodPositionByDevice);\\n\\n        if (influxReadOrDeleteEnabled()) {';
const RESET_DEVICE_NEW =
  'delete lastGoodPositionByDevice[deviceKey];\\n        global.set(\\"lastGoodPositionByDevice\\", lastGoodPositionByDevice);\\n        const lastPositionByDeviceReset = global.get(\\"lastPositionByDevice\\") || {};\\n        delete lastPositionByDeviceReset[deviceKey];\\n        global.set(\\"lastPositionByDevice\\", lastPositionByDeviceReset);\\n\\n        if (influxReadOrDeleteEnabled()) {';

const RESET_ALL_OLD =
  'global.set(\\"lastPosition\\", null);\\n    global.set(\\"history\\", []);\\n    global.set(\\"devices\\", {});';
const RESET_ALL_NEW =
  'global.set(\\"lastPosition\\", null);\\n    global.set(\\"lastPositionByDevice\\", {});\\n    global.set(\\"history\\", []);\\n    global.set(\\"devices\\", {});';

function replaceOne(haystack, oldStr, newStr, label) {
  const count = haystack.split(oldStr).length - 1;
  if (count !== 1) {
    throw new Error(label + ": expected 1 occurrence, found " + count);
  }
  return haystack.replace(oldStr, newStr);
}

let flowText = fs.readFileSync(flowPath, "utf8");
flowText = replaceOne(flowText, TRACKING_SNIPPET_OLD, TRACKING_SNIPPET_NEW, "flows.json tracking");
flowText = replaceOne(flowText, LASTPOS_API_OLD, LASTPOS_API_NEW, "flows.json lastPosition API");
flowText = replaceOne(flowText, DELETE_DEVICE_OLD, DELETE_DEVICE_NEW, "flows.json deleteDevice");
flowText = replaceOne(flowText, RESET_DEVICE_OLD, RESET_DEVICE_NEW, "flows.json reset device");
flowText = replaceOne(flowText, RESET_ALL_OLD, RESET_ALL_NEW, "flows.json reset all");
JSON.parse(flowText);
fs.writeFileSync(flowPath, flowText, "utf8");

const TRACKING_FILE_OLD =
  'global.set("lastPosition", positionForLastGlobal);\nif (!global.get("historyCleanedV2")) {\n    ';
const TRACKING_FILE_NEW =
  'global.set("lastPosition", positionForLastGlobal);\n' +
  'let lastPositionByDevice = global.get("lastPositionByDevice") || {};\n' +
  'lastPositionByDevice[key] = positionForLastGlobal;\n' +
  'global.set("lastPositionByDevice", lastPositionByDevice);\n' +
  'if (!global.get("historyCleanedV2")) {\n    ';
let tr = fs.readFileSync(trackingPath, "utf8");
tr = replaceOne(tr, TRACKING_FILE_OLD, TRACKING_FILE_NEW, "Tracking-logik");
fs.writeFileSync(trackingPath, tr, "utf8");

console.log("OK: flows.json + Tracking-logik patched.");
