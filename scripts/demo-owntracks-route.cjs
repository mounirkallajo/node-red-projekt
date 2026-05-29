/**
 * OwnTracks-"location"-Demo per MQTT.
 *
 * Standard DEMO_MODE=osrm: Straßenroute (öffentlicher OSRM-Demo-Server),
 * verdichtet auf DEMO_ROUTE_STEP_M, dann Ping-Pong.
 * Alternativen: line (Luftlinie), circle (Kreis).
 *
 * Voraussetzung: npm install (Paket "mqtt").
 *
 *   node scripts/demo-owntracks-route.cjs
 *
 * Umgebungsvariablen (optional):
 *   MQTT_HOST, MQTT_PORT, MQTT_USER, MQTT_PASSWORD
 *   OWNTRACKS_USER, OWNTRACKS_DEVICE
 *   DEMO_MODE            osrm | line | circle — Standard: osrm
 *   DEMO_SPEED_KMH       Ziel-Fahrgeschwindigkeit (Standard: 50) — Abstand zwischen Punkten; vel pro Segment
 *   DEMO_ROUTE_STEP_M    Max. Abstand zwischen Punkten auf der Straße (Standard: 18)
 *   DEMO_INTERVAL_MS     Optional: festes Intervall statt speed-basiert
 *   DEMO_PING_PONG       1/true: Hin- und Rückfahrt (Standard: 1)
 *   DEMO_START_LAT/LON   Start (Standard: Kienberg, Gärten der Welt)
 *   DEMO_END_LAT/LON     Ziel (Standard: Berlin Hauptbahnhof)
 */

const mqtt = require("mqtt");
const https = require("https");

const MQTT_HOST = process.env.MQTT_HOST || "100.83.91.99";
const MQTT_PORT = Number(process.env.MQTT_PORT || 1883);
const MQTT_USER = process.env.MQTT_USER || "";
const MQTT_PASSWORD = process.env.MQTT_PASSWORD || "";
const OWNTRACKS_USER = process.env.OWNTRACKS_USER || "demo-local";
const OWNTRACKS_DEVICE = process.env.OWNTRACKS_DEVICE || "route-sim";
const DEMO_MODE = (process.env.DEMO_MODE || "osrm").toLowerCase();
const DEMO_SPEED_KMH = Number(process.env.DEMO_SPEED_KMH || process.env.DEMO_VEL_KMH || 50);
const DEMO_SPEED_MPS = DEMO_SPEED_KMH / 3.6;
const DEMO_ROUTE_STEP_M = Number(process.env.DEMO_ROUTE_STEP_M || 18);
const DEMO_INTERVAL_MS = process.env.DEMO_INTERVAL_MS ? Number(process.env.DEMO_INTERVAL_MS) : null;
const DEMO_PING_PONG = process.env.DEMO_PING_PONG !== "0" && process.env.DEMO_PING_PONG !== "false";
const TRACKING_MIN_INTERVAL_MS = 1000;
const MIN_PUBLISH_INTERVAL_MS = TRACKING_MIN_INTERVAL_MS;
const DEMO_OSRM_BASE = (process.env.DEMO_OSRM_BASE || "https://router.project-osrm.org").replace(/\/$/, "");
const DEMO_OSRM_TIMEOUT_MS = Number(process.env.DEMO_OSRM_TIMEOUT_MS || 25000);

// Standard: Kienberg (Gärten der Welt, U5) → Berlin Hauptbahnhof
const DEMO_START_LAT = Number(process.env.DEMO_START_LAT || 52.5286152);
const DEMO_START_LON = Number(process.env.DEMO_START_LON || 13.5906369);
const DEMO_END_LAT = Number(process.env.DEMO_END_LAT || 52.5250175);
const DEMO_END_LON = Number(process.env.DEMO_END_LON || 13.369448);
const DEMO_LINE_SEGMENTS = Number(process.env.DEMO_LINE_SEGMENTS || 100);

const DEMO_CENTER_LAT = Number(process.env.DEMO_CENTER_LAT || 48.2082);
const DEMO_CENTER_LON = Number(process.env.DEMO_CENTER_LON || 16.3738);
const DEMO_RADIUS_M = Number(process.env.DEMO_RADIUS_M || 450);
const DEMO_POINTS = Number(process.env.DEMO_POINTS || 120);

