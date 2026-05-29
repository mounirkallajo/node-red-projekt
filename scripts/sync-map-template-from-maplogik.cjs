/**
 * Copies repo file `Maplogik` into the Node-RED `template` node on the Map tab
 * so the served map matches the source file (flows.json does not auto-read Maplogik).
 *
 * Run from project root: node scripts/sync-map-template-from-maplogik.cjs
 */
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const flowPath = path.join(root, "flows.json");
const maplogikPath = path.join(root, "Maplogik");
const TEMPLATE_NODE_ID = "b0dbf8a4e58a40b2";

const mapBody = fs.readFileSync(maplogikPath, "utf8");
const flow = JSON.parse(fs.readFileSync(flowPath, "utf8"));
const node = flow.find(function (n) {
  return n && n.id === TEMPLATE_NODE_ID;
});
if (!node || node.type !== "template") {
  throw new Error("Map template node " + TEMPLATE_NODE_ID + " not found or wrong type");
}
const beforeLen = typeof node.template === "string" ? node.template.length : 0;
node.template = mapBody;
fs.writeFileSync(flowPath, JSON.stringify(flow), "utf8");
console.log(
  "OK: template",
  TEMPLATE_NODE_ID,
  "updated from Maplogik;",
  "template chars",
  beforeLen,
  "->",
  mapBody.length
);
