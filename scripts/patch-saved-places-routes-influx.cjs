/**
 * Persistiert gespeicherte Orte (saved_place) und Routen (saved_route) in Influx:
 * Schreiben bei POST, Lesen per Flux bei GET (Merge mit Globals), Delete-API + reset/device löschen mit.
 * Erwartet gültiges flows.json im Projektroot.
 */
"use strict";

const fs = require("fs");
const path = require("path");

const flowPath = path.join(__dirname, "..", "flows.json");

/** Influx-Schreiben von API-Tab (Orte/Routen); eigener http request auf API-Tab, damit kein Quer-Tab-Wire nötig ist. */
const INFLUX_WRITE_LINE_PROTOCOL_NODE_ID = "a8e4f2c19d7b0a41";
const API_TAB_ID = "ce1a1a16f9ca5836";
const INFLUX_WRITE_TRACKING_TAB_NODE_ID = "c7a9bf120e841d01";

function ensureApiInfluxWriteNode(flow) {
    if (flow.some((n) => n.id === INFLUX_WRITE_LINE_PROTOCOL_NODE_ID)) {
        return;
    }
    const ref = flow.find((n) => n.id === INFLUX_WRITE_TRACKING_TAB_NODE_ID);
    if (!ref || ref.type !== "http request") {
        throw new Error("Reference Influx http request node " + INFLUX_WRITE_TRACKING_TAB_NODE_ID + " not found");
    }
    flow.push({
        id: INFLUX_WRITE_LINE_PROTOCOL_NODE_ID,
        type: "http request",
        z: API_TAB_ID,
        name: "Influx write line protocol",
        method: ref.method || "use",
        ret: ref.ret || "txt",
        paytoqs: ref.paytoqs || "ignore",
        url: "",
        tls: ref.tls || "",
        persist: !!ref.persist,
        proxy: ref.proxy || "",
        insecureHTTPParser: !!ref.insecureHTTPParser,
        authType: ref.authType || "",
        senderr: !!ref.senderr,
        headers: Array.isArray(ref.headers) ? ref.headers : [],
        x: 780,
        y: 480,
        wires: [[]]
    });
}

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

function querySharedPrefixFromFlow(flow) {
    const hist = getNode(flow, "history");
    const marker = "\nfunction mapInfluxRowToPoint";
    const idx = hist.func.indexOf(marker);
    if (idx < 0) throw new Error("history: missing mapInfluxRowToPoint marker");
    return hist.func.slice(0, idx).trimEnd();
}

function trackingInfluxWriteHelpers(flow) {
    const tf = getNode(flow, "Tracking-Logik").func;
    const a = tf.indexOf("function escapeInfluxTagValue");
    const b = tf.indexOf("function asNumber");
    if (a < 0 || b < 0) {
        throw new Error("Tracking-Logik: cannot slice Influx write helpers (markers missing)");
    }
    return tf.slice(a, b).trimEnd();
}

function influxFieldStringEscaperForNrFlow() {
    const BS = "\\";
    return [
        "function escapeInfluxFieldString(s) {",
        "    return String(s)",
        `        .split("${BS}${BS}").join("${BS}${BS}${BS}${BS}")`,
        `        .split('"').join('${BS}"');`,
        "}"
    ].join("\n");
}

/** Gleiche Logik wie GET /api/places: vor DELETE aus Influx mergen, damit Löschen nach Neustart (leere Globals) funktioniert. */
const SAVED_PLACES_FLUX_MERGE_FOR_DELETE = `
function buildFluxSavedPlaces(deviceKeyFilter) {
    const bucket = env.get("INFLUX_BUCKET");
    const bq = escapeFluxDoubleQuotes(bucket);
    const dk = escapeFluxDoubleQuotes(deviceKeyFilter);
    const lines = [
        'from(bucket: "' + bq + '")',
        '  |> range(start: -100y)',
        '  |> filter(fn: (r) => r["_measurement"] == "saved_place")',
        '  |> filter(fn: (r) => r["device_id"] == "' + dk + '")',
        '  |> filter(fn: (r) => r["_field"] == "name" or r["_field"] == "lat" or r["_field"] == "lon" or r["_field"] == "color")',
        '  |> pivot(rowKey: ["_time", "device_id", "place_id"], columnKey: ["_field"], valueColumn: "_value")',
        '  |> group()',
        '  |> sort(columns: ["_time"])'
    ];
    return lines.join(String.fromCharCode(10));
}
function mapInfluxRowToSavedPlace(row) {
    const pid = row.place_id || "";
    if (!pid) return null;
    const lat = parseFloat(row.lat);
    const lon = parseFloat(row.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    const ts = Date.parse(row._time || "");
    return {
        id: pid,
        name: typeof row.name === "string" ? row.name : String(row.name || ""),
        lat: lat,
        lon: lon,
        color: typeof row.color === "string" ? row.color : String(row.color || ""),
        timestamp: Number.isFinite(ts) ? ts : Date.now()
    };
}
function mergePlacesByIdPreferInflux(influxPlaces, globalPlaces) {
    const map = {};
    (globalPlaces || []).forEach(function (p) {
        if (p && p.id) map[p.id] = p;
    });
    (influxPlaces || []).forEach(function (p) {
        if (p && p.id) map[p.id] = p;
    });
    const out = Object.keys(map).map(function (k) {
        return map[k];
    });
    out.sort(function (a, b) {
        return (b.timestamp || 0) - (a.timestamp || 0);
    });
    return out;
}
async function loadMergedSavedPlacesForBucket(bucket, ramPlaces) {
    let savedPlaces = Array.isArray(ramPlaces) ? ramPlaces.slice() : [];
    if (!influxReadOrDeleteEnabled()) return savedPlaces;
    try {
        let base = String(env.get("INFLUX_URL"));
        while (base.endsWith("/")) base = base.slice(0, -1);
        const org = env.get("INFLUX_ORG");
        const token = env.get("INFLUX_TOKEN");
        const flux = buildFluxSavedPlaces(bucket);
        const queryUrl = base + "/api/v2/query?org=" + encodeURIComponent(org);
        const csvText = await httpPostJson(
            queryUrl,
            { query: flux, type: "flux" },
            {
                Authorization: "Token " + token,
                Accept: "application/csv"
            }
        );
        const rows = parseInfluxAnnotatedCsv(csvText);
        const fromInflux = [];
        for (let mergeIdx = 0; mergeIdx < rows.length; mergeIdx++) {
            const pl = mapInfluxRowToSavedPlace(rows[mergeIdx]);
            if (pl) fromInflux.push(pl);
        }
        return mergePlacesByIdPreferInflux(fromInflux, savedPlaces);
    } catch (err) {
        node.warn("Influx merge places before delete: " + (err && err.message ? err.message : err));
        return savedPlaces;
    }
}
`.trim();

