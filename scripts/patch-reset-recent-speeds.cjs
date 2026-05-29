const fs = require("fs");
const path = require("path");

const flowPath = path.join(__dirname, "..", "flows.json");
const flow = JSON.parse(fs.readFileSync(flowPath, "utf8"));
const node = flow.find(function (n) {
  return n && n.id === "0b7df22564f0d767";
});
if (!node || typeof node.func !== "string") {
  throw new Error("resetAllData node not found");
}
let fn = node.func;
const needle1 =
  'global.set("lastPositionByDevice", lastPositionByDeviceReset);\n\n        if (influxReadOrDeleteEnabled()) {';
const insert1 =
  'global.set("lastPositionByDevice", lastPositionByDeviceReset);\n\n' +
  '        const recentSpeedsByKey = global.get("recentSpeedsByKey") || {};\n' +
  "        delete recentSpeedsByKey[deviceKey];\n" +
  '        global.set("recentSpeedsByKey", recentSpeedsByKey);\n\n' +
  "        if (influxReadOrDeleteEnabled()) {";
if (!fn.includes(needle1)) {
  throw new Error("needle1 not found (device reset block)");
}
if (fn.includes('delete recentSpeedsByKey[deviceKey]')) {
  console.log("already patched device recentSpeeds");
} else {
  fn = fn.replace(needle1, insert1);
}

const needle2 = 'global.set("receivedCountByDevice", {});\n    global.set("historyCleaned", true);';
const insert2 =
  'global.set("receivedCountByDevice", {});\n' +
  '    global.set("recentSpeedsByKey", {});\n' +
  '    global.set("historyCleaned", true);';
if (!fn.includes(needle2)) {
  throw new Error("needle2 not found (full reset)");
}
if (fn.includes('global.set("recentSpeedsByKey", {});')) {
  console.log("already patched full recentSpeeds");
} else {
  fn = fn.replace(needle2, insert2);
}

node.func = fn;
fs.writeFileSync(flowPath, JSON.stringify(flow));
JSON.parse(fs.readFileSync(flowPath, "utf8"));
console.log("OK patch-reset-recent-speeds");
