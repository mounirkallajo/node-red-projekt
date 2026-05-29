"use strict";

/**
 * Geräte-Persistenz über Influx:
 * - Tracking schreibt device_registry-Zeile bei gültigem GPS (mit oder ohne neuen History-Punkt).
 * - GET /api/devices (Influx aktiv): alle `device_id` aus `device_registry`; Positionen aus `gps_point` / RAM.
 *   Ohne gültige Koordinaten: Platzhalter (lat/lon null, receivedAt 0), damit Offline in der Liste sichtbar ist.
 *   Nach Deploy: `__trackingSessionEpoch` (beim Start der Tracking-Logik) + Clamp in `apiForNewDevice` setzt ältere `receivedAt` auf 0, bis ein neuer GPS-Fix mit Empfangszeit ≥ Epoche kommt — UI nicht mehr fälschlich „Verbunden“.
 * - DELETE /api/devices löscht gps_point, saved_*, device_registry (siehe deleteDeviceData).
 */
const fs = require("fs");
const path = require("path");

const flowPath = path.join(__dirname, "..", "flows.json");
const trackingLogikPath = path.join(__dirname, "..", "Tracking-logik");

const httpLibs = [
    { module: "http", var: "nodeHttp" },
    { module: "https", var: "nodeHttps" }
];

function getNode(flow, name) {
    const n = flow.find((x) => x.type === "function" && x.name === name);
    if (!n) throw new Error('Function node not found: "' + name + '"');
    return n;
}

function deleteSharedPrefixFromFlow(flow) {
    const dd = getNode(flow, "deleteDeviceData");
    const marker = "return (async function () {";
    const idx = dd.func.indexOf(marker);
    if (idx < 0) throw new Error("deleteDeviceData: missing async IIFE marker");
    return dd.func.slice(0, idx).trimEnd();
}