const SAVED_ROUTES_FLUX_MERGE_FOR_DELETE = `
function buildFluxSavedRoutes(deviceKeyFilter) {
    const bucket = env.get("INFLUX_BUCKET");
    const bq = escapeFluxDoubleQuotes(bucket);
    const dk = escapeFluxDoubleQuotes(deviceKeyFilter);
    const lines = [
        'from(bucket: "' + bq + '")',
        '  |> range(start: -100y)',
        '  |> filter(fn: (r) => r["_measurement"] == "saved_route")',
        '  |> filter(fn: (r) => r["device_id"] == "' + dk + '")',
        '  |> filter(fn: (r) => r["_field"] == "name" or r["_field"] == "color" or r["_field"] == "point_count" or r["_field"] == "points_json")',
        '  |> pivot(rowKey: ["_time", "device_id", "route_id"], columnKey: ["_field"], valueColumn: "_value")',
        '  |> group()',
        '  |> sort(columns: ["_time"])'
    ];
    return lines.join(String.fromCharCode(10));
}
function mapInfluxRowToSavedRoute(row) {
    const rid = row.route_id || "";
    if (!rid) return null;
    let points = [];
    try {
        const raw = row.points_json;
        if (raw) points = JSON.parse(String(raw));
    } catch (rj) {
        points = [];
    }
    if (!Array.isArray(points)) points = [];
    const pc = parseInt(row.point_count, 10);
    const ts = Date.parse(row._time || "");
    return {
        id: rid,
        name: typeof row.name === "string" ? row.name : String(row.name || ""),
        color: typeof row.color === "string" ? row.color : String(row.color || ""),
        points: points,
        pointCount: Number.isFinite(pc) ? pc : points.length,
        timestamp: Number.isFinite(ts) ? ts : Date.now()
    };
}
function dedupeInfluxSavedRoutesFromRows(rows) {
    const mapped = [];
    for (let dri = 0; dri < rows.length; dri++) {
        const rt = mapInfluxRowToSavedRoute(rows[dri]);
        if (rt) mapped.push(rt);
    }
    const byId = {};
    mapped.forEach(function (r) {
        const prev = byId[r.id];
        const len = Array.isArray(r.points) ? r.points.length : 0;
        if (!prev) {
            byId[r.id] = r;
            return;
        }
        const prevLen = Array.isArray(prev.points) ? prev.points.length : 0;
        if (len > prevLen) {
            byId[r.id] = r;
        } else if (len === prevLen && (r.timestamp || 0) > (prev.timestamp || 0)) {
            byId[r.id] = r;
        }
    });
    return Object.keys(byId).map(function (k) {
        return byId[k];
    });
}
function mergeRoutesByIdPreferInflux(influxRoutes, globalRoutes) {
    const map = {};
    (globalRoutes || []).forEach(function (r) {
        if (r && r.id) map[r.id] = r;
    });
    (influxRoutes || []).forEach(function (r) {
        if (r && r.id) map[r.id] = r;
    });
    const out = Object.keys(map).map(function (k) {
        return map[k];
    });
    out.sort(function (a, b) {
        return (b.timestamp || 0) - (a.timestamp || 0);
    });
    return out;
}
async function loadMergedSavedRoutesForBucket(bucket, ramRoutes) {
    let savedRoutes = Array.isArray(ramRoutes) ? ramRoutes.slice() : [];
    if (!influxReadOrDeleteEnabled()) return savedRoutes;
    try {
        let base = String(env.get("INFLUX_URL"));
        while (base.endsWith("/")) base = base.slice(0, -1);
        const org = env.get("INFLUX_ORG");
        const token = env.get("INFLUX_TOKEN");
        const flux = buildFluxSavedRoutes(bucket);
        const queryUrl = base + "/api/v2/query?org=" + encodeURIComponent(org);
        const csvText = await httpPostJson(
            queryUrl,
            { query: flux, type: "flux" },
            {
                Authorization: "Token " + token,
                Accept: "application/csv"
            }
        );
        const rows = parseInfluxAnnotatedCsv(csvText);
        const fromInflux = dedupeInfluxSavedRoutesFromRows(rows);
        return mergeRoutesByIdPreferInflux(fromInflux, savedRoutes);
    } catch (err) {
        node.warn("Influx merge routes before delete: " + (err && err.message ? err.message : err));
        return savedRoutes;
    }
}
`.trim();

