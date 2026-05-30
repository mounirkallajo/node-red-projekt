"use strict";

const fs = require("fs");
const path = require("path");

const projectRoot = path.join(__dirname, "..");
const flowPath = path.join(projectRoot, "flows.json");

const TRACKING_NODE_ID = "09ecbcb7cc6bb1f7";
const INFLUX_HTTP_NODE_ID = "c7a9bf120e841d01";

const INSERT_AFTER_CONST = "const STATIONARY_MAX_ACCURACY_M = 20;\n\nfunction asNumber";

const INFLUX_HELPERS = `const STATIONARY_MAX_ACCURACY_M = 20;

function escapeInfluxTagValue(s) {
    return String(s)
        .split("\\\\").join("\\\\\\\\")
        .split(" ").join("\\\\ ")
        .split("=").join("\\\\=")
        .split(",").join("\\\\,");
}
function influxWriteEnabled() {
    try {
        const dis = env.get("INFLUX_ENABLED");
        if (dis === "false" || dis === "0") return false;
        const base = env.get("INFLUX_URL");
        const token = env.get("INFLUX_TOKEN");
        const org = env.get("INFLUX_ORG");
        const bucket = env.get("INFLUX_BUCKET");
        return !!(base && token && org && bucket);
    } catch (e) {
        return false;
    }
}
function buildInfluxGpsLineProtocol(deviceId, p) {
    const tag = escapeInfluxTagValue(deviceId);
    const ms = Number(p.timestamp);
    const tsNs = Number.isFinite(ms) && ms > 0 ? Math.round(ms * 1000000) : Math.round(Date.now() * 1000000);
    const fields = [];
    if (typeof p.lat === "number" && Number.isFinite(p.lat)) fields.push("lat=" + p.lat);
    if (typeof p.lon === "number" && Number.isFinite(p.lon)) fields.push("lon=" + p.lon);
    if (fields.length < 2) return null;
    if (typeof p.accuracy === "number" && Number.isFinite(p.accuracy)) fields.push("accuracy=" + p.accuracy);
    if (typeof p.speed === "number" && Number.isFinite(p.speed)) fields.push("speed=" + p.speed);
    if (typeof p.heading === "number" && Number.isFinite(p.heading)) fields.push("heading=" + p.heading);
    if (typeof p.battery === "number" && Number.isFinite(p.battery)) fields.push("battery=" + Math.round(p.battery) + "i");
    if (p.segmentId != null && String(p.segmentId) !== "") {
        fields.push('segment_id="' + String(p.segmentId).replace(/(["\\])/g, "\\$1") + '"');
    }
    if (p.breakBefore === true) fields.push("break_before=true");
    return "gps_point,device_id=" + tag + " " + fields.join(",") + " " + tsNs;
}
function buildInfluxWriteMessage(line) {
    if (!line) return null;
    try {
        let base = String(env.get("INFLUX_URL"));
        while (base.endsWith("/")) base = base.slice(0, -1);
        const org = env.get("INFLUX_ORG");
        const bucket = env.get("INFLUX_BUCKET");
        const token = env.get("INFLUX_TOKEN");
        const url = base + "/api/v2/write?org=" + encodeURIComponent(org) + "&bucket=" + encodeURIComponent(bucket) + "&precision=ns";
        return {
            method: "POST",
            url: url,
            headers: {
                Authorization: "Token " + token,
                "Content-Type": "text/plain; charset=utf-8"
            },
            payload: line
        };
    } catch (e) {
        return null;
    }
}

function asNumber`;

const OLD_APPEND = `if (trackingIsActiveForDevice && gpsFixOk && stabilizedPosition.lat !== null && stabilizedPosition.lon !== null) {
    let recentSpeedsByKey = global.get("recentSpeedsByKey") || {};
    const recentDeviceSpeedsMps = Array.isArray(recentSpeedsByKey[key]) ? recentSpeedsByKey[key] : [];
    let deviceHistory = historyByDevice[key] || [];
    const deviceAppendResult = appendToHistory(deviceHistory, stabilizedPosition, recentDeviceSpeedsMps);
    historyByDevice[key] = deviceAppendResult.history;
    recentSpeedsByKey[key] = deviceAppendResult.recentSpeedsMps;
    global.set("recentSpeedsByKey", recentSpeedsByKey);
}`;

