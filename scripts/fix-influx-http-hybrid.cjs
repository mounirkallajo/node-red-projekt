"use strict";

const fs = require("fs");
const path = require("path");

const flowPath = path.join(__dirname, "..", "flows.json");

const hybridHttpPostJson = `function httpPostJson(urlStr, jsonBody, extraHeaders) {
    function __influxGlobalGet(key) {
        try {
            if (typeof global !== "undefined" && global && typeof global.get === "function") {
                var a = global.get(key);
                if (a !== undefined && a !== null) return a;
            }
        } catch (e1) {}
        try {
            if (typeof context !== "undefined" && context.global && typeof context.global.get === "function") {
                var b = context.global.get(key);
                if (b !== undefined && b !== null) return b;
            }
        } catch (e2) {}
        return null;
    }
    const bodyStr = typeof jsonBody === "string" ? jsonBody : JSON.stringify(jsonBody);
    const hdrs = Object.assign({ "Content-Type": "application/json" }, extraHeaders || {});
    if (typeof fetch === "function") {
        return fetch(urlStr, { method: "POST", headers: hdrs, body: bodyStr }).then(function (res) {
            return res.text().then(function (txt) {
                if (!res.ok) {
                    throw new Error("HTTP " + res.status + " " + txt.slice(0, 200));
                }
                return txt;
            });
        });
    }
    var httpMod = null;
    var httpsMod = null;
    try {
        if (typeof nodeHttp !== "undefined" && nodeHttp && typeof nodeHttp.request === "function") {
            httpMod = nodeHttp;
        }
        if (typeof nodeHttps !== "undefined" && nodeHttps && typeof nodeHttps.request === "function") {
            httpsMod = nodeHttps;
        }
    } catch (eLib) {}
    if (!httpMod) httpMod = __influxGlobalGet("influxHttp") || __influxGlobalGet("http");
    if (!httpsMod) httpsMod = __influxGlobalGet("influxHttps") || __influxGlobalGet("https");
    var nodeRequire = typeof require === "function" ? require : null;
    if ((!httpMod || !httpsMod) && !nodeRequire) {
        nodeRequire = __influxGlobalGet("require");
    }
    if ((!httpMod || !httpsMod) && typeof nodeRequire === "function") {
        httpMod = httpMod || nodeRequire("http");
        httpsMod = httpsMod || nodeRequire("https");
    }
    if (!httpMod || !httpsMod || typeof httpMod.request !== "function" || typeof httpsMod.request !== "function") {
        return Promise.reject(new Error("Influx HTTP: Function-Node braucht Module http/https (im Flow vorkonfiguriert) oder functionGlobalContext mit influxHttp/influxHttps bzw. http/https — siehe INFLUX.md"));
    }
    const u = new URL(urlStr);
    const lib = u.protocol === "https:" ? httpsMod : httpMod;
    return new Promise(function (resolve, reject) {
        const opts = {
            method: "POST",
            hostname: u.hostname,
            port: u.port || (u.protocol === "https:" ? 443 : 80),
            path: u.pathname + u.search,
            headers: Object.assign({
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(bodyStr)
            }, hdrs)
        };
        const req = lib.request(opts, function (res) {
            const chunks = [];
            res.on("data", function (d) { chunks.push(d); });
            res.on("end", function () {
                const txt = Buffer.concat(chunks).toString("utf8");
                if (res.statusCode && res.statusCode >= 400) {
                    reject(new Error("HTTP " + res.statusCode + " " + txt.slice(0, 200)));
                } else {
                    resolve(txt);
                }
            });
        });
        req.on("error", reject);
        req.write(bodyStr);
        req.end();
    });
}`;

const influxHttpLibNodeIds = ["5d1d2c94f93d6ba9", "4f96bc13a2534bc7", "3de0e2c3cfa6689f", "0b7df22564f0d767"];
const influxHttpLibs = [
    { module: "http", var: "nodeHttp" },
    { module: "https", var: "nodeHttps" }
];

const flow = JSON.parse(fs.readFileSync(flowPath, "utf8"));
let patched = 0;

for (let i = 0; i < flow.length; i++) {
    const node = flow[i];
    if (!node || node.type !== "function" || typeof node.func !== "string") continue;
    if (!node.func.includes("function httpPostJson")) continue;
    const start = node.func.indexOf("function httpPostJson");
    const end = node.func.indexOf("\nfunction splitCsvLine", start);
    if (start === -1 || end === -1) continue;
    node.func = node.func.slice(0, start) + hybridHttpPostJson + node.func.slice(end);
    patched += 1;
    console.log("Patched:", node.name || node.id, node.id);
}

for (let j = 0; j < influxHttpLibNodeIds.length; j++) {
    const id = influxHttpLibNodeIds[j];
    const n = flow.find((x) => x.id === id);
    if (n && n.type === "function") {
        n.libs = influxHttpLibs;
        console.log("libs set:", n.name || id, id);
    }
}

if (patched === 0) {
    console.error("No httpPostJson found.");
    process.exit(1);
}

fs.writeFileSync(flowPath, JSON.stringify(flow, null, 4), "utf8");
console.log("Total httpPostJson patched:", patched);