function buildListSavedPlaces(queryHead) {
    return (
        queryHead +
        `
function buildFluxSavedPlaces(deviceKeyFilter) {
    const bucket = env.get("INFLUX_BUCKET");
    const bq = escapeFluxDoubleQuotes(bucket);
    const dk = escapeFluxDoubleQuotes(deviceKeyFilter);
    const lines = [
        'from(bucket: "' + bq + '")',
        '  |> range(start: -100y)',
        '  |> filter(fn: (r) => r["_measurement"] == "saved_place")',
        '  |> filter(fn: (r) => r["device_id"] == "' + dk + '")',
        '  |> filter(fn: (r) => r["_field"] == "name" or r["_field"] == "lat" or r["_field"] == "lon" or r["_field"] == "color")',
        '  |> pivot(rowKey: ["_time", "device_id", "place_id"], columnKey: ["_field"], valueColumn: "_value")',
        '  |> group()',
        '  |> sort(columns: ["_time"])'
    ];
    return lines.join(String.fromCharCode(10));
}
function mapInfluxRowToSavedPlace(row) {
    const pid = row.place_id || "";
    if (!pid) return null;
    const lat = parseFloat(row.lat);
    const lon = parseFloat(row.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    const ts = Date.parse(row._time || "");
    return {
        id: pid,
        name: typeof row.name === "string" ? row.name : String(row.name || ""),
        lat: lat,
        lon: lon,
        color: typeof row.color === "string" ? row.color : String(row.color || ""),
        timestamp: Number.isFinite(ts) ? ts : Date.now()
    };
}
function mergePlacesByIdPreferInflux(influxPlaces, globalPlaces) {
    const map = {};
    (globalPlaces || []).forEach(function (p) {
        if (p && p.id) map[p.id] = p;
    });
    (influxPlaces || []).forEach(function (p) {
        if (p && p.id) map[p.id] = p;
    });
    const out = Object.keys(map).map(function (k) {
        return map[k];
    });
    out.sort(function (a, b) {
        return (b.timestamp || 0) - (a.timestamp || 0);
    });
    return out;
}
return (async function () {
    let deviceKey = "";
    try {
        if (msg.req && msg.req.query && typeof msg.req.query.deviceKey === "string" && msg.req.query.deviceKey.trim()) {
            deviceKey = msg.req.query.deviceKey.trim();
        }
    } catch (e) {}
    const bucket = deviceKey || "__default__";
    const savedPlacesByDevice = global.get("savedPlacesByDevice") || {};
    let savedPlaces = savedPlacesByDevice[bucket];
    if (!Array.isArray(savedPlaces)) savedPlaces = [];
    if (bucket === "__default__" && savedPlaces.length === 0) {
        const leg = global.get("savedPlaces") || [];
        if (leg.length) savedPlaces = leg.slice();
    }

    if (!influxReadOrDeleteEnabled()) {
        msg.payload = {
            ok: true,
            count: savedPlaces.length,
            data: savedPlaces
        };
        return msg;
    }
    try {
        let base = String(env.get("INFLUX_URL"));
        while (base.endsWith("/")) base = base.slice(0, -1);
        const org = env.get("INFLUX_ORG");
        const token = env.get("INFLUX_TOKEN");
        const flux = buildFluxSavedPlaces(bucket);
        const queryUrl = base + "/api/v2/query?org=" + encodeURIComponent(org);
        const csvText = await httpPostJson(
            queryUrl,
            { query: flux, type: "flux" },
            {
                Authorization: "Token " + token,
                Accept: "application/csv"
            }
        );
        const rows = parseInfluxAnnotatedCsv(csvText);
        const fromInflux = [];
        for (let i = 0; i < rows.length; i++) {
            const pl = mapInfluxRowToSavedPlace(rows[i]);
            if (pl) fromInflux.push(pl);
        }
        const merged = mergePlacesByIdPreferInflux(fromInflux, savedPlaces);
        msg.payload = {
            ok: true,
            count: merged.length,
            data: merged
        };
        return msg;
    } catch (err) {
        node.warn("Influx list places: " + (err && err.message ? err.message : err));
        msg.payload = {
            ok: true,
            count: savedPlaces.length,
            data: savedPlaces
        };
        return msg;
    }
})();
`
    );
}