const TOPIC = "owntracks/" + OWNTRACKS_USER + "/" + OWNTRACKS_DEVICE;
const OWNTRACKS_TID = (function () {
  const fromEnv = process.env.OWNTRACKS_TID;
  if (fromEnv && String(fromEnv).trim()) {
    return String(fromEnv).trim().slice(0, 2).toLowerCase();
  }
  const fromDevice = String(OWNTRACKS_DEVICE || "").replace(/[^a-zA-Z0-9]/g, "");
  return fromDevice.length >= 2 ? fromDevice.slice(0, 2).toLowerCase() : "rs";
})();
const EARTH_RADIUS_M = 6371000;
const TRACKING_MAX_ACCURACY_M = 15;

function haversineMeters(lat1, lon1, lat2, lon2) {
  const toRad = Math.PI / 180;
  const dLat = (lat2 - lat1) * toRad;
  const dLon = (lon2 - lon1) * toRad;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(a));
}

function bearingDegrees(lat1, lon1, lat2, lon2) {
  const toRad = Math.PI / 180;
  const lat1Rad = lat1 * toRad;
  const lat2Rad = lat2 * toRad;
  const dLon = (lon2 - lon1) * toRad;
  const y = Math.sin(dLon) * Math.cos(lat2Rad);
  const x =
    Math.cos(lat1Rad) * Math.sin(lat2Rad) -
    Math.sin(lat1Rad) * Math.cos(lat2Rad) * Math.cos(dLon);
  return (Math.atan2(y, x) * 180) / Math.PI;
}

function interpolateLine(startLat, startLon, endLat, endLon, segments) {
  const points = [];
  const count = Math.max(2, segments);
  for (let i = 0; i < count; i += 1) {
    const t = i / (count - 1);
    points.push({
      lat: startLat + (endLat - startLat) * t,
      lon: startLon + (endLon - startLon) * t
    });
  }
  return points;
}

function densifyPolyline(points, maxStepMeters) {
  if (!Array.isArray(points) || points.length === 0) {
    return [];
  }
  const result = [{ lat: points[0].lat, lon: points[0].lon }];
  for (let i = 1; i < points.length; i += 1) {
    const prev = result[result.length - 1];
    const next = points[i];
    const segmentMeters = haversineMeters(prev.lat, prev.lon, next.lat, next.lon);
    const steps = Math.max(1, Math.ceil(segmentMeters / maxStepMeters));
    for (let step = 1; step <= steps; step += 1) {
      const t = step / steps;
      result.push({
        lat: prev.lat + (next.lat - prev.lat) * t,
        lon: prev.lon + (next.lon - prev.lon) * t
      });
    }
  }
  return result;
}

function buildPingPongRoute(points) {
  if (points.length < 2) {
    return points.slice();
  }
  const returnLeg = points.slice(1, -1).reverse();
  return points.concat(returnLeg);
}

function buildCircleRoute() {
  const points = [];
  for (let i = 0; i < DEMO_POINTS; i += 1) {
    const angleRad = (2 * Math.PI * i) / DEMO_POINTS;
    const latOffset = (DEMO_RADIUS_M / EARTH_RADIUS_M) * (180 / Math.PI) * Math.cos(angleRad);
    const lonOffset =
      (DEMO_RADIUS_M / (EARTH_RADIUS_M * Math.cos(DEMO_CENTER_LAT * (Math.PI / 180)))) *
      (180 / Math.PI) *
      Math.sin(angleRad);
    points.push({ lat: DEMO_CENTER_LAT + latOffset, lon: DEMO_CENTER_LON + lonOffset });
  }
  return buildPingPongRoute(densifyPolyline(points, DEMO_ROUTE_STEP_M));
}

