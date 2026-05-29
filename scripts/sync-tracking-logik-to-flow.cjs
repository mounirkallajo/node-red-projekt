"use strict";

const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const flowPath = path.join(root, "flows.json");
const trackingPath = path.join(root, "Tracking-logik");

const trackingText = fs.readFileSync(trackingPath, "utf8");
const flow = JSON.parse(fs.readFileSync(flowPath, "utf8"));
const node = flow.find((x) => x.type === "function" && x.name === "Tracking-Logik");
if (!node) {
    throw new Error("flows.json: Tracking-Logik function node not found");
}
node.func = trackingText;
fs.writeFileSync(flowPath, JSON.stringify(flow));
console.log("OK: flows.json Tracking-Logik replaced from Tracking-logik file");