function buildListSavedRoutes(queryHead) {
    return (
        queryHead +
        `
function buildFluxSavedRoutes(deviceKeyFilter) {
    const bucket = env.get("INFLUX_BUCKET");
    const bq = escapeFluxDoubleQuotes(bucket);
    const dk = escapeFluxDoubleQuotes(deviceKeyFilter);
    const lines = [
        'from(bucket: "' + bq + '")',
        '  |> range(start: -100y)',
        '  |> filter(fn: (r) => r["_measurement"] == "saved_route")',
        '  |> filter(fn: (r) => r["device_id"] == "' + dk + '")',
        '  |> filter(fn: (r) => r["_field"] == "name" or r["_field"] == "color" or r["_field"] == "point_count" or r["_field"] == "points_json")',
        '  |> pivot(rowKey: ["_time", "device_id", "route_id"], columnKey: ["_field"], valueColumn: "_value")',
        '  |> group()',
        '  |> sort(columns: ["_time"])'
    ];
    return lines.join(String.fromCharCode(10));
}
function mapInfluxRowToSavedRoute(row) {
    const rid = row.route_id || "";
    if (!rid) return null;
    let points = [];
    try {
        const raw = row.points_json;
        if (raw) points = JSON.parse(String(raw));
    } catch (rj) {
        points = [];
    }
    if (!Array.isArray(points)) points = [];
    const pc = parseInt(row.point_count, 10);
    const ts = Date.parse(row._time || "");
    return {
        id: rid,
        name: typeof row.name === "string" ? row.name : String(row.name || ""),
        color: typeof row.color === "string" ? row.color : String(row.color || ""),
        points: points,
        pointCount: Number.isFinite(pc) ? pc : points.length,
        timestamp: Number.isFinite(ts) ? ts : Date.now()
    };
}
function dedupeInfluxSavedRoutesFromRows(rows) {
    const mapped = [];
    for (let dri = 0; dri < rows.length; dri++) {
        const rt = mapInfluxRowToSavedRoute(rows[dri]);
        if (rt) mapped.push(rt);
    }
    const byId = {};
    mapped.forEach(function (r) {
        const prev = byId[r.id];
        const len = Array.isArray(r.points) ? r.points.length : 0;
        if (!prev) {
            byId[r.id] = r;
            return;
        }
        const prevLen = Array.isArray(prev.points) ? prev.points.length : 0;
        if (len > prevLen) {
            byId[r.id] = r;
        } else if (len === prevLen && (r.timestamp || 0) > (prev.timestamp || 0)) {
            byId[r.id] = r;
        }
    });
    return Object.keys(byId).map(function (k) {
        return byId[k];
    });
}
function mergeRoutesByIdPreferInflux(influxRoutes, globalRoutes) {
    const map = {};
    (globalRoutes || []).forEach(function (r) {
        if (r && r.id) map[r.id] = r;
    });
    (influxRoutes || []).forEach(function (r) {
        if (r && r.id) map[r.id] = r;
    });
    const out = Object.keys(map).map(function (k) {
        return map[k];
    });
    out.sort(function (a, b) {
        return (b.timestamp || 0) - (a.timestamp || 0);
    });
    return out;
}
return (async function () {
    let deviceKey = "";
    try {
        if (msg.req && msg.req.query && typeof msg.req.query.deviceKey === "string" && msg.req.query.deviceKey.trim()) {
            deviceKey = msg.req.query.deviceKey.trim();
        }
    } catch (e) {}
    const bucket = deviceKey || "__default__";
    const savedRoutesByDevice = global.get("savedRoutesByDevice") || {};
    let savedRoutes = savedRoutesByDevice[bucket];
    if (!Array.isArray(savedRoutes)) savedRoutes = [];
    if (bucket === "__default__" && savedRoutes.length === 0) {
        const leg = global.get("savedRoutes") || [];
        if (leg.length) savedRoutes = leg.slice();
    }

    if (!influxReadOrDeleteEnabled()) {
        msg.payload = {
            ok: true,
            count: savedRoutes.length,
            data: savedRoutes
        };
        return msg;
    }
    try {
        let base = String(env.get("INFLUX_URL"));
        while (base.endsWith("/")) base = base.slice(0, -1);
        const org = env.get("INFLUX_ORG");
        const token = env.get("INFLUX_TOKEN");
        const flux = buildFluxSavedRoutes(bucket);
        const queryUrl = base + "/api/v2/query?org=" + encodeURIComponent(org);
        const csvText = await httpPostJson(
            queryUrl,
            { query: flux, type: "flux" },
            {
                Authorization: "Token " + token,
                Accept: "application/csv"
            }
        );
        const rows = parseInfluxAnnotatedCsv(csvText);
        const fromInflux = dedupeInfluxSavedRoutesFromRows(rows);
        const merged = mergeRoutesByIdPreferInflux(fromInflux, savedRoutes);
        msg.payload = {
            ok: true,
            count: merged.length,
            data: merged
        };
        return msg;
    } catch (err) {
        node.warn("Influx list routes: " + (err && err.message ? err.message : err));
        msg.payload = {
            ok: true,
            count: savedRoutes.length,
            data: savedRoutes
        };
        return msg;
    }
})();
`
    );
}