function httpsGetJson(urlString) {
  return new Promise(function (resolve, reject) {
    const parsed = new URL(urlString);
    const options = {
      hostname: parsed.hostname,
      port: parsed.port || 443,
      path: parsed.pathname + parsed.search,
      method: "GET",
      headers: { Accept: "application/json" }
    };
    const request = https.request(options, function (response) {
      let body = "";
      response.on("data", function (chunk) {
        body += chunk;
      });
      response.on("end", function () {
        if (response.statusCode < 200 || response.statusCode >= 300) {
          reject(new Error("HTTP " + response.statusCode + ": " + body.slice(0, 200)));
          return;
        }
        try {
          resolve(JSON.parse(body));
        } catch (parseError) {
          reject(parseError);
        }
      });
    });
    request.on("error", reject);
    request.setTimeout(DEMO_OSRM_TIMEOUT_MS, function () {
      request.destroy(new Error("OSRM timeout"));
    });
    request.end();
  });
}

async function fetchOsrmRoutePoints() {
  const url =
    DEMO_OSRM_BASE +
    "/route/v1/driving/" +
    DEMO_START_LON + "," + DEMO_START_LAT + ";" +
    DEMO_END_LON + "," + DEMO_END_LAT +
    "?overview=full&geometries=geojson&steps=false";
  const data = await httpsGetJson(url);
  if (!data || data.code !== "Ok" || !data.routes || !data.routes[0]) {
    throw new Error("OSRM: keine Route");
  }
  const coordinates = data.routes[0].geometry && data.routes[0].geometry.coordinates;
  if (!Array.isArray(coordinates) || coordinates.length < 2) {
    throw new Error("OSRM: leere Geometrie");
  }
  return coordinates.map(function (pair) {
    return { lat: pair[1], lon: pair[0] };
  });
}

async function buildRoutePoints() {
  if (DEMO_MODE === "circle") {
    return buildCircleRoute();
  }
  let basePoints;
  if (DEMO_MODE === "line") {
    basePoints = interpolateLine(DEMO_START_LAT, DEMO_START_LON, DEMO_END_LAT, DEMO_END_LON, DEMO_LINE_SEGMENTS);
  } else {
    try {
      basePoints = await fetchOsrmRoutePoints();
      console.log("OSRM:", basePoints.length, "Stützpunkte");
    } catch (osrmError) {
      console.warn("OSRM fehlgeschlagen, Fallback Luftlinie:", osrmError.message || osrmError);
      basePoints = interpolateLine(DEMO_START_LAT, DEMO_START_LON, DEMO_END_LAT, DEMO_END_LON, DEMO_LINE_SEGMENTS * 3);
    }
  }
  const dense = densifyPolyline(basePoints, DEMO_ROUTE_STEP_M);
  const route = DEMO_PING_PONG ? buildPingPongRoute(dense) : dense;
  console.log(
    "Route:",
    dense.length,
    "Punkte (verdichtet)",
    DEMO_PING_PONG ? ", Ping-Pong: " + route.length : ", einmalig"
  );
  return route;
}

function buildRouteLegs(routePoints) {
  const legs = [];
  for (let i = 0; i < routePoints.length; i += 1) {
    const point = routePoints[i];
    const nextPoint = routePoints[(i + 1) % routePoints.length];
    const segmentMeters = haversineMeters(point.lat, point.lon, nextPoint.lat, nextPoint.lon);
    let delayMs;
    if (DEMO_INTERVAL_MS !== null && Number.isFinite(DEMO_INTERVAL_MS) && DEMO_INTERVAL_MS > 0) {
      delayMs = DEMO_INTERVAL_MS;
    } else {
      delayMs = Math.round((segmentMeters / DEMO_SPEED_MPS) * 1000);
      delayMs = Math.max(MIN_PUBLISH_INTERVAL_MS, delayMs);
    }
    legs.push({ point: point, nextPoint: nextPoint, delayMs: delayMs, segmentMeters: segmentMeters });
  }
  return legs;
}

function roundCoordinate(value) {
  return Math.round(Number(value) * 1e6) / 1e6;
}

function segmentSpeedKmh(segmentMeters, delayMs) {
  const seconds = Math.max(Number(delayMs) / 1000, TRACKING_MIN_INTERVAL_MS / 1000);
  const kmh = (Number(segmentMeters) / seconds) * 3.6;
  if (!Number.isFinite(kmh) || kmh < 0) {
    return 0;
  }
  return Math.min(130, Math.round(kmh * 10) / 10);
}