const NEW_APPEND = `let influxSecondMsg = null;
if (trackingIsActiveForDevice && gpsFixOk && stabilizedPosition.lat !== null && stabilizedPosition.lon !== null) {
    let recentSpeedsByKey = global.get("recentSpeedsByKey") || {};
    const recentDeviceSpeedsMps = Array.isArray(recentSpeedsByKey[key]) ? recentSpeedsByKey[key] : [];
    let deviceHistory = historyByDevice[key] || [];
    const deviceAppendResult = appendToHistory(deviceHistory, stabilizedPosition, recentDeviceSpeedsMps);
    historyByDevice[key] = deviceAppendResult.history;
    recentSpeedsByKey[key] = deviceAppendResult.recentSpeedsMps;
    global.set("recentSpeedsByKey", recentSpeedsByKey);
    if (deviceAppendResult.added && influxWriteEnabled()) {
        const lp = buildInfluxGpsLineProtocol(key, stabilizedPosition);
        influxSecondMsg = buildInfluxWriteMessage(lp);
    }
}`;

const OLD_RETURN = `msg.payload = stabilizedPosition;
return msg;`;

const NEW_RETURN = `msg.payload = stabilizedPosition;
return [msg, influxSecondMsg];`;

const SHARED_HTTP = `
function influxReadOrDeleteEnabled() {
    try {
        const dis = env.get("INFLUX_ENABLED");
        if (dis === "false" || dis === "0") return false;
        return !!(env.get("INFLUX_URL") && env.get("INFLUX_TOKEN") && env.get("INFLUX_ORG") && env.get("INFLUX_BUCKET"));
    } catch (e) {
        return false;
    }
}
function escapeFluxDoubleQuotes(s) {
    return String(s).split("\\\\").join("\\\\\\\\").split('"').join('\\\\"');
}
function escapeInfluxPredicateValue(s) {
    return String(s).split("\\\\").join("\\\\\\\\").split('"').join('\\\\"');
}
function httpPostJson(urlStr, jsonBody, extraHeaders) {
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
}
function splitCsvLine(line) {
    const out = [];
    let cur = "";
    let i = 0;
    while (i < line.length) {
        const c = line[i];
        if (c === '"') {
            i++;
            while (i < line.length) {
                if (line[i] === '"') {
                    if (i + 1 < line.length && line[i + 1] === '"') {
                        cur += '"';
                        i += 2;
                    } else {
                        i++;
                        break;
                    }
                } else {
                    cur += line[i];
                    i++;
                }
            }
            continue;
        }
        if (c === ",") {
            out.push(cur);
            cur = "";
            i++;
            continue;
        }
        cur += c;
        i++;
    }
    out.push(cur);
    return out;
}
function parseInfluxAnnotatedCsv(csvText) {
    const lines = csvText.split(/\\r?\\n/);
    let headers = null;
    const rows = [];
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!line) continue;
        if (line[0] === "#") continue;
        const cells = splitCsvLine(line);
        if (!headers) {
            headers = cells;
            continue;
        }
        const row = {};
        for (let j = 0; j < headers.length; j++) {
            row[headers[j]] = cells[j] !== undefined ? cells[j] : "";
        }
        rows.push(row);
    }
    return rows;
}
function mapInfluxRowToPoint(row) {
    const key = row.device_id || "";
    const slash = key.indexOf("/");
    const user = slash > 0 ? key.slice(0, slash) : "";
    const device = slash > 0 ? key.slice(slash + 1) : "";
    const ts = Date.parse(row._time || "");
    const lat = parseFloat(row.lat);
    const lon = parseFloat(row.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    const o = {
        user: user,
        device: device,
        key: key || (user + "/" + device),
        lat: lat,
        lon: lon,
        timestamp: Number.isFinite(ts) && ts > 0 ? ts : 0,
        receivedAt: Number.isFinite(ts) && ts > 0 ? ts : 0
    };
    if (row.accuracy !== undefined && row.accuracy !== "") {
        const ac = parseFloat(row.accuracy);
        if (Number.isFinite(ac)) o.accuracy = ac;
    }
    if (row.speed !== undefined && row.speed !== "") {
        const sp = parseFloat(row.speed);
        if (Number.isFinite(sp)) o.speed = sp;
    }
    if (row.heading !== undefined && row.heading !== "") {
        const hd = parseFloat(row.heading);
        if (Number.isFinite(hd)) o.heading = hd;
    }
    if (row.battery !== undefined && row.battery !== "") {
        const bt = parseFloat(row.battery);
        if (Number.isFinite(bt)) o.battery = bt;
    }
    if (row.segment_id !== undefined && row.segment_id !== "") {
        o.segmentId = String(row.segment_id);
    }
    if (row.break_before !== undefined && String(row.break_before).toLowerCase() === "true") {
        o.breakBefore = true;
    }
    return o;
}
function buildFluxHistory(deviceKeyFilter) {
    const bucket = env.get("INFLUX_BUCKET");
    const bq = escapeFluxDoubleQuotes(bucket);
    const lines = [
        'from(bucket: "' + bq + '")',
        '  |> range(start: -30d)',
        '  |> filter(fn: (r) => r["_measurement"] == "gps_point")',
        '  |> filter(fn: (r) => r["_field"] == "lat" or r["_field"] == "lon" or r["_field"] == "accuracy" or r["_field"] == "speed" or r["_field"] == "heading" or r["_field"] == "battery" or r["_field"] == "segment_id" or r["_field"] == "break_before")'
    ];
    if (deviceKeyFilter) {
        lines.push('  |> filter(fn: (r) => r["device_id"] == "' + escapeFluxDoubleQuotes(deviceKeyFilter) + '")');
    }
    lines.push('  |> pivot(rowKey: ["_time", "device_id"], columnKey: ["_field"], valueColumn: "_value")');
    lines.push("  |> group()");
    lines.push('  |> sort(columns: ["_time"])');
    lines.push("  |> limit(n: 2000)");
    return lines.join(String.fromCharCode(10));
}
async function influxDeleteByPredicate(predicate) {
    let base = String(env.get("INFLUX_URL"));
    while (base.endsWith("/")) base = base.slice(0, -1);
    const org = env.get("INFLUX_ORG");
    const bucket = env.get("INFLUX_BUCKET");
    const token = env.get("INFLUX_TOKEN");
    const url = base + "/api/v2/delete?org=" + encodeURIComponent(org) + "&bucket=" + encodeURIComponent(bucket);
    const body = {
        start: "1970-01-01T00:00:00Z",
        stop: "2262-04-11T23:47:16.854775806Z",
        predicate: predicate
    };
    await httpPostJson(url, body, { Authorization: "Token " + token });
}
`.trim();