const API_DEVICES_FUNC_TAIL = `
function coordinatesLookValidForBoatApi(p) {
    if (!p || typeof p !== "object") return false;
    if (typeof p.lat !== "number" || typeof p.lon !== "number") return false;
    if (!Number.isFinite(p.lat) || !Number.isFinite(p.lon)) return false;
    if (Math.abs(p.lat) < 1e-7 && Math.abs(p.lon) < 1e-7) return false;
    if (Math.abs(p.lat) > 90 || Math.abs(p.lon) > 180) return false;
    return true;
}

function buildFluxLastGpsPerDevice() {
    const bucket = env.get("INFLUX_BUCKET");
    const bq = escapeFluxDoubleQuotes(bucket);
    const lines = [
        'from(bucket: "' + bq + '")',
        '  |> range(start: -100y)',
        '  |> filter(fn: (r) => r["_measurement"] == "gps_point")',
        '  |> filter(fn: (r) => r["_field"] == "lat" or r["_field"] == "lon" or r["_field"] == "accuracy" or r["_field"] == "speed" or r["_field"] == "heading" or r["_field"] == "battery")',
        '  |> pivot(rowKey: ["_time", "device_id"], columnKey: ["_field"], valueColumn: "_value")',
        '  |> group(columns: ["device_id"])',
        '  |> sort(columns: ["_time"])',
        '  |> last(column: "lat")'
    ];
    return lines.join(String.fromCharCode(10));
}

function buildFluxLastDeviceRegistryPerDevice() {
    const bucket = env.get("INFLUX_BUCKET");
    const bq = escapeFluxDoubleQuotes(bucket);
    const lines = [
        'from(bucket: "' + bq + '")',
        '  |> range(start: -100y)',
        '  |> filter(fn: (r) => r["_measurement"] == "device_registry")',
        '  |> filter(fn: (r) => r["_field"] == "last_seen_ms")',
        '  |> group(columns: ["device_id"])',
        '  |> sort(columns: ["_time"])',
        '  |> last()'
    ];
    return lines.join(String.fromCharCode(10));
}

function mergeDevicesSessionFallback() {
    const sessionEpoch = Number(global.get("__trackingSessionEpoch"));
    const deviceMap = global.get("devices") || {};
    const merged = {};
    if (Number.isFinite(sessionEpoch) && sessionEpoch > 0) {
        Object.keys(deviceMap).forEach(function (k) {
            const entry = deviceMap[k];
            if (!entry || typeof entry !== "object") {
                return;
            }
            const receivedAt = Number(entry.receivedAt);
            if (!Number.isFinite(receivedAt) || receivedAt < sessionEpoch) {
                return;
            }
            if (coordinatesLookValidForBoatApi(entry)) {
                merged[k] = entry;
            }
        });
    }
    return merged;
}

return (async function () {
    if (!influxReadOrDeleteEnabled()) {
        const merged = mergeDevicesSessionFallback();
        msg.payload = {
            ok: true,
            count: Object.keys(merged).length,
            data: merged
        };
        return msg;
    }
    try {
        let bootstrapEpoch = Number(global.get("__trackingSessionEpoch"));
        if (!Number.isFinite(bootstrapEpoch) || bootstrapEpoch <= 0) {
            bootstrapEpoch = Date.now();
            global.set("__trackingSessionEpoch", bootstrapEpoch);
        }
        let base = String(env.get("INFLUX_URL"));
        while (base.endsWith("/")) base = base.slice(0, -1);
        const org = env.get("INFLUX_ORG");
        const token = env.get("INFLUX_TOKEN");
        const queryUrl = base + "/api/v2/query?org=" + encodeURIComponent(org);
        const hdr = { Authorization: "Token " + token, Accept: "application/csv" };
        const fluxGps = buildFluxLastGpsPerDevice();
        const fluxRegistry = buildFluxLastDeviceRegistryPerDevice();
        const csvGps = await httpPostJson(queryUrl, { query: fluxGps, type: "flux" }, hdr);
        const csvRegistry = await httpPostJson(queryUrl, { query: fluxRegistry, type: "flux" }, hdr);
        const posByKey = {};
        const rowsGps = parseInfluxAnnotatedCsv(csvGps);
        for (let gi = 0; gi < rowsGps.length; gi++) {
            const pt = mapInfluxRowToPoint(rowsGps[gi]);
            if (pt && pt.key) {
                posByKey[pt.key] = pt;
            }
        }
        const keySet = {};
        const rowsReg = parseInfluxAnnotatedCsv(csvRegistry);
        for (let ri = 0; ri < rowsReg.length; ri++) {
            const dk = rowsReg[ri].device_id || "";
            if (dk) {
                keySet[dk] = true;
            }
        }
        const deviceMap = global.get("devices") || {};
        const lastPosByDev = global.get("lastPositionByDevice") || {};
        const merged = {};
        Object.keys(keySet).forEach(function (k) {
            let entry = null;
            const live = deviceMap[k];
            if (live && coordinatesLookValidForBoatApi(live)) {
                entry = live;
            }
            if (!entry || !coordinatesLookValidForBoatApi(entry)) {
                const lp = lastPosByDev[k];
                if (lp && coordinatesLookValidForBoatApi(lp)) {
                    entry = Object.assign({}, lp, { key: k });
                }
            }
            if (!entry || !coordinatesLookValidForBoatApi(entry)) {
                const infl = posByKey[k];
                if (infl) {
                    entry = Object.assign({}, infl, { key: k });
                }
            }
            if (entry && coordinatesLookValidForBoatApi(entry)) {
                merged[k] = entry;
            } else {
                const slash = k.indexOf("/");
                const userPart = slash > 0 ? k.slice(0, slash) : "";
                const devicePart = slash > 0 ? k.slice(slash + 1) : k;
                merged[k] = {
                    key: k,
                    user: userPart,
                    device: devicePart,
                    lat: null,
                    lon: null,
                    receivedAt: 0,
                    timestamp: 0
                };
            }
        });
        const epochClamp = Number(global.get("__trackingSessionEpoch"));
        if (Number.isFinite(epochClamp) && epochClamp > 0) {
            Object.keys(merged).forEach(function (k) {
                const e = merged[k];
                if (!e || typeof e !== "object") {
                    return;
                }
                const ra = Number(e.receivedAt);
                if (!Number.isFinite(ra) || ra < epochClamp) {
                    e.receivedAt = 0;
                }
            });
        }
        msg.payload = {
            ok: true,
            count: Object.keys(merged).length,
            data: merged
        };
        return msg;
    } catch (err) {
        node.warn("Influx devices list: " + (err && err.message ? err.message : err));
        const merged = mergeDevicesSessionFallback();
        msg.payload = {
            ok: true,
            count: Object.keys(merged).length,
            data: merged
        };
        return msg;
    }
})();
`.trim();

