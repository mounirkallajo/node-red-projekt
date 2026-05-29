"use strict";

const path = require("path");
const flowPath = path.join(__dirname, "..", "flows.json");
const flow = require(flowPath);
const nodeId = process.argv[2] || "3de0e2c3cfa6689f";
const node = flow.find((n) => n.id === nodeId);
if (!node || node.type !== "function") {
    console.error("Function node not found:", nodeId);
    process.exit(1);
}
console.log("Node:", node.name || nodeId);
console.log("  libs nodeHttp/https:", Array.isArray(node.libs) && node.libs.some((l) => l.var === "nodeHttp"));
console.log("  code uses nodeHttp:", node.func.includes("nodeHttp"));
console.log("  __influxGlobalGet:", node.func.includes("__influxGlobalGet"));