const HISTORY_FUNC =
    SHARED_HTTP +
    `
return (async function () {
    if (!influxReadOrDeleteEnabled()) {
        let history = global.get("history") || [];
        let receivedCount = global.get("receivedCount");
        if (typeof receivedCount !== "number" || receivedCount < history.length) {
            receivedCount = history.length;
        }
        msg.payload = {
            ok: true,
            count: history.length,
            received: receivedCount,
            data: history
        };
        return msg;
    }
    try {
        let base = String(env.get("INFLUX_URL"));
        while (base.endsWith("/")) base = base.slice(0, -1);
        const org = env.get("INFLUX_ORG");
        const token = env.get("INFLUX_TOKEN");
        const flux = buildFluxHistory("");
        const queryUrl = base + "/api/v2/query?org=" + encodeURIComponent(org);
        const csvText = await httpPostJson(queryUrl, { query: flux, type: "flux" }, {
            Authorization: "Token " + token,
            Accept: "application/csv"
        });
        const rows = parseInfluxAnnotatedCsv(csvText);
        const data = [];
        for (let i = 0; i < rows.length; i++) {
            const pt = mapInfluxRowToPoint(rows[i]);
            if (pt) data.push(pt);
        }
        let receivedCount = global.get("receivedCount");
        if (typeof receivedCount !== "number" || receivedCount < data.length) {
            receivedCount = data.length;
        }
        msg.payload = {
            ok: true,
            count: data.length,
            received: receivedCount,
            data: data
        };
        return msg;
    } catch (err) {
        node.warn("Influx history: " + (err && err.message ? err.message : err));
        let history = global.get("history") || [];
        let receivedCount = global.get("receivedCount");
        if (typeof receivedCount !== "number" || receivedCount < history.length) {
            receivedCount = history.length;
        }
        msg.payload = {
            ok: true,
            count: history.length,
            received: receivedCount,
            data: history
        };
        return msg;
    }
})();
`;