function buildSaveCurrentPlace(flow) {
    const helpers = trackingInfluxWriteHelpers(flow);
    const fieldEsc = influxFieldStringEscaperForNrFlow();
    const head =
        "const payload = msg.payload || {};\n" +
        'const rawName = typeof payload.name === "string" ? payload.name.trim() : "";\n' +
        "if (!rawName) {\n" +
        "    msg.statusCode = 400;\n" +
        "    msg.payload = {\n" +
        "        ok: false,\n" +
        '        message: "Name ist erforderlich"\n' +
        "    };\n" +
        "    return [msg, null];\n" +
        "}\n\n" +
        'let deviceKey = "";\n' +
        "try {\n" +
        '    if (typeof payload.deviceKey === "string" && payload.deviceKey.trim()) {\n' +
        "        deviceKey = payload.deviceKey.trim();\n" +
        "    }\n" +
        "} catch (e) {}\n\n" +
        "const explicitLat = Number(payload.lat);\n" +
        "const explicitLon = Number(payload.lon);\n" +
        "const hasExplicitCoordinates = Number.isFinite(explicitLat) && Number.isFinite(explicitLon);\n\n" +
        "let placeLat;\n" +
        "let placeLon;\n" +
        "if (hasExplicitCoordinates) {\n" +
        "    placeLat = explicitLat;\n" +
        "    placeLon = explicitLon;\n" +
        "} else {\n" +
        '    const devices = global.get("devices") || {};\n' +
        "    const lastPosition = deviceKey ? devices[deviceKey] : global.get(\"lastPosition\");\n" +
        "    if (!lastPosition || typeof lastPosition.lat !== \"number\" || typeof lastPosition.lon !== \"number\") {\n" +
        "        msg.statusCode = 400;\n" +
        "        msg.payload = {\n" +
        "            ok: false,\n" +
        '            message: "Keine aktuelle Position verfügbar"\n' +
        "        };\n" +
        "        return [msg, null];\n" +
        "    }\n" +
        "    placeLat = lastPosition.lat;\n" +
        "    placeLon = lastPosition.lon;\n" +
        "}\n\n" +
        "const nonGreenPalette = [\n" +
        '    "#e74c3c",\n' +
        '    "#3498db",\n' +
        '    "#9b59b6",\n' +
        '    "#f39c12",\n' +
        '    "#e67e22",\n' +
        '    "#1abc9c",\n' +
        '    "#34495e",\n' +
        '    "#ff4d6d"\n' +
        "];\n" +
        "const randomIndex = Math.floor(Math.random() * nonGreenPalette.length);\n" +
        "const placeColor = nonGreenPalette[randomIndex];\n\n" +
        'const bucket = deviceKey || "__default__";\n' +
        'const savedPlacesByDevice = global.get("savedPlacesByDevice") || {};\n' +
        "const savedPlaces = Array.isArray(savedPlacesByDevice[bucket]) ? savedPlacesByDevice[bucket].slice() : [];\n" +
        "const placeEntry = {\n" +
        '    id: Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8),\n' +
        "    name: rawName,\n" +
        "    lat: placeLat,\n" +
        "    lon: placeLon,\n" +
        "    color: placeColor,\n" +
        "    timestamp: Date.now()\n" +
        "};\n\n" +
        "savedPlaces.push(placeEntry);\n" +
        "savedPlacesByDevice[bucket] = savedPlaces;\n" +
        'global.set("savedPlacesByDevice", savedPlacesByDevice);\n';
    const tail =
        "\n" +
        helpers +
        "\n" +
        fieldEsc +
        "\n" +
        "function buildSavedPlaceLine(deviceId, entry) {\n" +
        "    const tagDev = escapeInfluxTagValue(deviceId);\n" +
        "    const tagPid = escapeInfluxTagValue(entry.id);\n" +
        "    const ms = Number(entry.timestamp);\n" +
        "    const tsNs = Number.isFinite(ms) && ms > 0 ? Math.round(ms * 1000000) : Math.round(Date.now() * 1000000);\n" +
        "    const fields = [\n" +
        '        \'name="\' + escapeInfluxFieldString(entry.name) + \'"\',\n' +
        "        \"lat=\" + entry.lat,\n" +
        "        \"lon=\" + entry.lon,\n" +
        '        \'color="\' + escapeInfluxFieldString(entry.color) + \'"\',\n' +
        "    ];\n" +
        '    return "saved_place,device_id=" + tagDev + ",place_id=" + tagPid + " " + fields.join(",") + " " + tsNs;\n' +
        "}\n\n" +
        "let influxSecondMsg = null;\n" +
        "if (influxWriteEnabled()) {\n" +
        "    const lp = buildSavedPlaceLine(bucket, placeEntry);\n" +
        "    influxSecondMsg = buildInfluxWriteMessage(lp);\n" +
        "}\n\n" +
        "msg.payload = {\n" +
        "    ok: true,\n" +
        '    message: "Ort gespeichert",\n' +
        "    data: placeEntry\n" +
        "};\n\n" +
        "return [msg, influxSecondMsg];";
    return head + tail;
}