function buildPayload(leg, tstSec) {
  const point = leg.point;
  const nextPoint = leg.nextPoint;
  const cog = nextPoint
    ? Math.round(((bearingDegrees(point.lat, point.lon, nextPoint.lat, nextPoint.lon) % 360) + 360) % 360)
    : 0;
  const velKmh = segmentSpeedKmh(leg.segmentMeters, leg.delayMs);
  const payload = {
    _type: "location",
    t: "t",
    tid: OWNTRACKS_TID,
    lat: roundCoordinate(point.lat),
    lon: roundCoordinate(point.lon),
    acc: Math.min(TRACKING_MAX_ACCURACY_M - 1, 10),
    alt: 38,
    vac: 3,
    vel: velKmh,
    cog: cog,
    batt: 87,
    conn: "m",
    m: 5,
    tst: tstSec
  };
  if (velKmh <= 0) {
    delete payload.vel;
  }
  return payload;
}

async function main() {
  const routePoints = await buildRoutePoints();
  if (routePoints.length < 2) {
    throw new Error("Zu wenige Routenpunkte");
  }
  const routeLegs = buildRouteLegs(routePoints);
  const oneWayMeters = routeLegs.reduce(function (sum, leg) {
    return sum + leg.segmentMeters;
  }, 0);
  const oneWayMinutes = oneWayMeters / DEMO_SPEED_MPS / 60;
  console.log(
    "Fahrt ~",
    Math.round(oneWayMeters),
    "m bei",
    DEMO_SPEED_KMH,
    "km/h →",
    oneWayMinutes.toFixed(1),
    "min pro Richtung"
  );

  const brokerUrl =
    "mqtt://" +
    (MQTT_USER ? encodeURIComponent(MQTT_USER) + ":" + encodeURIComponent(MQTT_PASSWORD) + "@" : "") +
    MQTT_HOST +
    ":" +
    MQTT_PORT;

  console.log("MQTT:", brokerUrl.replace(/:[^:@/]+@/, ":***@"));
  console.log(
    "Topic:",
    TOPIC,
    "| Modus:",
    DEMO_MODE,
    "|",
    DEMO_SPEED_KMH,
    "km/h",
    DEMO_INTERVAL_MS ? "| fest " + DEMO_INTERVAL_MS + " ms" : "| tempo aus Streckenlänge"
  );

  const client = mqtt.connect(brokerUrl, {
    reconnectPeriod: 3000,
    connectTimeout: 15000
  });

  let routeIndex = 0;
  let simulatedTimeMs = Date.now();
  let lastPublishedTstSec = 0;
  let publishTimer = null;

  function publishLegAndScheduleNext() {
    const leg = routeLegs[routeIndex];
    let tstSec = Math.floor(simulatedTimeMs / 1000);
    if (tstSec <= lastPublishedTstSec) {
      tstSec = lastPublishedTstSec + 1;
    }
    lastPublishedTstSec = tstSec;
    const payload = buildPayload(leg, tstSec);
    client.publish(TOPIC, JSON.stringify(payload), { qos: 1 }, function (publishError) {
      if (publishError) {
        console.error("Publish-Fehler:", publishError.message || publishError);
      }
    });
    if (routeIndex % 20 === 0) {
      console.log(
        "Punkt",
        routeIndex + 1 + "/" + routeLegs.length,
        payload.lat.toFixed(5),
        payload.lon.toFixed(5),
        "vel",
        payload.vel,
        "km/h cog",
        payload.cog,
        "Δt",
        leg.delayMs,
        "ms"
      );
    }
    simulatedTimeMs += leg.delayMs;
    routeIndex = (routeIndex + 1) % routeLegs.length;
    publishTimer = setTimeout(publishLegAndScheduleNext, leg.delayMs);
  }

  client.on("connect", function () {
    console.log("MQTT verbunden — Demo sendet… (Strg+C zum Beenden)");
    publishLegAndScheduleNext();
  });

  process.on("SIGINT", function () {
    if (publishTimer) clearTimeout(publishTimer);
    client.end(true, function () {
      process.exit(0);
    });
  });

  client.on("error", function (mqttError) {
    console.error("MQTT-Fehler:", mqttError.message || mqttError);
  });
}

main().catch(function (fatalError) {
  console.error(fatalError);
  process.exit(1);
});