const HISTORY_DEVICE_FUNC =
    SHARED_HTTP +
    `
return (async function () {
    let user = msg.req.params.user;
    let device = msg.req.params.device;
    let key = user + "/" + device;
    if (!influxReadOrDeleteEnabled()) {
        let historyByDevice = global.get("historyByDevice") || {};
        let history = historyByDevice[key] || [];
        let receivedCountByDevice = global.get("receivedCountByDevice") || {};
        let received = receivedCountByDevice[key] || 0;
        if (typeof received !== "number" || received < history.length) {
            received = history.length;
        }
        msg.payload = {
            ok: true,
            key: key,
            count: history.length,
            received: received,
            data: history
        };
        return msg;
    }
    try {
        let base = String(env.get("INFLUX_URL"));
        while (base.endsWith("/")) base = base.slice(0, -1);
        const org = env.get("INFLUX_ORG");
        const token = env.get("INFLUX_TOKEN");
        const flux = buildFluxHistory(key);
        const queryUrl = base + "/api/v2/query?org=" + encodeURIComponent(org);
        const csvText = await httpPostJson(queryUrl, { query: flux, type: "flux" }, {
            Authorization: "Token " + token,
            Accept: "application/csv"
        });
        const rows = parseInfluxAnnotatedCsv(csvText);
        const data = [];
        for (let i = 0; i < rows.length; i++) {
            const pt = mapInfluxRowToPoint(rows[i]);
            if (pt) data.push(pt);
        }
        let receivedCountByDevice = global.get("receivedCountByDevice") || {};
        let received = receivedCountByDevice[key] || 0;
        if (typeof received !== "number" || received < data.length) {
            received = data.length;
        }
        msg.payload = {
            ok: true,
            key: key,
            count: data.length,
            received: received,
            data: data
        };
        return msg;
    } catch (err) {
        node.warn("Influx history device: " + (err && err.message ? err.message : err));
        let historyByDevice = global.get("historyByDevice") || {};
        let history = historyByDevice[key] || [];
        let receivedCountByDevice = global.get("receivedCountByDevice") || {};
        let received = receivedCountByDevice[key] || 0;
        if (typeof received !== "number" || received < history.length) {
            received = history.length;
        }
        msg.payload = {
            ok: true,
            key: key,
            count: history.length,
            received: received,
            data: history
        };
        return msg;
    }
})();
`;