const LAST_POSITION_FUNC = `
const req = msg.req || {};
const query = req.query || {};
let rawKey = typeof query.deviceKey === "string" ? query.deviceKey.trim() : "";
if (!rawKey && typeof query.user === "string" && typeof query.device === "string") {
    const u = query.user.trim();
    const d = query.device.trim();
    if (u && d) rawKey = u + "/" + d;
}
let bootstrapEpochLastPos = Number(global.get("__trackingSessionEpoch"));
if (!Number.isFinite(bootstrapEpochLastPos) || bootstrapEpochLastPos <= 0) {
    bootstrapEpochLastPos = Date.now();
    global.set("__trackingSessionEpoch", bootstrapEpochLastPos);
}
const devices = global.get("devices") || {};
const lastPositionByDevice = global.get("lastPositionByDevice") || {};
let data = null;
if (rawKey) {
    data = devices[rawKey] || lastPositionByDevice[rawKey] || null;
} else {
    data = global.get("lastPosition") || null;
}
function __trackingSessionEpochClampLastPosition(entry) {
    if (!entry || typeof entry !== "object") {
        return entry;
    }
    const epochClamp = Number(global.get("__trackingSessionEpoch"));
    if (!Number.isFinite(epochClamp) || epochClamp <= 0) {
        return entry;
    }
    const ra = Number(entry.receivedAt);
    if (!Number.isFinite(ra) || ra < epochClamp) {
        const copy = Object.assign({}, entry);
        copy.receivedAt = 0;
        return copy;
    }
    return entry;
}
data = __trackingSessionEpochClampLastPosition(data);
msg.payload = { ok: true, data: data };
return msg;
`.trim();

function patchLastPositionEpochClamp(flow) {
    const n = flow.find((x) => x.type === "function" && x.name === "lastPosition");
    if (!n) {
        throw new Error("flows.json: lastPosition function node not found");
    }
    if (n.func.includes("__trackingSessionEpochClampLastPosition")) {
        return;
    }
    n.func = LAST_POSITION_FUNC;
}

function patchApiForNewDevice(flow) {
    const n = getNode(flow, "apiForNewDevice");
    const hasRegistryAllowlist = n.func.includes("buildFluxLastDeviceRegistryPerDevice");
    const hasPivotLastLatFix = n.func.includes('last(column: "lat")');
    const hasOfflinePlaceholder = n.func.includes("userPart") && n.func.includes("lat: null");
    const mqttFilterRemoved = !n.func.includes("DEVICE_LIST_MQTT_FRESH_MAX_AGE_MS");
    const hasEpochClamp = n.func.includes("epochClamp");
    const hasBootstrapEpoch = n.func.includes("bootstrapEpoch");
    if (hasRegistryAllowlist && hasPivotLastLatFix && hasOfflinePlaceholder && mqttFilterRemoved && hasEpochClamp && hasBootstrapEpoch) {
        return;
    }
    const prefix = deleteSharedPrefixFromFlow(flow);
    n.func = prefix + "\n\n" + API_DEVICES_FUNC_TAIL;
    n.libs = httpLibs;
}

function patchMapInfluxRowToPointTimestampFallback(flow) {
    const oldTimestamp = "timestamp: Number.isFinite(ts) ? ts : Date.now(),";
    const newTimestamp = "timestamp: Number.isFinite(ts) && ts > 0 ? ts : 0,";
    const oldReceived = "receivedAt: Number.isFinite(ts) ? ts : Date.now()";
    const newReceived = "receivedAt: Number.isFinite(ts) && ts > 0 ? ts : 0";
    for (let flowIndex = 0; flowIndex < flow.length; flowIndex++) {
        const flowNode = flow[flowIndex];
        if (flowNode.type !== "function" || typeof flowNode.func !== "string") {
            continue;
        }
        if (flowNode.func.includes(oldReceived)) {
            flowNode.func = flowNode.func.split(oldReceived).join(newReceived);
        }
        if (flowNode.func.includes(oldTimestamp)) {
            flowNode.func = flowNode.func.split(oldTimestamp).join(newTimestamp);
        }
    }
}