function buildSaveCurrentRoute(flow) {
    const helpers = trackingInfluxWriteHelpers(flow);
    const fieldEsc = influxFieldStringEscaperForNrFlow();
    const head =
        "const payload = msg.payload || {};\n" +
        'const rawName = typeof payload.name === "string" ? payload.name.trim() : "";\n' +
        "if (!rawName) {\n" +
        "    msg.statusCode = 400;\n" +
        '    msg.payload = { ok: false, message: "Name ist erforderlich" };\n' +
        "    return [msg, null];\n" +
        "}\n\n" +
        'let deviceKey = "";\n' +
        "try {\n" +
        '    if (typeof payload.deviceKey === "string" && payload.deviceKey.trim()) {\n' +
        "        deviceKey = payload.deviceKey.trim();\n" +
        "    }\n" +
        "} catch (e) {}\n" +
        'const bucket = deviceKey || "__default__";\n' +
        "let history = [];\n" +
        "const payloadPoints = Array.isArray(payload.points) ? payload.points : [];\n" +
        "if (payloadPoints.length >= 2) {\n" +
        "    const cleaned = [];\n" +
        "    for (let hi = 0; hi < payloadPoints.length; hi++) {\n" +
        "        const p = payloadPoints[hi];\n" +
        "        if (!p) continue;\n" +
        "        const la = Number(p.lat);\n" +
        "        const lo = Number(p.lon);\n" +
        "        if (!Number.isFinite(la) || !Number.isFinite(lo)) continue;\n" +
        "        cleaned.push({ lat: la, lon: lo, timestamp: p.timestamp != null ? p.timestamp : null });\n" +
        "    }\n" +
        "    if (cleaned.length >= 2) history = cleaned;\n" +
        "}\n" +
        'if (history.length < 2) {\n' +
        '    const historyByDevice = global.get("historyByDevice") || {};\n' +
        "    const ram = historyByDevice[bucket] || [];\n" +
        "    history = Array.isArray(ram) ? ram.slice() : [];\n" +
        "}\n" +
        'if (history.length < 2 && bucket === "__default__") {\n' +
        '    const leg = global.get("history") || [];\n' +
        "    history = Array.isArray(leg) ? leg.slice() : [];\n" +
        "}\n" +
        "if (!Array.isArray(history) || history.length < 2) {\n" +
        "    msg.statusCode = 400;\n" +
        '    msg.payload = { ok: false, message: "Keine Trackingdaten für eine Route vorhanden" };\n' +
        "    return [msg, null];\n" +
        "}\n\n" +
        "const nonGreenPalette = [\n" +
        '    "#e74c3c", "#3498db", "#9b59b6", "#f39c12",\n' +
        '    "#e67e22", "#1abc9c", "#34495e", "#ff4d6d"\n' +
        "];\n" +
        "const randomIndex = Math.floor(Math.random() * nonGreenPalette.length);\n" +
        "const routeColor = nonGreenPalette[randomIndex];\n\n" +
        'const savedRoutesByDevice = global.get("savedRoutesByDevice") || {};\n' +
        "let savedRoutes = Array.isArray(savedRoutesByDevice[bucket]) ? savedRoutesByDevice[bucket].slice() : [];\n" +
        "if (bucket === \"__default__\" && savedRoutes.length === 0) {\n" +
        '    const leg = global.get("savedRoutes") || [];\n' +
        "    if (leg.length) savedRoutes = leg.slice();\n" +
        "}\n" +
        "const routePointsSnapshot = history.map(function (point) {\n" +
        "    return {\n" +
        "        lat: point.lat,\n" +
        "        lon: point.lon,\n" +
        "        timestamp: point.timestamp || null\n" +
        "    };\n" +
        "});\n\n" +
        "const routeEntry = {\n" +
        '    id: Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8),\n' +
        "    name: rawName,\n" +
        "    color: routeColor,\n" +
        "    points: routePointsSnapshot,\n" +
        "    pointCount: routePointsSnapshot.length,\n" +
        "    timestamp: Date.now()\n" +
        "};\n\n" +
        "savedRoutes.push(routeEntry);\n" +
        "savedRoutesByDevice[bucket] = savedRoutes;\n" +
        'global.set("savedRoutesByDevice", savedRoutesByDevice);\n' +
        'if (bucket === "__default__") {\n' +
        '    global.set("savedRoutes", savedRoutes);\n' +
        "}\n";
    const tail =
        "\n" +
        helpers +
        "\n" +
        fieldEsc +
        "\n" +
        "function buildSavedRouteLine(deviceId, entry) {\n" +
        "    const tagDev = escapeInfluxTagValue(deviceId);\n" +
        "    const tagRid = escapeInfluxTagValue(entry.id);\n" +
        "    const ms = Number(entry.timestamp);\n" +
        "    const tsNs = Number.isFinite(ms) && ms > 0 ? Math.round(ms * 1000000) : Math.round(Date.now() * 1000000);\n" +
        "    const pointsJson = JSON.stringify(entry.points || []);\n" +
        "    const fields = [\n" +
        '        \'name="\' + escapeInfluxFieldString(entry.name) + \'"\',\n' +
        '        \'color="\' + escapeInfluxFieldString(entry.color) + \'"\',\n' +
        '        "point_count=" + (parseInt(entry.pointCount, 10) || 0) + "i",\n' +
        '        \'points_json="\' + escapeInfluxFieldString(pointsJson) + \'"\',\n' +
        "    ];\n" +
        '    return "saved_route,device_id=" + tagDev + ",route_id=" + tagRid + " " + fields.join(",") + " " + tsNs;\n' +
        "}\n\n" +
        "let influxSecondMsg = null;\n" +
        "if (influxWriteEnabled()) {\n" +
        "    const lp = buildSavedRouteLine(bucket, routeEntry);\n" +
        "    influxSecondMsg = buildInfluxWriteMessage(lp);\n" +
        "}\n\n" +
        "msg.payload = {\n" +
        "    ok: true,\n" +
        '    message: "Route gespeichert",\n' +
        "    data: {\n" +
        "        id: routeEntry.id,\n" +
        "        name: routeEntry.name,\n" +
        "        color: routeEntry.color,\n" +
        "        pointCount: routeEntry.pointCount,\n" +
        "        timestamp: routeEntry.timestamp\n" +
        "    }\n" +
        "};\n\n" +
        "return [msg, influxSecondMsg];";
    return head + tail;
}

function buildDeleteSavedPlaceById(deleteHead) {
    return (
        deleteHead +
        "\n" +
        SAVED_PLACES_FLUX_MERGE_FOR_DELETE +
        `
return (async function () {
    const placeId = msg.req && msg.req.params ? msg.req.params.id : "";
    if (!placeId) {
        msg.statusCode = 400;
        msg.payload = {
            ok: false,
            message: "ID ist erforderlich"
        };
        return msg;
    }

    let deviceKey = "";
    try {
        if (msg.req && msg.req.query && typeof msg.req.query.deviceKey === "string" && msg.req.query.deviceKey.trim()) {
            deviceKey = msg.req.query.deviceKey.trim();
        }
    } catch (e) {}
    const bucket = deviceKey || "__default__";
    const savedPlacesByDevice = global.get("savedPlacesByDevice") || {};
    let savedPlaces = Array.isArray(savedPlacesByDevice[bucket]) ? savedPlacesByDevice[bucket].slice() : [];
    if (bucket === "__default__" && savedPlaces.length === 0) {
        const leg = global.get("savedPlaces") || [];
        if (leg.length) savedPlaces = leg.slice();
    }
    savedPlaces = await loadMergedSavedPlacesForBucket(bucket, savedPlaces);
    const updatedSavedPlaces = savedPlaces.filter(function (placeEntry) {
        return placeEntry && placeEntry.id !== placeId;
    });

    if (updatedSavedPlaces.length === savedPlaces.length) {
        msg.statusCode = 404;
        msg.payload = {
            ok: false,
            message: "Ort nicht gefunden"
        };
        return msg;
    }

    savedPlacesByDevice[bucket] = updatedSavedPlaces;
    global.set("savedPlacesByDevice", savedPlacesByDevice);
    if (bucket === "__default__") {
        global.set("savedPlaces", updatedSavedPlaces);
    }

    if (influxReadOrDeleteEnabled()) {
        try {
            const pred =
                '_measurement="saved_place" AND device_id="' +
                escapeInfluxPredicateValue(bucket) +
                '" AND place_id="' +
                escapeInfluxPredicateValue(placeId) +
                '"';
            await influxDeleteByPredicate(pred);
        } catch (e) {
            node.warn("Influx delete place: " + (e && e.message ? e.message : e));
        }
    }

    msg.payload = {
        ok: true,
        message: "Ort gelöscht",
        count: updatedSavedPlaces.length
    };

    return msg;
})();`
    );
}