const DELETE_DEVICE_FUNC =
    SHARED_HTTP +
    `
return (async function () {
    const req = msg.req || {};
    const params = req.params || {};
    const user = typeof params.user === "string" ? params.user.trim() : "";
    const device = typeof params.device === "string" ? params.device.trim() : "";
    if (!user || !device) {
        msg.statusCode = 400;
        msg.payload = { ok: false, message: "user und device sind erforderlich" };
        return msg;
    }
    const key = user + "/" + device;

    const devices = global.get("devices") || {};
    if (devices[key]) {
        delete devices[key];
        global.set("devices", devices);
    }

    const historyByDevice = global.get("historyByDevice") || {};
    delete historyByDevice[key];
    global.set("historyByDevice", historyByDevice);

    const receivedCountByDevice = global.get("receivedCountByDevice") || {};
    delete receivedCountByDevice[key];
    global.set("receivedCountByDevice", receivedCountByDevice);

    const trackingStateByDevice = global.get("trackingStateByDevice") || {};
    delete trackingStateByDevice[key];
    global.set("trackingStateByDevice", trackingStateByDevice);

    const savedPlacesByDevice = global.get("savedPlacesByDevice") || {};
    delete savedPlacesByDevice[key];
    global.set("savedPlacesByDevice", savedPlacesByDevice);

    const savedRoutesByDevice = global.get("savedRoutesByDevice") || {};
    delete savedRoutesByDevice[key];
    global.set("savedRoutesByDevice", savedRoutesByDevice);

    const lastGoodPositionByDevice = global.get("lastGoodPositionByDevice") || {};
    delete lastGoodPositionByDevice[key];
    global.set("lastGoodPositionByDevice", lastGoodPositionByDevice);

    const lastPosition = global.get("lastPosition") || null;
    if (lastPosition && lastPosition.key === key) {
        global.set("lastPosition", null);
    }

    if (influxReadOrDeleteEnabled()) {
        try {
            const pred = '_measurement="gps_point" AND device_id="' + escapeInfluxPredicateValue(key) + '"';
            await influxDeleteByPredicate(pred);
        } catch (e) {
            node.warn("Influx delete device: " + (e && e.message ? e.message : e));
        }
    }

    msg.payload = { ok: true, message: "Gerät und zugehörige Daten gelöscht", key: key };
    return msg;
})();
`;

const RESET_FUNC =
    SHARED_HTTP +
    `
return (async function () {
    const payload = msg.payload || {};
    const deviceKey = typeof payload.deviceKey === "string" ? payload.deviceKey.trim() : "";

    if (deviceKey) {
        const historyByDevice = global.get("historyByDevice") || {};
        const receivedCountByDevice = global.get("receivedCountByDevice") || {};
        const trackingStateByDevice = global.get("trackingStateByDevice") || {};
        const savedPlacesByDevice = global.get("savedPlacesByDevice") || {};
        const savedRoutesByDevice = global.get("savedRoutesByDevice") || {};

        historyByDevice[deviceKey] = [];
        receivedCountByDevice[deviceKey] = 0;
        delete trackingStateByDevice[deviceKey];
        savedPlacesByDevice[deviceKey] = [];
        savedRoutesByDevice[deviceKey] = [];

        global.set("historyByDevice", historyByDevice);
        global.set("receivedCountByDevice", receivedCountByDevice);
        global.set("trackingStateByDevice", trackingStateByDevice);
        global.set("savedPlacesByDevice", savedPlacesByDevice);
        global.set("savedRoutesByDevice", savedRoutesByDevice);
        const lastGoodPositionByDevice = global.get("lastGoodPositionByDevice") || {};
        delete lastGoodPositionByDevice[deviceKey];
        global.set("lastGoodPositionByDevice", lastGoodPositionByDevice);

        if (influxReadOrDeleteEnabled()) {
            try {
                const pred = '_measurement="gps_point" AND device_id="' + escapeInfluxPredicateValue(deviceKey) + '"';
                await influxDeleteByPredicate(pred);
            } catch (e) {
                node.warn("Influx reset device: " + (e && e.message ? e.message : e));
            }
        }

        msg.payload = {
            ok: true,
            message: "Daten fuer dieses Geraet wurden zurueckgesetzt",
            deviceKey: deviceKey
        };
        return msg;
    }

    global.set("lastPosition", null);
    global.set("history", []);
    global.set("devices", {});
    global.set("historyByDevice", {});
    global.set("receivedCount", 0);
    global.set("receivedCountByDevice", {});
    global.set("historyCleaned", true);
    global.set("trackingActive", false);
    global.set("trackingStateByDevice", {});
    global.set("missionStartPosition", null);
    global.set("returnPosition", null);
    global.set("trackingSessionId", null);
    global.set("savedPlaces", []);
    global.set("savedRoutes", []);
    global.set("savedPlacesByDevice", {});
    global.set("savedRoutesByDevice", {});
    global.set("lastGoodPositionByDevice", {});

    if (influxReadOrDeleteEnabled()) {
        try {
            await influxDeleteByPredicate('_measurement="gps_point"');
        } catch (e) {
            node.warn("Influx reset all: " + (e && e.message ? e.message : e));
        }
    }

    msg.payload = {
        ok: true,
        message: "Alle Tracking-Daten wurden zurueckgesetzt"
    };

    return msg;
})();
`;

