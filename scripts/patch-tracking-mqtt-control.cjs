"use strict";

/**
 * Idempotent patch for flows.json inline API nodes:
 *  - "API tracking status" (982c6c3fe99e4947): expose phone-local tracking state
 *    (localActive/localUpdatedAt) read from global.localTrackingStateByDevice so the
 *    web UI can detect "server active but phone locally stopped".
 *  - "resetAllData" (0b7df22564f0d767): also clear localTrackingStateByDevice on
 *    per-device and full reset.
 *
 * Run from project root: node scripts/patch-tracking-mqtt-control.cjs
 */
const fs = require("fs");
const path = require("path");

const flowPath = path.join(__dirname, "..", "flows.json");
const flow = JSON.parse(fs.readFileSync(flowPath, "utf8"));

const STATUS_ID = "982c6c3fe99e4947";
const RESET_ID = "0b7df22564f0d767";

function getNode(id) {
  const node = flow.find((n) => n && n.id === id);
  if (!node || node.type !== "function") {
    throw new Error("flows.json: function node " + id + " not found");
  }
  return node;
}

let changed = false;

// --- API tracking status: add localActive/localUpdatedAt ---
const statusNode = getNode(STATUS_ID);
if (statusNode.func.indexOf("localTrackingStateByDevice") === -1) {
  const anchor = "const trackingActive = !!ts.active;";
  if (statusNode.func.indexOf(anchor) === -1) {
    throw new Error("status node: anchor for tracking state not found");
  }
  statusNode.func = statusNode.func.replace(
    anchor,
    anchor +
      "\nconst localTrackingStateByDevice = global.get(\"localTrackingStateByDevice\") || {};" +
      "\nconst lts = (deviceKey && localTrackingStateByDevice[deviceKey]) ? localTrackingStateByDevice[deviceKey] : null;"
  );
  const dataAnchor = "        active: trackingActive,\n        deviceKey: deviceKey || null,";
  if (statusNode.func.indexOf(dataAnchor) === -1) {
    throw new Error("status node: payload anchor not found");
  }
  statusNode.func = statusNode.func.replace(
    dataAnchor,
    "        active: trackingActive,\n" +
      "        localActive: lts ? !!lts.active : null,\n" +
      "        localUpdatedAt: lts ? (lts.updatedAt || null) : null,\n" +
      "        deviceKey: deviceKey || null,"
  );
  changed = true;
  console.log("OK: status node patched (localActive exposed)");
} else {
  console.log("skip: status node already patched");
}

// --- resetAllData: clear localTrackingStateByDevice ---
const resetNode = getNode(RESET_ID);
if (resetNode.func.indexOf("localTrackingStateByDevice") === -1) {
  const perDeviceAnchor = "delete trackingStateByDevice[deviceKey];";
  if (resetNode.func.indexOf(perDeviceAnchor) === -1) {
    throw new Error("reset node: per-device anchor not found");
  }
  resetNode.func = resetNode.func.replace(
    perDeviceAnchor,
    perDeviceAnchor +
      "\n        const localTrackingStateByDeviceReset = global.get(\"localTrackingStateByDevice\") || {};" +
      "\n        delete localTrackingStateByDeviceReset[deviceKey];" +
      "\n        global.set(\"localTrackingStateByDevice\", localTrackingStateByDeviceReset);"
  );
  const allAnchor = "global.set(\"trackingStateByDevice\", {});";
  if (resetNode.func.indexOf(allAnchor) === -1) {
    throw new Error("reset node: all-reset anchor not found");
  }
  resetNode.func = resetNode.func.replace(
    allAnchor,
    allAnchor + "\n    global.set(\"localTrackingStateByDevice\", {});"
  );
  changed = true;
  console.log("OK: reset node patched (localTrackingStateByDevice cleared)");
} else {
  console.log("skip: reset node already patched");
}

// --- Influx history: persist + read segment_id/break_before so route breaks
//     survive when history is served from InfluxDB (segments preserved). ---
const FLUX_FILTER_OLD =
  'r["_field"] == "heading" or r["_field"] == "battery")';
const FLUX_FILTER_NEW =
  'r["_field"] == "heading" or r["_field"] == "battery" or r["_field"] == "segment_id" or r["_field"] == "break_before")';
const LP_HEADING_BATTERY =
  'if (typeof p.battery === "number" && Number.isFinite(p.battery)) fields.push("battery=" + Math.round(p.battery) + "i");';
const LP_SEGMENT =
  '\n    if (p.segmentId != null && String(p.segmentId) !== "") {' +
  '\n        fields.push(\'segment_id="\' + String(p.segmentId).replace(/(["\\\\])/g, "\\\\$1") + \'"\');' +
  '\n    }' +
  '\n    if (p.breakBefore === true) fields.push("break_before=true");';
const MAP_BATTERY_BLOCK =
  'if (row.battery !== undefined && row.battery !== "") {\n        const bt = parseFloat(row.battery);\n        if (Number.isFinite(bt)) o.battery = bt;\n    }';
const MAP_SEGMENT_BLOCK =
  '\n    if (row.segment_id !== undefined && row.segment_id !== "") {' +
  '\n        o.segmentId = String(row.segment_id);' +
  '\n    }' +
  '\n    if (row.break_before !== undefined && String(row.break_before).toLowerCase() === "true") {' +
  '\n        o.breakBefore = true;' +
  '\n    }';

flow.forEach((node) => {
  if (!node || node.type !== "function" || typeof node.func !== "string") return;
  let func = node.func;
  let nodeChanged = false;

  if (func.indexOf("buildInfluxGpsLineProtocol") !== -1 &&
      func.indexOf(LP_HEADING_BATTERY) !== -1 &&
      func.indexOf("break_before=true") === -1) {
    func = func.replace(LP_HEADING_BATTERY, LP_HEADING_BATTERY + LP_SEGMENT);
    nodeChanged = true;
  }
  if (func.indexOf(FLUX_FILTER_OLD) !== -1 && func.indexOf('"segment_id"') === -1) {
    func = func.split(FLUX_FILTER_OLD).join(FLUX_FILTER_NEW);
    nodeChanged = true;
  }
  if (func.indexOf("mapInfluxRowToPoint") !== -1 &&
      func.indexOf(MAP_BATTERY_BLOCK) !== -1 &&
      func.indexOf("o.segmentId = String(row.segment_id)") === -1) {
    func = func.replace(MAP_BATTERY_BLOCK, MAP_BATTERY_BLOCK + MAP_SEGMENT_BLOCK);
    nodeChanged = true;
  }

  if (nodeChanged) {
    node.func = func;
    changed = true;
    console.log("OK: influx segment fields patched in node " + node.id + " (" + node.name + ")");
  }
});

if (changed) {
  fs.writeFileSync(flowPath, JSON.stringify(flow), "utf8");
  console.log("flows.json written");
} else {
  console.log("no changes");
}