const DEPLOY_CLEAR_DEVICE_LIST_NODE_IDS = new Set(["e7d3a1c004f14298", "e7d3a1c004f14299"]);

function removeDeployClearDeviceListChain(flow) {
    for (let flowIndex = flow.length - 1; flowIndex >= 0; flowIndex -= 1) {
        const flowNode = flow[flowIndex];
        if (flowNode && DEPLOY_CLEAR_DEVICE_LIST_NODE_IDS.has(flowNode.id)) {
            flow.splice(flowIndex, 1);
        }
    }
}

function patchDeleteDeviceDataRecentSpeeds(flow) {
    const n = getNode(flow, "deleteDeviceData");
    if (n.func.includes("delete recentSpeedsByKey[key]")) {
        return;
    }
    const marker =
        '    const trackingStateByDevice = global.get("trackingStateByDevice") || {};\n' +
        "    delete trackingStateByDevice[key];\n" +
        '    global.set("trackingStateByDevice", trackingStateByDevice);\n\n';
    const old = marker + '    const savedPlacesByDevice = global.get("savedPlacesByDevice") || {};';
    const neu =
        marker +
        '    const recentSpeedsByKey = global.get("recentSpeedsByKey") || {};\n' +
        "    delete recentSpeedsByKey[key];\n" +
        '    global.set("recentSpeedsByKey", recentSpeedsByKey);\n\n' +
        '    const savedPlacesByDevice = global.get("savedPlacesByDevice") || {};';
    if (!n.func.includes(old)) {
        throw new Error("deleteDeviceData: expected trackingState block before savedPlaces");
    }
    n.func = n.func.split(old).join(neu);
}

function patchDeleteDeviceData(flow) {
    const n = getNode(flow, "deleteDeviceData");
    const needle = 'await influxDeleteByPredicate(\'_measurement="saved_route" AND device_id="\' + escapeInfluxPredicateValue(key) + \'"\');';
    if (!n.func.includes(needle)) {
        throw new Error("deleteDeviceData: expected saved_route delete line");
    }
    if (n.func.includes('device_registry')) {
        return;
    }
    const insert =
        needle +
        '\n            await influxDeleteByPredicate(\'_measurement="device_registry" AND device_id="\' + escapeInfluxPredicateValue(key) + \'"\');';
    n.func = n.func.split(needle).join(insert);
}