function main() {
    const flow = JSON.parse(fs.readFileSync(flowPath, "utf8"));
    const track = flow.find((n) => n.id === TRACKING_NODE_ID);
    if (!track || track.type !== "function") {
        throw new Error("Tracking node not found");
    }
    if (!track.func.includes(INSERT_AFTER_CONST)) {
        throw new Error("Tracking func marker missing (already patched?)");
    }
    if (track.func.includes("function escapeInfluxTagValue")) {
        throw new Error("Tracking already contains Influx helpers");
    }
    track.func = track.func.replace(INSERT_AFTER_CONST, INFLUX_HELPERS);
    if (!track.func.includes(OLD_APPEND)) {
        throw new Error("OLD_APPEND block not found");
    }
    track.func = track.func.replace(OLD_APPEND, NEW_APPEND);
    if (!track.func.includes(OLD_RETURN)) {
        throw new Error("OLD_RETURN not found");
    }
    track.func = track.func.replace(OLD_RETURN, NEW_RETURN);
    track.outputs = 2;
    track.wires = [
        ["4b6db5408b2795a1", "4ac9d6d12be748e1"],
        [INFLUX_HTTP_NODE_ID]
    ];

    if (!flow.find((n) => n.id === INFLUX_HTTP_NODE_ID)) {
        const influxHttp = {
            id: INFLUX_HTTP_NODE_ID,
            type: "http request",
            z: "a055e8a06ea6ff87",
            name: "Influx write gps_point",
            method: "use",
            ret: "txt",
            paytoqs: "ignore",
            url: "",
            tls: "",
            persist: false,
            proxy: "",
            insecureHTTPParser: false,
            authType: "",
            senderr: false,
            headers: [],
            x: 820,
            y: 120,
            wires: [[]]
        };
        const idx = flow.findIndex((n) => n.id === TRACKING_NODE_ID);
        flow.splice(idx + 1, 0, influxHttp);
    }

    const hist = flow.find((n) => n.id === "5d1d2c94f93d6ba9");
    if (hist) {
        hist.func = HISTORY_FUNC;
    }

    const histDev = flow.find((n) => n.id === "3de0e2c3cfa6689f");
    if (histDev) {
        histDev.func = HISTORY_DEVICE_FUNC;
    }

    const delDev = flow.find((n) => n.id === "4f96bc13a2534bc7");
    if (delDev) {
        delDev.func = DELETE_DEVICE_FUNC;
    }

    const reset = flow.find((n) => n.id === "0b7df22564f0d767");
    if (reset) {
        reset.func = RESET_FUNC;
    }

    const influxHttpLibs = [
        { module: "http", var: "nodeHttp" },
        { module: "https", var: "nodeHttps" }
    ];
    [hist, histDev, delDev, reset].forEach((n) => {
        if (n) n.libs = influxHttpLibs;
    });

    fs.writeFileSync(flowPath, JSON.stringify(flow, null, 4), "utf8");
    const track2 = JSON.parse(fs.readFileSync(flowPath, "utf8")).find((n) => n.id === TRACKING_NODE_ID);
    fs.writeFileSync(path.join(projectRoot, "Tracking-logik"), track2.func, "utf8");
    console.log("Patched flows.json + Tracking-logik");
}

main();
