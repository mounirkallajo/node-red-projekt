"use strict";

const fs = require("fs");
const path = require("path");

const flowPath = path.join(__dirname, "..", "flows.json");

const newHttpPostJson = `function httpPostJson(urlStr, jsonBody, extraHeaders) {
    if (typeof fetch !== "function") {
        return Promise.reject(new Error("fetch is not available; use Node.js 18+"));
    }
    const bodyStr = typeof jsonBody === "string" ? jsonBody : JSON.stringify(jsonBody);
    const headers = Object.assign({ "Content-Type": "application/json" }, extraHeaders || {});
    return fetch(urlStr, { method: "POST", headers: headers, body: bodyStr }).then(function (res) {
        return res.text().then(function (txt) {
            if (!res.ok) {
                throw new Error("HTTP " + res.status + " " + txt.slice(0, 200));
            }
            return txt;
        });
    });
}`;

const flow = JSON.parse(fs.readFileSync(flowPath, "utf8"));
let patched = 0;

for (let i = 0; i < flow.length; i++) {
    const node = flow[i];
    if (!node || node.type !== "function" || typeof node.func !== "string") continue;
    if (!node.func.includes('const http = require("http")')) continue;
    const start = node.func.indexOf("function httpPostJson");
    const end = node.func.indexOf("\nfunction splitCsvLine", start);
    if (start === -1 || end === -1) continue;
    node.func = node.func.slice(0, start) + newHttpPostJson + node.func.slice(end);
    patched += 1;
    console.log("Patched:", node.name || node.id, node.id);
}

if (patched === 0) {
    console.error("No matching function nodes found.");
    process.exit(1);
}

fs.writeFileSync(flowPath, JSON.stringify(flow, null, 4), "utf8");
console.log("Total patched:", patched);