function patchTrackingLogikFlow(flow) {
    const n = getNode(flow, "Tracking-Logik");
    if (n.func.includes("buildDeviceRegistryLineProtocol")) {
        return;
    }
    const insAfter = "function buildInfluxWriteMessage(line) {";
    const idx = n.func.indexOf(insAfter);
    if (idx < 0) throw new Error("Tracking-Logik: buildInfluxWriteMessage not found");
    const endBuildWrite = n.func.indexOf("}\n\nfunction asNumber", idx);
    if (endBuildWrite < 0) throw new Error("Tracking-Logik: end of buildInfluxWriteMessage not found");
    const insertPos = endBuildWrite + 1;
    const registryFn =
        "\nfunction buildDeviceRegistryLineProtocol(deviceId, lastSeenMs) {\n" +
        "    if (!deviceId) return null;\n" +
        "    const tag = escapeInfluxTagValue(deviceId);\n" +
        "    const ms = Math.floor(Number(lastSeenMs));\n" +
        "    const safeMs = Number.isFinite(ms) ? ms : Date.now();\n" +
        "    const tsNs = Math.round(Date.now() * 1000000);\n" +
        '    return "device_registry,device_id=" + tag + " last_seen_ms=" + safeMs + "i " + tsNs;\n' +
        "}\n";
    n.func = n.func.slice(0, insertPos) + registryFn + n.func.slice(insertPos);

    const oldBlock =
        "let influxSecondMsg = null;\n" +
        "if (trackingIsActiveForDevice && gpsFixOk && stabilizedPosition.lat !== null && stabilizedPosition.lon !== null) {\n" +
        "    let recentSpeedsByKey = global.get(\"recentSpeedsByKey\") || {};\n" +
        "    const recentDeviceSpeedsMps = Array.isArray(recentSpeedsByKey[key]) ? recentSpeedsByKey[key] : [];\n" +
        "    let deviceHistory = historyByDevice[key] || [];\n" +
        "    const deviceAppendResult = appendToHistory(deviceHistory, stabilizedPosition, recentDeviceSpeedsMps);\n" +
        "    historyByDevice[key] = deviceAppendResult.history;\n" +
        "    recentSpeedsByKey[key] = deviceAppendResult.recentSpeedsMps;\n" +
        "    global.set(\"recentSpeedsByKey\", recentSpeedsByKey);\n" +
        "    if (deviceAppendResult.added && influxWriteEnabled()) {\n" +
        "        const lp = buildInfluxGpsLineProtocol(key, stabilizedPosition);\n" +
        "        influxSecondMsg = buildInfluxWriteMessage(lp);\n" +
        "    }\n" +
        "}";
    const newBlock =
        "let influxSecondMsg = null;\n" +
        "if (influxWriteEnabled() && gpsFixOk && stabilizedPosition.lat !== null && stabilizedPosition.lon !== null) {\n" +
        "    const regLine = buildDeviceRegistryLineProtocol(key, Date.now());\n" +
        "    let gpsLine = null;\n" +
        "    if (trackingIsActiveForDevice) {\n" +
        "        let recentSpeedsByKey = global.get(\"recentSpeedsByKey\") || {};\n" +
        "        const recentDeviceSpeedsMps = Array.isArray(recentSpeedsByKey[key]) ? recentSpeedsByKey[key] : [];\n" +
        "        let deviceHistory = historyByDevice[key] || [];\n" +
        "        const deviceAppendResult = appendToHistory(deviceHistory, stabilizedPosition, recentDeviceSpeedsMps);\n" +
        "        historyByDevice[key] = deviceAppendResult.history;\n" +
        "        recentSpeedsByKey[key] = deviceAppendResult.recentSpeedsMps;\n" +
        "        global.set(\"recentSpeedsByKey\", recentSpeedsByKey);\n" +
        "        if (deviceAppendResult.added) {\n" +
        "            gpsLine = buildInfluxGpsLineProtocol(key, stabilizedPosition);\n" +
        "        }\n" +
        "    }\n" +
        "    if (gpsLine) {\n" +
        '        influxSecondMsg = buildInfluxWriteMessage(gpsLine + "\\n" + regLine);\n' +
        "    } else {\n" +
        "        influxSecondMsg = buildInfluxWriteMessage(regLine);\n" +
        "    }\n" +
        "}";
    if (!n.func.includes(oldBlock)) {
        throw new Error("Tracking-Logik: expected old influxSecondMsg block not found");
    }
    n.func = n.func.split(oldBlock).join(newBlock);
}