function buildDeleteSavedPlaces(deleteHead) {
    return (
        deleteHead +
        "\n" +
        SAVED_PLACES_FLUX_MERGE_FOR_DELETE +
        `
return (async function () {
    const payload = msg.payload || {};
    let deviceKey = "";
    try {
        if (typeof payload.deviceKey === "string" && payload.deviceKey.trim()) {
            deviceKey = payload.deviceKey.trim();
        }
    } catch (e) {}
    const bucket = deviceKey || "__default__";
    const savedPlacesByDevice = global.get("savedPlacesByDevice") || {};
    let savedPlaces = Array.isArray(savedPlacesByDevice[bucket]) ? savedPlacesByDevice[bucket].slice() : [];
    if (bucket === "__default__" && savedPlaces.length === 0) {
        const leg = global.get("savedPlaces") || [];
        if (leg.length) savedPlaces = leg.slice();
    }
    savedPlaces = await loadMergedSavedPlacesForBucket(bucket, savedPlaces);

    if (payload && payload.all === true) {
        savedPlacesByDevice[bucket] = [];
        global.set("savedPlacesByDevice", savedPlacesByDevice);
        if (bucket === "__default__") {
            global.set("savedPlaces", []);
        }
        if (influxReadOrDeleteEnabled()) {
            try {
                const pred = '_measurement="saved_place" AND device_id="' + escapeInfluxPredicateValue(bucket) + '"';
                await influxDeleteByPredicate(pred);
            } catch (e) {
                node.warn("Influx delete all places: " + (e && e.message ? e.message : e));
            }
        }
        msg.payload = {
            ok: true,
            message: "Alle Orte gelöscht",
            count: 0
        };
        return msg;
    }

    const selectedIds = Array.isArray(payload.ids)
        ? payload.ids.filter(function (value) {
              return typeof value === "string" && value.length > 0;
          })
        : [];

    if (selectedIds.length === 0) {
        msg.statusCode = 400;
        msg.payload = {
            ok: false,
            message: "ids oder all=true ist erforderlich"
        };
        return msg;
    }

    const selectedIdSet = {};
    selectedIds.forEach(function (selectedId) {
        selectedIdSet[selectedId] = true;
    });

    const updatedSavedPlaces = savedPlaces.filter(function (savedPlace) {
        return !savedPlace || !selectedIdSet[savedPlace.id];
    });

    const deletedCount = savedPlaces.length - updatedSavedPlaces.length;
    if (deletedCount <= 0) {
        msg.statusCode = 404;
        msg.payload = {
            ok: false,
            message: "Keine passenden Orte gefunden"
        };
        return msg;
    }

    savedPlacesByDevice[bucket] = updatedSavedPlaces;
    global.set("savedPlacesByDevice", savedPlacesByDevice);
    if (bucket === "__default__") {
        global.set("savedPlaces", updatedSavedPlaces);
    }

    if (influxReadOrDeleteEnabled()) {
        try {
            for (let si = 0; si < selectedIds.length; si++) {
                const pid = selectedIds[si];
                const pred =
                    '_measurement="saved_place" AND device_id="' +
                    escapeInfluxPredicateValue(bucket) +
                    '" AND place_id="' +
                    escapeInfluxPredicateValue(pid) +
                    '"';
                await influxDeleteByPredicate(pred);
            }
        } catch (e) {
            node.warn("Influx delete places: " + (e && e.message ? e.message : e));
        }
    }

    msg.payload = {
        ok: true,
        message: "Ausgewählte Orte gelöscht",
        deletedCount: deletedCount,
        count: updatedSavedPlaces.length
    };

    return msg;
})();`
    );
}

function buildDeleteSavedRoutes(deleteHead) {
    return (
        deleteHead +
        "\n" +
        SAVED_ROUTES_FLUX_MERGE_FOR_DELETE +
        `
return (async function () {
    const payload = msg.payload || {};
    let deviceKey = "";
    try {
        if (typeof payload.deviceKey === "string" && payload.deviceKey.trim()) {
            deviceKey = payload.deviceKey.trim();
        }
    } catch (e) {}
    const bucket = deviceKey || "__default__";
    const savedRoutesByDevice = global.get("savedRoutesByDevice") || {};
    let savedRoutes = Array.isArray(savedRoutesByDevice[bucket]) ? savedRoutesByDevice[bucket].slice() : [];
    if (bucket === "__default__" && savedRoutes.length === 0) {
        const leg = global.get("savedRoutes") || [];
        if (leg.length) savedRoutes = leg.slice();
    }
    savedRoutes = await loadMergedSavedRoutesForBucket(bucket, savedRoutes);

    if (payload && payload.all === true) {
        savedRoutesByDevice[bucket] = [];
        global.set("savedRoutesByDevice", savedRoutesByDevice);
        if (bucket === "__default__") {
            global.set("savedRoutes", []);
        }
        if (influxReadOrDeleteEnabled()) {
            try {
                const pred = '_measurement="saved_route" AND device_id="' + escapeInfluxPredicateValue(bucket) + '"';
                await influxDeleteByPredicate(pred);
            } catch (e) {
                node.warn("Influx delete all routes: " + (e && e.message ? e.message : e));
            }
        }
        msg.payload = { ok: true, message: "Alle Routen gelöscht", count: 0 };
        return msg;
    }

    const selectedIds = Array.isArray(payload.ids)
        ? payload.ids.filter(function (value) {
              return typeof value === "string" && value.length > 0;
          })
        : [];

    if (selectedIds.length === 0) {
        msg.statusCode = 400;
        msg.payload = { ok: false, message: "ids oder all=true ist erforderlich" };
        return msg;
    }

    const selectedIdSet = {};
    selectedIds.forEach(function (selectedId) {
        selectedIdSet[selectedId] = true;
    });

    const remainingRoutes = savedRoutes.filter(function (routeEntry) {
        return !routeEntry || !selectedIdSet[routeEntry.id];
    });

    const deletedCount = savedRoutes.length - remainingRoutes.length;
    if (deletedCount <= 0) {
        msg.statusCode = 404;
        msg.payload = { ok: false, message: "Keine passenden Routen gefunden" };
        return msg;
    }

    savedRoutesByDevice[bucket] = remainingRoutes;
    global.set("savedRoutesByDevice", savedRoutesByDevice);
    if (bucket === "__default__") {
        global.set("savedRoutes", remainingRoutes);
    }

    if (influxReadOrDeleteEnabled()) {
        try {
            for (let ri = 0; ri < selectedIds.length; ri++) {
                const rid = selectedIds[ri];
                const pred =
                    '_measurement="saved_route" AND device_id="' +
                    escapeInfluxPredicateValue(bucket) +
                    '" AND route_id="' +
                    escapeInfluxPredicateValue(rid) +
                    '"';
                await influxDeleteByPredicate(pred);
            }
        } catch (e) {
            node.warn("Influx delete routes: " + (e && e.message ? e.message : e));
        }
    }

    msg.payload = {
        ok: true,
        message: "Ausgewählte Routen gelöscht",
        deletedCount: deletedCount,
        count: remainingRoutes.length
    };

    return msg;
})();`
    );
}

function patchDeleteDeviceInflux(flow) {
    const n = getNode(flow, "deleteDeviceData");
    const needle = "await influxDeleteByPredicate(pred);";
    if (!n.func.includes(needle)) throw new Error("deleteDeviceData: expected gps delete line");
    if (n.func.includes('saved_place" AND device_id')) return;
    const insert =
        needle +
        "\n            await influxDeleteByPredicate('_measurement=\"saved_place\" AND device_id=\"' + escapeInfluxPredicateValue(key) + '\"');" +
        "\n            await influxDeleteByPredicate('_measurement=\"saved_route\" AND device_id=\"' + escapeInfluxPredicateValue(key) + '\"');";
    n.func = n.func.split(needle).join(insert);
}

function patchResetAllInflux(_flow) {
    // No-op: POST /api/reset soll gespeicherte Orte/Routen nicht löschen (Influx + Globals), siehe implementation-plan Step 99.
}

const httpLibs = [
    { module: "http", var: "nodeHttp" },
    { module: "https", var: "nodeHttps" }
];

function main() {
    const raw = fs.readFileSync(flowPath, "utf8");
    const flow = JSON.parse(raw);

    const queryHead = querySharedPrefixFromFlow(flow);
    const deleteHead = deleteSharedPrefixFromFlow(flow);

    ensureApiInfluxWriteNode(flow);

    const savePlace = getNode(flow, "saveCurrentPlace");
    savePlace.func = buildSaveCurrentPlace(flow);
    savePlace.outputs = 2;
    savePlace.wires = [["f22cf6ec71084bb7"], [INFLUX_WRITE_LINE_PROTOCOL_NODE_ID]];

    const saveRoute = getNode(flow, "saveCurrentRoute");
    saveRoute.func = buildSaveCurrentRoute(flow);
    saveRoute.outputs = 2;
    saveRoute.wires = [["route_resp_post_mo8q090487w7"], [INFLUX_WRITE_LINE_PROTOCOL_NODE_ID]];

    const listP = getNode(flow, "listSavedPlaces");
    listP.func = buildListSavedPlaces(queryHead);
    listP.libs = httpLibs;

    const listR = getNode(flow, "listSavedRoutes");
    listR.func = buildListSavedRoutes(queryHead);
    listR.libs = httpLibs;

    const delP1 = getNode(flow, "deleteSavedPlaceById");
    delP1.func = buildDeleteSavedPlaceById(deleteHead);
    delP1.libs = httpLibs;

    const delP2 = getNode(flow, "deleteSavedPlaces");
    delP2.func = buildDeleteSavedPlaces(deleteHead);
    delP2.libs = httpLibs;

    const delR = getNode(flow, "deleteSavedRoutes");
    delR.func = buildDeleteSavedRoutes(deleteHead);
    delR.libs = httpLibs;

    patchDeleteDeviceInflux(flow);
    patchResetAllInflux(flow);

    fs.writeFileSync(flowPath, JSON.stringify(flow));
    JSON.parse(fs.readFileSync(flowPath, "utf8"));
    console.log("OK: flows.json patched (saved_place, saved_route, deletes, list merge).");
}

main();