function patchTrackingLogikFile() {
    let txt = fs.readFileSync(trackingLogikPath, "utf8");
    if (txt.includes("buildDeviceRegistryLineProtocol")) {
        return;
    }
    const insMarker = "function buildInfluxWriteMessage(line) {";
    const i0 = txt.indexOf(insMarker);
    if (i0 < 0) throw new Error("Tracking-logik file: buildInfluxWriteMessage not found");
    const i1 = txt.indexOf("}\n\nfunction asNumber", i0);
    if (i1 < 0) throw new Error("Tracking-logik file: asNumber marker not found");
    const registryFn =
        "\nfunction buildDeviceRegistryLineProtocol(deviceId, lastSeenMs) {\n" +
        "    if (!deviceId) return null;\n" +
        "    const tag = escapeInfluxTagValue(deviceId);\n" +
        "    const ms = Math.floor(Number(lastSeenMs));\n" +
        "    const safeMs = Number.isFinite(ms) ? ms : Date.now();\n" +
        "    const tsNs = Math.round(Date.now() * 1000000);\n" +
        '    return "device_registry,device_id=" + tag + " last_seen_ms=" + safeMs + "i " + tsNs;\n' +
        "}\n";
    txt = txt.slice(0, i1 + 1) + registryFn + txt.slice(i1 + 1);

    const oldBlock =
        "let influxSecondMsg = null;\n" +
        "if (trackingIsActiveForDevice && gpsFixOk && stabilizedPosition.lat !== null && stabilizedPosition.lon !== null) {\n" +
        "    let recentSpeedsByKey = global.get(\"recentSpeedsByKey\") || {};\n" +
        "    const recentDeviceSpeedsMps = Array.isArray(recentSpeedsByKey[key]) ? recentSpeedsByKey[key] : [];\n" +
        "    let deviceHistory = historyByDevice[key] || [];\n" +
        "    const deviceAppendResult = appendToHistory(deviceHistory, stabilizedPosition, recentDeviceSpeedsMps);\n" +
        "    historyByDevice[key] = deviceAppendResult.history;\n" +
        "    recentSpeedsByKey[key] = deviceAppendResult.recentSpeedsMps;\n" +
        "    global.set(\"recentSpeedsByKey\", recentSpeedsByKey);\n" +
        "    if (deviceAppendResult.added && influxWriteEnabled()) {\n" +
        "        const lp = buildInfluxGpsLineProtocol(key, stabilizedPosition);\n" +
        "        influxSecondMsg = buildInfluxWriteMessage(lp);\n" +
        "    }\n" +
        "}";
    const newBlock =
        "let influxSecondMsg = null;\n" +
        "if (influxWriteEnabled() && gpsFixOk && stabilizedPosition.lat !== null && stabilizedPosition.lon !== null) {\n" +
        "    const regLine = buildDeviceRegistryLineProtocol(key, Date.now());\n" +
        "    let gpsLine = null;\n" +
        "    if (trackingIsActiveForDevice) {\n" +
        "        let recentSpeedsByKey = global.get(\"recentSpeedsByKey\") || {};\n" +
        "        const recentDeviceSpeedsMps = Array.isArray(recentSpeedsByKey[key]) ? recentSpeedsByKey[key] : [];\n" +
        "        let deviceHistory = historyByDevice[key] || [];\n" +
        "        const deviceAppendResult = appendToHistory(deviceHistory, stabilizedPosition, recentDeviceSpeedsMps);\n" +
        "        historyByDevice[key] = deviceAppendResult.history;\n" +
        "        recentSpeedsByKey[key] = deviceAppendResult.recentSpeedsMps;\n" +
        "        global.set(\"recentSpeedsByKey\", recentSpeedsByKey);\n" +
        "        if (deviceAppendResult.added) {\n" +
        "            gpsLine = buildInfluxGpsLineProtocol(key, stabilizedPosition);\n" +
        "        }\n" +
        "    }\n" +
        "    if (gpsLine) {\n" +
        "        influxSecondMsg = buildInfluxWriteMessage(gpsLine + \"\\n\" + regLine);\n" +
        "    } else {\n" +
        "        influxSecondMsg = buildInfluxWriteMessage(regLine);\n" +
        "    }\n" +
        "}";
    if (!txt.includes(oldBlock)) {
        throw new Error("Tracking-logik file: old influx block not found");
    }
    txt = txt.split(oldBlock).join(newBlock);
    fs.writeFileSync(trackingLogikPath, txt);
}

function main() {
    const flow = JSON.parse(fs.readFileSync(flowPath, "utf8"));
    patchApiForNewDevice(flow);
    patchMapInfluxRowToPointTimestampFallback(flow);
    patchDeleteDeviceData(flow);
    patchDeleteDeviceDataRecentSpeeds(flow);
    patchTrackingLogikFlow(flow);
    patchTrackingLogikFile();
    removeDeployClearDeviceListChain(flow);
    patchLastPositionEpochClamp(flow);
    fs.writeFileSync(flowPath, JSON.stringify(flow));
    JSON.parse(fs.readFileSync(flowPath, "utf8"));
    console.log("OK: device registry + persistent devices API (flows.json, Tracking-logik).");
}

main();
