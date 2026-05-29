(function (global) {
  'use strict';

  global.__CAPACITOR_BRIDGE_VERSION = '20260525-request-location-v25';

  if (typeof global.fetch === 'function' && !global.__OSRM_ROUTE_STEPS_PATCH) {
    global.__OSRM_ROUTE_STEPS_PATCH = true;
    const nativeFetch = global.fetch;
    global.fetch = function (input, init) {
      let requestUrl = typeof input === 'string' ? input : (input && typeof input.url === 'string' ? input.url : '');
      if (requestUrl && requestUrl.indexOf('/route/v1/') >= 0 && requestUrl.indexOf('steps=true') < 0) {
        requestUrl = requestUrl.replace(/([?&])steps=false(?=&|$)/, '$1steps=true');
        if (requestUrl.indexOf('steps=true') < 0) {
          requestUrl += (requestUrl.indexOf('?') >= 0 ? '&' : '?') + 'steps=true';
        }
        input = typeof input === 'string' ? requestUrl : new Request(requestUrl, input);
      }
      return nativeFetch.call(global, input, init);
    };
  }

  const PREF_DEVICE_KEY = 'gpsTrackingDeviceKey';
  const PREF_USER = 'gpsTrackingUser';
  const PREF_DEVICE_NAME = 'gpsTrackingDeviceName';
  const PREF_IDLE_SEC = 'gpsPointIdleSec';
  const PREF_MOVING_SEC = 'gpsPointMovingSec';
  const PREF_INTERVAL_MIN = 'gpsPointIntervalMin';
  const PREF_MIN_MOVE_M = 'gpsMinMoveM';
  const PREF_MAX_ACCURACY_M = 'gpsMaxAccuracyM';
  const PREF_WALKING_SPEED_KMH = 'gpsWalkingSpeedKmh';
  const PREF_MOVING_SPEED_KMH = 'gpsMovingSpeedKmh';
  const PREF_STATIONARY_RADIUS_M = 'gpsStationaryRadiusM';
  const PREF_STATIONARY_MAX_RADIUS_M = 'gpsStationaryMaxRadiusM';
  const PREF_CONFIRM_POINTS = 'gpsConfirmPoints';
  const PREF_SPEED_JUMP_KMH = 'gpsSpeedJumpKmh';
  const PREF_HEADING_BURST_DEG = 'gpsHeadingBurstDeg';
  const PREF_HEADING_BURST_SEC = 'gpsHeadingBurstSec';
  const PREF_HEADING_FILTER_PRESET = 'gpsHeadingFilterPreset';
  const PREF_HEADING_FILTER_MAX_JUMP_DEG = 'gpsHeadingFilterMaxJumpDeg';
  const PREF_HEADING_FILTER_DEADBAND_DEG = 'gpsHeadingFilterDeadbandDeg';
  const PREF_HEADING_FILTER_SMOOTH_LEVEL = 'gpsHeadingFilterSmoothLevel';
  const PREF_HEADING_FILTER_SAMPLE_MAX = 'gpsHeadingFilterSampleMax';
  const PREF_HEADING_FILTER_TURN_CONFIRM = 'gpsHeadingFilterTurnConfirm';
  const PREF_HEADING_FILTER_MAP_SPIKE_DEG = 'gpsHeadingFilterMapSpikeRejectDeg';
  const PREF_HEADING_FILTER_MAP_BEARING_DEG = 'gpsHeadingFilterMapBearingDeadbandDeg';
  const PREF_BACKGROUND_UPLOAD = 'gpsBackgroundUploadEnabled';
  const PREF_SERVER_UPLOAD = 'gpsServerUploadEnabled';
  const PREF_SERVER_URL = 'gpsTrackingServerUrl';
  const PREF_MQTT_WS_URL = 'gpsTrackingMqttUrl';
  const PREF_UPLOAD_IDLE_SEC = 'gpsUploadPointIdleSec';
  const PREF_UPLOAD_MOVING_SEC = 'gpsUploadPointMovingSec';
  const PREF_UPLOAD_INTERVAL_MIN = 'gpsUploadPointIntervalMin';
  const PREF_UPLOAD_MIN_MOVE_M = 'gpsUploadMinMoveM';
  const PREF_UPLOAD_MAX_ACCURACY_M = 'gpsUploadMaxAccuracyM';
  const PREF_UPLOAD_WALKING_SPEED_KMH = 'gpsUploadWalkingSpeedKmh';
  const PREF_UPLOAD_MOVING_SPEED_KMH = 'gpsUploadMovingSpeedKmh';
  const PREF_UPLOAD_STATIONARY_RADIUS_M = 'gpsUploadStationaryRadiusM';
  const PREF_UPLOAD_STATIONARY_MAX_RADIUS_M = 'gpsUploadStationaryMaxRadiusM';
  const PREF_UPLOAD_CONFIRM_POINTS = 'gpsUploadConfirmPoints';
  const PREF_UPLOAD_SPEED_JUMP_KMH = 'gpsUploadSpeedJumpKmh';
  const PREF_UPLOAD_HEADING_BURST_DEG = 'gpsUploadHeadingBurstDeg';
  const PREF_UPLOAD_HEADING_BURST_SEC = 'gpsUploadHeadingBurstSec';
  const QUEUE_STORAGE_KEY = 'capBridge:pointQueue';
  const LOCAL_FINAL_POINT_STORAGE_KEY = 'capBridge:finalPoint';
  const LOCAL_ROUTE_STORAGE_KEY = 'capBridge:localRoute';
  const LOCAL_ROUTE_SEGMENT_STORAGE_KEY = 'capBridge:routeSegmentId';
  const LOCAL_ROUTE_BREAK_STORAGE_KEY = 'capBridge:routeBreakPending';
  const TRACK_ID_STORAGE_KEY = 'capBridge:trackId';
  const TRACK_DEVICE_KEY_STORAGE_KEY = 'capBridge:trackDeviceKey';
  const TRACK_SEQUENCE_STORAGE_KEY = 'capBridge:sequenceNumber';
  const TRACKING_ACTIVE_STORAGE_KEY = 'capBridge:trackingActive';
  const TRACKING_STOPPED_AT_STORAGE_KEY = 'capBridge:trackingStoppedAt';
  const MQTT_SCRIPT_PATH = '/mobile/mqtt.min.js';
  const MQTT_TOPIC_PREFIX = 'mobile_app';
  const TILE_DB = 'cap-bridge-map-tiles';
  const TILE_STORE = 'tiles';
  const MAPTILER_KEY_FALLBACK = 'R1pXZ5w6lmOR4jqxjESj';
  const DEFAULT_IDLE_SEC = 2;
  const DEFAULT_MOVING_SEC = 0.5;
  const LOOP_TICK_MS = 200;

  let deviceKey = '';
  let trackingActive = false;
  let backgroundWatcherId = null;
  let pointLoopTimer = null;
  let localWatchId = null;
  let localPollTimer = null;
  let localGpsPermissionReady = false;
  let localGpsPermissionPromise = null;
  let sendInFlight = false;
  let lastSendMs = 0;
  let lastLiveSendMs = 0;
  let lastLat = null;
  let lastLon = null;
  const displayFilterState = { stablePoint: null, stationaryExitCount: 0 };
  const routeReductionState = { lastRoutePoint: null };
  let lastFinalLocalPoint = null;
  let latestCompassHeading = null;
  let lastRawCompassHeading = null;
  let lastHeadingRejectedRaw = null;
  let lastHeadingRejectedMs = 0;
  let compassHeadingBound = false;
  let compassAbsoluteBound = false;
  let compassFallbackBound = false;
  const HEADING_FILTER_PRESETS = {
    calm: {
      maxJumpDeg: 28,
      deadbandDeg: 5,
      smoothLevel: 2,
      sampleMax: 11,
      turnConfirmSamples: 4,
      mapSpikeRejectDeg: 35,
      mapBearingDeadbandDeg: 6
    },
    balanced: {
      maxJumpDeg: 42,
      deadbandDeg: 2,
      smoothLevel: 4,
      sampleMax: 7,
      turnConfirmSamples: 3,
      mapSpikeRejectDeg: 48,
      mapBearingDeadbandDeg: 3.5
    },
    responsive: {
      maxJumpDeg: 55,
      deadbandDeg: 1.5,
      smoothLevel: 7,
      sampleMax: 5,
      turnConfirmSamples: 2,
      mapSpikeRejectDeg: 60,
      mapBearingDeadbandDeg: 2
    }
  };
  let headingStabilizerSamples = [];
  let headingStabilizerStable = null;
  let headingStabilizerOutput = null;
  let headingStabilizerTurnCandidate = null;
  let headingStabilizerTurnStreak = 0;
  let lastHeadingBurstMs = 0;
  let lastHeadingBurstHeading = null;
  let headingBurstInFlight = false;
  let offlineLayer = null;
  let offlineModeActive = false;
  let syncInFlight = false;
  let bridgeReady = false;
  let mqttClient = null;
  let mqttConnectPromise = null;
  let mqttScriptPromise = null;
  let requestLocationInFlight = null;
  let locationBurstInFlight = null;
  let visibilityHandlersBound = false;
  let appLifecycleHandlersBound = false;
  let backgroundUploadEnabled = true;
  let serverUploadEnabled = true;
  let configuredServerUrl = '';
  let configuredMqttWebSocketUrl = '';
  let persistentUploadActive = false;

  function defaultPositionFilterSettings() {
    return {
      minMoveM: 1,
      maxAccuracyM: 20,
      walkingSpeedKmh: 1.6,
      movingSpeedKmh: 3,
      stationaryRadiusM: 18,
      stationaryMaxRadiusM: 80,
      confirmPoints: 3,
      speedJumpKmh: 8
    };
  }

  const displaySettings = Object.assign(defaultPositionFilterSettings(), {
    headingFilterPreset: 'calm',
    headingFilterMaxJumpDeg: 28,
    headingFilterDeadbandDeg: 5,
    headingFilterSmoothLevel: 2,
    headingFilterSampleMax: 11,
    headingFilterTurnConfirmSamples: 4,
    headingFilterMapSpikeRejectDeg: 35,
    headingFilterMapBearingDeadbandDeg: 6
  });

  const uploadSettings = {
    idleSec: DEFAULT_IDLE_SEC,
    movingSec: DEFAULT_MOVING_SEC,
    intervalMin: 0,
    headingBurstDeg: 10,
    headingBurstSec: 0.35
  };

  function cap() {
    return global.Capacitor || null;
  }

  function isNative() {
    const c = cap();
    if (!c) return false;
    if (typeof c.isNativePlatform === 'function' && c.isNativePlatform()) return true;
    if (typeof c.getPlatform === 'function') {
      const platform = String(c.getPlatform() || '').toLowerCase();
      return platform === 'android' || platform === 'ios';
    }
    return false;
  }

  function plugins() {
    const c = cap();
    return (c && c.Plugins) || {};
  }

  function sanitizePart(value, fallback) {
    const cleaned = String(value || '').trim().toLowerCase()
      .replace(/\s+/g, '-')
      .replace(/[^a-z0-9._-]/g, '')
      .replace(/^-+|-+$/g, '');
    return cleaned || fallback;
  }

  async function prefGet(key, fallback) {
    const Preferences = plugins().Preferences;
    if (Preferences) {
      try {
        const result = await Preferences.get({ key: key });
        if (result && result.value != null && result.value !== '') return result.value;
      } catch (error) {}
    }
    const raw = localStorage.getItem(key);
    return raw != null && raw !== '' ? raw : fallback;
  }

  async function prefSet(key, value) {
    const Preferences = plugins().Preferences;
    if (Preferences) {
      try {
        await Preferences.set({ key: key, value: String(value) });
        return;
      } catch (error) {}
    }
    localStorage.setItem(key, String(value));
  }

  async function prefGetWithLegacy(primaryKey, legacyKey, fallback) {
    const primary = await prefGet(primaryKey, null);
    if (primary != null && primary !== '') return primary;
    return prefGet(legacyKey, fallback);
  }

  async function loadPositionFilterSettings(cfg, uploadMode) {
    const minMoveFallback = await prefGet(PREF_MIN_MOVE_M, 1);
    cfg.minMoveM = clamp(await prefGetWithLegacy(
      uploadMode ? PREF_UPLOAD_MIN_MOVE_M : PREF_MIN_MOVE_M, PREF_MIN_MOVE_M, minMoveFallback), 0.2, 20, 1);
    cfg.maxAccuracyM = clamp(await prefGetWithLegacy(
      uploadMode ? PREF_UPLOAD_MAX_ACCURACY_M : PREF_MAX_ACCURACY_M, PREF_MAX_ACCURACY_M, 20), 5, 100, 20);
    cfg.walkingSpeedKmh = clamp(await prefGetWithLegacy(
      uploadMode ? PREF_UPLOAD_WALKING_SPEED_KMH : PREF_WALKING_SPEED_KMH, PREF_WALKING_SPEED_KMH, 1.6), 0.5, 8, 1.6);
    cfg.movingSpeedKmh = clamp(await prefGetWithLegacy(
      uploadMode ? PREF_UPLOAD_MOVING_SPEED_KMH : PREF_MOVING_SPEED_KMH, PREF_MOVING_SPEED_KMH, 3), cfg.walkingSpeedKmh, 30, 3);
    cfg.stationaryRadiusM = clamp(await prefGetWithLegacy(
      uploadMode ? PREF_UPLOAD_STATIONARY_RADIUS_M : PREF_STATIONARY_RADIUS_M, PREF_STATIONARY_RADIUS_M, 18), 3, 80, 18);
    cfg.stationaryMaxRadiusM = clamp(await prefGetWithLegacy(
      uploadMode ? PREF_UPLOAD_STATIONARY_MAX_RADIUS_M : PREF_STATIONARY_MAX_RADIUS_M, PREF_STATIONARY_MAX_RADIUS_M, 80),
      cfg.stationaryRadiusM, 150, 80);
    cfg.confirmPoints = clampInt(await prefGetWithLegacy(
      uploadMode ? PREF_UPLOAD_CONFIRM_POINTS : PREF_CONFIRM_POINTS, PREF_CONFIRM_POINTS, 3), 1, 8, 3);
    cfg.speedJumpKmh = clamp(await prefGetWithLegacy(
      uploadMode ? PREF_UPLOAD_SPEED_JUMP_KMH : PREF_SPEED_JUMP_KMH, PREF_SPEED_JUMP_KMH, 8), 2, 60, 8);
  }

  async function loadSettings() {
    await loadPositionFilterSettings(displaySettings, false);
    displaySettings.headingFilterPreset = String(await prefGet(PREF_HEADING_FILTER_PRESET, 'calm') || 'calm');
    displaySettings.headingFilterMaxJumpDeg = clamp(await prefGet(PREF_HEADING_FILTER_MAX_JUMP_DEG, 28), 15, 60, 28);
    displaySettings.headingFilterDeadbandDeg = clamp(await prefGet(PREF_HEADING_FILTER_DEADBAND_DEG, 5), 1, 8, 5);
    displaySettings.headingFilterSmoothLevel = clampInt(await prefGet(PREF_HEADING_FILTER_SMOOTH_LEVEL, 2), 1, 10, 2);
    displaySettings.headingFilterSampleMax = clampInt(await prefGet(PREF_HEADING_FILTER_SAMPLE_MAX, 11), 5, 13, 11);
    displaySettings.headingFilterTurnConfirmSamples = clampInt(await prefGet(PREF_HEADING_FILTER_TURN_CONFIRM, 4), 2, 6, 4);
    displaySettings.headingFilterMapSpikeRejectDeg = clamp(await prefGet(PREF_HEADING_FILTER_MAP_SPIKE_DEG, 35), 20, 70, 35);
    displaySettings.headingFilterMapBearingDeadbandDeg = clamp(await prefGet(PREF_HEADING_FILTER_MAP_BEARING_DEG, 6), 1, 10, 6);

    uploadSettings.idleSec = clamp(await prefGetWithLegacy(PREF_UPLOAD_IDLE_SEC, PREF_IDLE_SEC, DEFAULT_IDLE_SEC), 1, 3600, DEFAULT_IDLE_SEC);
    uploadSettings.movingSec = clamp(await prefGetWithLegacy(PREF_UPLOAD_MOVING_SEC, PREF_MOVING_SEC, DEFAULT_MOVING_SEC), 0.2, 60, DEFAULT_MOVING_SEC);
    uploadSettings.intervalMin = clamp(await prefGetWithLegacy(PREF_UPLOAD_INTERVAL_MIN, PREF_INTERVAL_MIN, 0), 0, 1440, 0);
    uploadSettings.headingBurstDeg = clamp(await prefGetWithLegacy(PREF_UPLOAD_HEADING_BURST_DEG, PREF_HEADING_BURST_DEG, 10), 3, 90, 10);
    uploadSettings.headingBurstSec = clamp(await prefGetWithLegacy(PREF_UPLOAD_HEADING_BURST_SEC, PREF_HEADING_BURST_SEC, 0.35), 0.15, 5, 0.35);

    const rawBackgroundUpload = await prefGet(PREF_BACKGROUND_UPLOAD, '1');
    backgroundUploadEnabled = String(rawBackgroundUpload) !== '0' && String(rawBackgroundUpload).toLowerCase() !== 'false';
    const rawServerUpload = await prefGet(PREF_SERVER_UPLOAD, '1');
    serverUploadEnabled = String(rawServerUpload) !== '0' && String(rawServerUpload).toLowerCase() !== 'false';
    configuredServerUrl = String(await prefGet(PREF_SERVER_URL, '') || '').trim();
    configuredMqttWebSocketUrl = String(await prefGet(PREF_MQTT_WS_URL, '') || '').trim();
    try {
      trackingActive = String(localStorage.getItem(TRACKING_ACTIVE_STORAGE_KEY) || '0') === '1';
    } catch (error) {}
  }

  function mapTilerKey() {
    return String(global.MAPTILER_API_KEY || localStorage.getItem('maptilerApiKey') || MAPTILER_KEY_FALLBACK).trim();
  }

  function tileUrl(z, x, y) {
    return 'https://api.maptiler.com/maps/streets-v2/256/' + z + '/' + x + '/' + y + '.png?key=' + encodeURIComponent(mapTilerKey());
  }

  function num(v) {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }

  function clamp(v, min, max, fallback) {
    const n = num(v);
    return n == null ? fallback : Math.min(max, Math.max(min, n));
  }

  function clampInt(v, min, max, fallback) {
    return Math.round(clamp(v, min, max, fallback));
  }

  function headingFilterAlphaFromLevel(level) {
    const safeLevel = clampInt(level, 1, 10, 4);
    return 0.08 + (safeLevel - 1) * (0.32 / 9);
  }

  function mapHeadingFilterPresetToProfileFields(presetValues) {
    if (!presetValues) return null;
    return {
      headingFilterMaxJumpDeg: presetValues.maxJumpDeg,
      headingFilterDeadbandDeg: presetValues.deadbandDeg,
      headingFilterSmoothLevel: presetValues.smoothLevel,
      headingFilterSampleMax: presetValues.sampleMax,
      headingFilterTurnConfirmSamples: presetValues.turnConfirmSamples,
      headingFilterMapSpikeRejectDeg: presetValues.mapSpikeRejectDeg,
      headingFilterMapBearingDeadbandDeg: presetValues.mapBearingDeadbandDeg
    };
  }

  function getHeadingFilterPresetValues(presetKey) {
    const preset = String(presetKey || 'calm').toLowerCase();
    if (preset === 'custom') return null;
    return mapHeadingFilterPresetToProfileFields(HEADING_FILTER_PRESETS[preset]);
  }

  function resolveHeadingFilterSettings() {
    const presetKey = String(displaySettings.headingFilterPreset || 'calm').toLowerCase();
    if (presetKey !== 'custom' && HEADING_FILTER_PRESETS[presetKey]) {
      return Object.assign({}, HEADING_FILTER_PRESETS[presetKey], { preset: presetKey });
    }
    return {
      preset: 'custom',
      maxJumpDeg: displaySettings.headingFilterMaxJumpDeg,
      deadbandDeg: displaySettings.headingFilterDeadbandDeg,
      smoothLevel: displaySettings.headingFilterSmoothLevel,
      sampleMax: displaySettings.headingFilterSampleMax,
      turnConfirmSamples: displaySettings.headingFilterTurnConfirmSamples,
      mapSpikeRejectDeg: displaySettings.headingFilterMapSpikeRejectDeg,
      mapBearingDeadbandDeg: displaySettings.headingFilterMapBearingDeadbandDeg
    };
  }

  function applyHeadingFilterSettingsFromData(data) {
    const preset = String((data && data.headingFilterPreset) || displaySettings.headingFilterPreset || 'calm').toLowerCase();
    displaySettings.headingFilterPreset = preset;
    if (preset !== 'custom' && HEADING_FILTER_PRESETS[preset]) {
      const presetValues = HEADING_FILTER_PRESETS[preset];
      displaySettings.headingFilterMaxJumpDeg = presetValues.maxJumpDeg;
      displaySettings.headingFilterDeadbandDeg = presetValues.deadbandDeg;
      displaySettings.headingFilterSmoothLevel = presetValues.smoothLevel;
      displaySettings.headingFilterSampleMax = presetValues.sampleMax;
      displaySettings.headingFilterTurnConfirmSamples = presetValues.turnConfirmSamples;
      displaySettings.headingFilterMapSpikeRejectDeg = presetValues.mapSpikeRejectDeg;
      displaySettings.headingFilterMapBearingDeadbandDeg = presetValues.mapBearingDeadbandDeg;
      return;
    }
    displaySettings.headingFilterMaxJumpDeg = clamp(data.headingFilterMaxJumpDeg, 15, 60, displaySettings.headingFilterMaxJumpDeg);
    displaySettings.headingFilterDeadbandDeg = clamp(data.headingFilterDeadbandDeg, 1, 8, displaySettings.headingFilterDeadbandDeg);
    displaySettings.headingFilterSmoothLevel = clampInt(data.headingFilterSmoothLevel, 1, 10, displaySettings.headingFilterSmoothLevel);
    displaySettings.headingFilterSampleMax = clampInt(data.headingFilterSampleMax, 5, 13, displaySettings.headingFilterSampleMax);
    displaySettings.headingFilterTurnConfirmSamples = clampInt(data.headingFilterTurnConfirmSamples, 2, 6, displaySettings.headingFilterTurnConfirmSamples);
    displaySettings.headingFilterMapSpikeRejectDeg = clamp(data.headingFilterMapSpikeRejectDeg, 20, 70, displaySettings.headingFilterMapSpikeRejectDeg);
    displaySettings.headingFilterMapBearingDeadbandDeg = clamp(data.headingFilterMapBearingDeadbandDeg, 1, 10, displaySettings.headingFilterMapBearingDeadbandDeg);
  }

  function speedKmhFromPosition(position) {
    const coords = position && position.coords ? position.coords : position;
    if (!coords) return null;
    const raw = num(coords.speed != null ? coords.speed : coords.velocity);
    if (raw == null || raw < 0) return null;
    return raw <= 60 ? raw * 3.6 : raw;
  }

  function headingFromPosition(position) {
    const coords = position && position.coords ? position.coords : position;
    if (!coords) return latestCompassHeading;
    const speedKmh = speedKmhFromPosition(position);
    const moving = speedKmh != null && speedKmh >= displaySettings.walkingSpeedKmh;
    if (!moving) return latestCompassHeading;
    const heading = num(coords.heading != null ? coords.heading : coords.bearing);
    if (heading == null) return latestCompassHeading;
    const filter = resolveHeadingFilterSettings();
    return ingestHeadingSample(heading, {
      maxJumpDeg: Math.min(75, filter.maxJumpDeg + 30),
      alpha: Math.min(0.38, headingFilterAlphaFromLevel(filter.smoothLevel) + 0.08),
      turnConfirmSamples: Math.max(2, filter.turnConfirmSamples - 1),
      sampleMax: filter.sampleMax,
      deadbandDeg: filter.deadbandDeg
    });
  }

  function readCompassHeadingFromEvent(event) {
    const webkit = num(event && event.webkitCompassHeading);
    const alpha = num(event && event.alpha);
    if (webkit != null) return webkit;
    if (alpha != null) return (360 - alpha) % 360;
    return null;
  }

  function updateCompassHeading(event) {
    const rawHeading = readCompassHeadingFromEvent(event);
    if (rawHeading == null) return;
    lastRawCompassHeading = normalizeHeadingValue(rawHeading);
    const filter = resolveHeadingFilterSettings();
    latestCompassHeading = ingestHeadingSample(rawHeading, {
      maxJumpDeg: filter.maxJumpDeg,
      alpha: headingFilterAlphaFromLevel(filter.smoothLevel),
      turnConfirmSamples: filter.turnConfirmSamples,
      sampleMax: filter.sampleMax,
      deadbandDeg: filter.deadbandDeg,
      preRejectDeg: Math.max(18, filter.maxJumpDeg * 0.75)
    });
    publishHeadingFilterDebugEvent();
    publishHeadingBurstIfNeeded();
  }

  function normalizeHeadingValue(heading) {
    const n = num(heading);
    return n == null ? null : ((n % 360) + 360) % 360;
  }

  function unwrapHeadingAround(referenceDeg, headingDeg) {
    const reference = normalizeHeadingValue(referenceDeg);
    const heading = normalizeHeadingValue(headingDeg);
    if (reference == null || heading == null) return heading;
    const delta = ((heading - reference + 540) % 360) - 180;
    return reference + delta;
  }

  function circularMedianHeading(sampleHeadings) {
    if (!sampleHeadings.length) return null;
    const reference = normalizeHeadingValue(sampleHeadings[sampleHeadings.length - 1]);
    if (reference == null) return null;
    const unwrapped = sampleHeadings
      .map(function (sample) { return unwrapHeadingAround(reference, sample); })
      .filter(function (value) { return value != null; })
      .sort(function (a, b) { return a - b; });
    if (!unwrapped.length) return null;
    return normalizeHeadingValue(unwrapped[Math.floor(unwrapped.length / 2)]);
  }

  function resetHeadingStabilizer() {
    headingStabilizerSamples = [];
    headingStabilizerStable = null;
    headingStabilizerOutput = null;
    headingStabilizerTurnCandidate = null;
    headingStabilizerTurnStreak = 0;
    latestCompassHeading = null;
    lastRawCompassHeading = null;
    lastHeadingRejectedRaw = null;
    lastHeadingRejectedMs = 0;
    lastHeadingBurstHeading = null;
    lastHeadingBurstMs = 0;
  }

  function getHeadingFilterDebug() {
    return {
      raw: lastRawCompassHeading,
      filtered: headingStabilizerOutput,
      stable: headingStabilizerStable,
      lastRejectedRaw: lastHeadingRejectedRaw,
      lastRejectedMs: lastHeadingRejectedMs,
      settings: resolveHeadingFilterSettings()
    };
  }

  function publishHeadingFilterDebugEvent() {
    global.dispatchEvent(new CustomEvent('capacitor-heading-filter-debug', { detail: getHeadingFilterDebug() }));
  }

  function ingestHeadingSample(rawHeading, options) {
    const normalized = normalizeHeadingValue(rawHeading);
    if (normalized == null) return headingStabilizerOutput;
    const filter = resolveHeadingFilterSettings();
    const opts = options || {};
    const maxJumpDeg = opts.maxJumpDeg != null ? opts.maxJumpDeg : filter.maxJumpDeg;
    const alpha = opts.alpha != null ? opts.alpha : headingFilterAlphaFromLevel(filter.smoothLevel);
    const turnConfirmSamples = opts.turnConfirmSamples != null ? opts.turnConfirmSamples : filter.turnConfirmSamples;
    const sampleMax = opts.sampleMax != null ? opts.sampleMax : filter.sampleMax;
    const deadbandDeg = opts.deadbandDeg != null ? opts.deadbandDeg : filter.deadbandDeg;
    const preRejectDeg = opts.preRejectDeg != null ? opts.preRejectDeg : Math.max(18, maxJumpDeg * 0.75);
    const turnToleranceDeg = Math.max(10, Math.min(18, maxJumpDeg * 0.35));

    if (headingStabilizerStable != null && headingDelta(normalized, headingStabilizerStable) > preRejectDeg) {
      lastHeadingRejectedRaw = normalized;
      lastHeadingRejectedMs = Date.now();
      return headingStabilizerOutput;
    }

    headingStabilizerSamples.push(normalized);
    if (headingStabilizerSamples.length > sampleMax) {
      headingStabilizerSamples.shift();
    }

    const medianHeading = circularMedianHeading(headingStabilizerSamples);
    if (medianHeading == null) return headingStabilizerOutput;

    if (headingStabilizerStable == null) {
      headingStabilizerStable = medianHeading;
      headingStabilizerOutput = medianHeading;
      headingStabilizerTurnCandidate = null;
      headingStabilizerTurnStreak = 0;
      return headingStabilizerOutput;
    }

    const jumpFromStable = headingDelta(medianHeading, headingStabilizerStable);
    if (jumpFromStable > maxJumpDeg) {
      if (headingStabilizerTurnCandidate != null &&
        headingDelta(medianHeading, headingStabilizerTurnCandidate) <= turnToleranceDeg) {
        headingStabilizerTurnStreak += 1;
      } else {
        headingStabilizerTurnCandidate = medianHeading;
        headingStabilizerTurnStreak = 1;
      }
      if (headingStabilizerTurnStreak >= turnConfirmSamples &&
        headingStabilizerSamples.length >= Math.min(3, sampleMax)) {
        const turnDelta = ((medianHeading - headingStabilizerStable + 540) % 360) - 180;
        headingStabilizerStable = normalizeHeadingValue(
          headingStabilizerStable + turnDelta * Math.max(alpha, 0.35)
        );
        headingStabilizerTurnCandidate = null;
        headingStabilizerTurnStreak = 0;
      } else {
        lastHeadingRejectedRaw = medianHeading;
        lastHeadingRejectedMs = Date.now();
      }
    } else {
      headingStabilizerTurnCandidate = null;
      headingStabilizerTurnStreak = 0;
      const delta = ((medianHeading - headingStabilizerStable + 540) % 360) - 180;
      headingStabilizerStable = normalizeHeadingValue(
        headingStabilizerStable + delta * alpha
      );
    }

    if (headingStabilizerOutput == null ||
      headingDelta(headingStabilizerStable, headingStabilizerOutput) >= deadbandDeg) {
      headingStabilizerOutput = headingStabilizerStable;
    }
    return headingStabilizerOutput;
  }

  function onCompassAbsoluteHeading(event) {
    if (readCompassHeadingFromEvent(event) == null) return;
    compassAbsoluteBound = true;
    updateCompassHeading(event);
  }

  function onCompassFallbackHeading(event) {
    if (compassAbsoluteBound && readCompassHeadingFromEvent(event) != null &&
      num(event && event.webkitCompassHeading) == null) {
      return;
    }
    updateCompassHeading(event);
  }

  function startCompassHeadingWatch() {
    if (compassHeadingBound || typeof global.DeviceOrientationEvent === 'undefined') return;
    compassHeadingBound = true;
    global.addEventListener('deviceorientationabsolute', onCompassAbsoluteHeading, true);
    global.addEventListener('deviceorientation', onCompassFallbackHeading, true);
    if (typeof global.DeviceOrientationEvent.requestPermission === 'function') {
      global.DeviceOrientationEvent.requestPermission().catch(function () {});
    }
  }

  function distanceMeters(latA, lonA, latB, lonB) {
    const earthRadiusM = 6371000;
    const toRad = function (d) { return d * Math.PI / 180; };
    const dLat = toRad(latB - latA);
    const dLon = toRad(lonB - lonA);
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(toRad(latA)) * Math.cos(toRad(latB)) *
      Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return 2 * earthRadiusM * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  function headingFromMovement(latA, lonA, latB, lonB) {
    const toRad = function (d) { return d * Math.PI / 180; };
    const y = Math.sin(toRad(lonB - lonA)) * Math.cos(toRad(latB));
    const x = Math.cos(toRad(latA)) * Math.sin(toRad(latB)) -
      Math.sin(toRad(latA)) * Math.cos(toRad(latB)) * Math.cos(toRad(lonB - lonA));
    return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
  }

  function isMoving(point, cfg) {
    if (!point) return false;
    if (lastLat != null && lastLon != null) {
      const d = distanceMeters(lastLat, lastLon, point.lat, point.lon);
      return d >= cfg.minMoveM || (point.speed != null && point.speed >= cfg.walkingSpeedKmh && d >= Math.min(cfg.minMoveM, 0.8));
    }
    return point.speed != null && point.speed >= cfg.walkingSpeedKmh;
  }

  function smoothSpeedKmh(speed, previousSpeed, cfg) {
    if (speed == null) return null;
    const previous = previousSpeed != null ? previousSpeed : 0;
    return speed > previous + cfg.speedJumpKmh ? previous + (speed - previous) * 0.35 : speed;
  }

  function getSendIntervalMs(moving) {
    if (uploadSettings.intervalMin > 0) return uploadSettings.intervalMin * 60 * 1000;
    const sec = moving ? uploadSettings.movingSec : uploadSettings.idleSec;
    return Math.max(1, sec) * 1000;
  }

  function isSendDue(point) {
    if (!point) return false;
    const intervalMs = getSendIntervalMs(isMoving(point, displaySettings));
    return lastSendMs <= 0 || Date.now() - lastSendMs >= intervalMs;
  }

  function isLiveSendDue(point, force) {
    if (force) return true;
    if (!point) return false;
    const intervalMs = getSendIntervalMs(isMoving(point, displaySettings));
    return lastLiveSendMs <= 0 || Date.now() - lastLiveSendMs >= intervalMs;
  }

  function resetFilterStates() {
    displayFilterState.stablePoint = null;
    displayFilterState.stationaryExitCount = 0;
    lastFinalLocalPoint = null;
  }

  async function trySendPosition(position, withTracking) {
    if (!serverUploadEnabled) return false;
    const finalPoint = await publishLocalPoint(position, withTracking);
    if (!finalPoint) return false;
    if (finalPoint.routePoint !== true) {
      return publishLivePointToServer(finalPoint);
    }
    if (!isSendDue(finalPoint)) {
      queueTrackPoint(finalPoint);
      return false;
    }
    return sendPointToServer(finalPoint, withTracking);
  }

  function buildDeviceKey(user, deviceName) {
    const u = sanitizePart(user, 'mobile');
    const d = sanitizePart(deviceName, '');
    return u + '/' + (d || ('phone-' + Math.random().toString(36).slice(2, 8)));
  }

  function splitDeviceKey(key) {
    const parts = String(key || '').split('/');
    return {
      user: sanitizePart(parts[0], 'mobile'),
      device: sanitizePart(parts.slice(1).join('/'), 'phone')
    };
  }

  function mqttTopicForDevice() {
    const parts = splitDeviceKey(deviceKey);
    return MQTT_TOPIC_PREFIX + '/' + parts.user + '/' + parts.device;
  }

  function mqttCommandTopicForDevice() {
    const parts = splitDeviceKey(deviceKey);
    return MQTT_TOPIC_PREFIX + '/commands/' + parts.user + '/' + parts.device;
  }

  function normalizeServerOrMqttUrl(value) {
    let raw = String(value || '').trim();
    if (!raw) return '';
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
      const defaultScheme = global.location && global.location.protocol === 'http:' ? 'http://' : 'https://';
      raw = defaultScheme + raw;
    }
    if (/^wss?:\/\//i.test(raw)) return raw;
    if (/^https?:\/\//i.test(raw)) {
      try {
        const parsed = new URL(raw);
        const protocol = parsed.protocol === 'https:' ? 'wss:' : 'ws:';
        return protocol + '//' + parsed.host + '/mqtt';
      } catch (error) {
        return '';
      }
    }
    return '';
  }

  function configuredServerInput() {
    return String(global.MOBILE_MQTT_WS_URL || configuredMqttWebSocketUrl || configuredServerUrl || '').trim();
  }

  function mqttWebSocketUrl() {
    const configured = normalizeServerOrMqttUrl(configuredServerInput());
    if (configured) return configured;
    if (global.location && /^https?:$/.test(global.location.protocol || '') && global.location.host) {
      const protocol = global.location.protocol === 'https:' ? 'wss:' : 'ws:';
      return protocol + '//' + global.location.host + '/mqtt';
    }
    return '';
  }

  function mqttHost() {
    const configured = String(global.MOBILE_MQTT_TCP_HOST || '').trim();
    if (configured) return configured;
    const explicit = String(localStorage.getItem('gpsTrackingMqttHost') || '').trim();
    if (explicit) return explicit;
    try {
      const wsUrl = mqttWebSocketUrl();
      if (wsUrl) return new URL(wsUrl).hostname;
    } catch (error) {}
    return global.location && /^https?:$/.test(global.location.protocol || '') && global.location.hostname
      ? global.location.hostname
      : '';
  }

  function mqttPort() {
    const configured = num(global.MOBILE_MQTT_TCP_PORT);
    if (configured != null && configured > 0) return Math.round(configured);
    const stored = num(localStorage.getItem('gpsTrackingMqttPort'));
    return stored != null && stored > 0 ? Math.round(stored) : 1883;
  }

  function hasConfiguredMqttTarget() {
    return !!mqttWebSocketUrl();
  }

  function ensureTrackId(reset) {
    let trackId = '';
    try {
      if (!reset && localStorage.getItem(TRACK_DEVICE_KEY_STORAGE_KEY) === deviceKey) {
        trackId = String(localStorage.getItem(TRACK_ID_STORAGE_KEY) || '').trim();
      }
      if (!trackId) {
        const safeKey = String(deviceKey || 'mobile/phone').replace(/[^a-zA-Z0-9._/-]/g, '-');
        trackId = safeKey + '-' + Date.now();
        localStorage.setItem(TRACK_ID_STORAGE_KEY, trackId);
        localStorage.setItem(TRACK_DEVICE_KEY_STORAGE_KEY, deviceKey);
        localStorage.setItem(TRACK_SEQUENCE_STORAGE_KEY, '0');
      }
    } catch (error) {
      trackId = trackId || String(deviceKey || 'mobile/phone') + '-' + Date.now();
    }
    return trackId;
  }

  function nextSequenceNumber() {
    let current = 0;
    try {
      current = Number(localStorage.getItem(TRACK_SEQUENCE_STORAGE_KEY) || '0') || 0;
      current += 1;
      localStorage.setItem(TRACK_SEQUENCE_STORAGE_KEY, String(current));
    } catch (error) {
      current = Date.now();
    }
    return current;
  }

  async function readBatteryLevel() {
    try {
      if (navigator.getBattery) {
        const battery = await navigator.getBattery();
        return Math.round(battery.level * 100);
      }
    } catch (error) {}
    return null;
  }

  function pointFromNative(position) {
    const coords = position && position.coords ? position.coords : position || {};
    const lat = num(coords.latitude != null ? coords.latitude : coords.lat);
    const lon = num(coords.longitude != null ? coords.longitude : coords.lng);
    if (lat == null || lon == null) return null;
    return {
      lat: lat,
      lon: lon,
      accuracy: num(coords.accuracy),
      speed: speedKmhFromPosition(position),
      heading: headingFromPosition(position),
      battery: null,
      timestamp: position.timestamp || position.time || Date.now()
    };
  }

  function stabilizeLocalPoint(point, cfg, filterState) {
    if (!point || !cfg || !filterState) return null;
    let stablePoint = filterState.stablePoint;
    let stationaryExitCount = filterState.stationaryExitCount || 0;
    if (!stablePoint) {
      if (point.accuracy != null && point.accuracy > cfg.maxAccuracyM) return null;
      stablePoint = Object.assign({}, point);
      filterState.stablePoint = stablePoint;
      filterState.stationaryExitCount = 0;
      return Object.assign({}, point, { rawLat: point.lat, rawLon: point.lon, stationary: false });
    }
    const stationaryPoint = function () {
      const liveHeading = point.heading != null ? point.heading : stablePoint.heading;
      if (point.heading != null) stablePoint.heading = point.heading;
      return Object.assign({}, point, {
        rawLat: point.lat,
        rawLon: point.lon,
        lat: stablePoint.lat,
        lon: stablePoint.lon,
        accuracy: stablePoint.accuracy,
        speed: point.speed != null && point.speed >= cfg.walkingSpeedKmh ? smoothSpeedKmh(point.speed, stablePoint.speed, cfg) : 0,
        heading: liveHeading,
        stationary: true
      });
    };
    const accuracy = point.accuracy != null ? point.accuracy : 0;
    const driftRadius = Math.max(cfg.stationaryRadiusM, Math.min(cfg.stationaryMaxRadiusM, accuracy * 1.5));
    const distance = distanceMeters(stablePoint.lat, stablePoint.lon, point.lat, point.lon);
    const dtSeconds = Math.max(0.2, ((point.timestamp || Date.now()) - (stablePoint.timestamp || Date.now())) / 1000);
    const inferredSpeedKmh = dtSeconds < 20 ? distance / dtSeconds * 3.6 : null;
    if ((point.speed == null || point.speed < cfg.walkingSpeedKmh) &&
      inferredSpeedKmh != null && inferredSpeedKmh >= cfg.walkingSpeedKmh && distance >= Math.min(cfg.minMoveM, 0.8)) {
      point.speed = smoothSpeedKmh(inferredSpeedKmh, stablePoint.speed, cfg);
    }
    if (point.speed != null && point.speed >= cfg.walkingSpeedKmh && distance >= Math.min(cfg.minMoveM, 0.8) &&
      cfg === displaySettings) {
      const moveHeading = headingFromMovement(stablePoint.lat, stablePoint.lon, point.lat, point.lon);
      const filter = resolveHeadingFilterSettings();
      point.heading = ingestHeadingSample(moveHeading, {
        maxJumpDeg: Math.min(75, filter.maxJumpDeg + 30),
        alpha: Math.min(0.38, headingFilterAlphaFromLevel(filter.smoothLevel) + 0.08),
        turnConfirmSamples: Math.max(2, filter.turnConfirmSamples - 1),
        sampleMax: filter.sampleMax,
        deadbandDeg: filter.deadbandDeg
      });
    }
    if (point.accuracy != null && point.accuracy > cfg.maxAccuracyM) {
      filterState.stationaryExitCount = stationaryExitCount;
      return stationaryPoint();
    }
    const speedMotionCandidate = point.speed != null && point.speed >= cfg.walkingSpeedKmh && distance >= Math.min(cfg.minMoveM, 0.8);
    const movingNow = distance > driftRadius || (point.speed != null && point.speed >= cfg.movingSpeedKmh && distance >= 1.5) ||
      (speedMotionCandidate && stationaryExitCount + 1 >= cfg.confirmPoints);
    if (!movingNow && distance <= driftRadius && !speedMotionCandidate) {
      if (point.accuracy != null && (stablePoint.accuracy == null || point.accuracy + 1 < stablePoint.accuracy) &&
        distance <= Math.max(5, driftRadius * 0.5)) stablePoint = Object.assign({}, stablePoint, point);
      stablePoint.speed = 0;
      stationaryExitCount = 0;
      filterState.stablePoint = stablePoint;
      filterState.stationaryExitCount = stationaryExitCount;
      return stationaryPoint();
    }
    if (movingNow && (stablePoint.speed == null || stablePoint.speed <= cfg.walkingSpeedKmh) &&
      distance <= Math.max(35, driftRadius * 1.5) && ++stationaryExitCount < cfg.confirmPoints) {
      filterState.stationaryExitCount = stationaryExitCount;
      return stationaryPoint();
    }
    if (!movingNow && ++stationaryExitCount < cfg.confirmPoints) {
      stablePoint.speed = 0;
      filterState.stablePoint = stablePoint;
      filterState.stationaryExitCount = stationaryExitCount;
      return stationaryPoint();
    }
    stationaryExitCount = 0;
    point.speed = smoothSpeedKmh(point.speed, stablePoint.speed, cfg);
    stablePoint = Object.assign({}, point);
    filterState.stablePoint = stablePoint;
    filterState.stationaryExitCount = stationaryExitCount;
    return Object.assign({}, point, { rawLat: point.lat, rawLon: point.lon, stationary: false });
  }

  function firstFixAccuracyLimit(cfg) {
    return Math.max(
      num(cfg && cfg.maxAccuracyM) || 0,
      num(cfg && cfg.stationaryRadiusM) || 0,
      num(cfg && cfg.stationaryMaxRadiusM) || 0
    );
  }

  function stabilizeDisplayPoint(point, options) {
    const displayPoint = stabilizeLocalPoint(Object.assign({}, point), displaySettings, displayFilterState);
    if (displayPoint) return displayPoint;
    const firstFix = !!(options && options.firstFix) && !getLastLocalPoint() && !displayFilterState.stablePoint;
    if (!firstFix || !point) return null;
    const limit = firstFixAccuracyLimit(displaySettings);
    if (point.accuracy != null && limit > 0 && point.accuracy > limit) return null;
    const firstPoint = Object.assign({}, point);
    displayFilterState.stablePoint = firstPoint;
    displayFilterState.stationaryExitCount = 0;
    return Object.assign({}, point, {
      rawLat: point.lat,
      rawLon: point.lon,
      stationary: false,
      firstFix: true
    });
  }

  async function enrichPoint(point) {
    if (!point) return null;
    point.battery = await readBatteryLevel();
    return point;
  }

  function readQueue() {
    try {
      const raw = localStorage.getItem(QUEUE_STORAGE_KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed : [];
    } catch (error) {
      return [];
    }
  }

  function writeQueue(queue) {
    localStorage.setItem(QUEUE_STORAGE_KEY, JSON.stringify(queue.slice(-500)));
    dispatchQueueState(queue);
  }

  function dispatchQueueState(queue) {
    const pending = Array.isArray(queue) ? queue.length : readQueue().length;
    global.dispatchEvent(new CustomEvent('capacitor-sync-queue', {
      detail: { deviceKey: deviceKey, pending: pending, updatedAt: Date.now() }
    }));
  }

  function readLocalRoute() {
    try {
      const raw = localStorage.getItem(LOCAL_ROUTE_STORAGE_KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed : [];
    } catch (error) {
      return [];
    }
  }

  function readRouteSegmentId() {
    try {
      const raw = Number(localStorage.getItem(LOCAL_ROUTE_SEGMENT_STORAGE_KEY) || '0');
      return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : 0;
    } catch (error) {
      return 0;
    }
  }

  function writeRouteSegmentId(segmentId) {
    try {
      localStorage.setItem(LOCAL_ROUTE_SEGMENT_STORAGE_KEY, String(Math.max(0, Math.floor(Number(segmentId) || 0))));
    } catch (error) {}
  }

  function routeBreakPending() {
    try {
      return String(localStorage.getItem(LOCAL_ROUTE_BREAK_STORAGE_KEY) || '0') === '1';
    } catch (error) {
      return false;
    }
  }

  function setRouteBreakPending(pending) {
    try {
      if (pending) localStorage.setItem(LOCAL_ROUTE_BREAK_STORAGE_KEY, '1');
      else localStorage.removeItem(LOCAL_ROUTE_BREAK_STORAGE_KEY);
    } catch (error) {}
  }

  function beginNewRouteSegment() {
    writeRouteSegmentId(readRouteSegmentId() + 1);
    routeReductionState.lastRoutePoint = null;
    setRouteBreakPending(true);
  }

  function lastStoredRoutePoint() {
    const route = readLocalRoute();
    for (let i = route.length - 1; i >= 0; i -= 1) {
      const point = route[i];
      if (point && num(point.lat) != null && num(point.lon) != null) return point;
    }
    return null;
  }

  function readStoredFinalLocalPoint() {
    try {
      const raw = localStorage.getItem(LOCAL_FINAL_POINT_STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && num(parsed.lat) != null && num(parsed.lon) != null) {
          return parsed;
        }
      }
      const route = readLocalRoute();
      for (let i = route.length - 1; i >= 0; i -= 1) {
        const point = route[i];
        if (point && num(point.lat) != null && num(point.lon) != null) return point;
      }
    } catch (error) {}
    return null;
  }

  function getLastLocalPoint() {
    return lastFinalLocalPoint || readStoredFinalLocalPoint();
  }

  function localRoutePoint(point) {
    return {
      lat: point.lat,
      lon: point.lon,
      rawLat: point.rawLat,
      rawLon: point.rawLon,
      timestamp: point.timestamp,
      accuracy: point.accuracy,
      speed: point.speed,
      heading: point.heading,
      source: point.source || 'mobile_app',
      trackId: point.trackId || null,
      sequenceNumber: point.sequenceNumber != null ? point.sequenceNumber : null,
      routePoint: true,
      final: true,
      segmentId: point.segmentId != null ? point.segmentId : readRouteSegmentId(),
      breakBefore: !!point.breakBefore
    };
  }

  function storeFinalLocalPoint(point, withTrackingFlag) {
    if (!point) return;
    try {
      localStorage.setItem(LOCAL_FINAL_POINT_STORAGE_KEY, JSON.stringify(point));
      if (!withTrackingFlag || point.routePoint !== true) return;
      const route = readLocalRoute();
      const last = route.length ? route[route.length - 1] : null;
      const duplicate = last &&
        ((last.sequenceNumber != null && point.sequenceNumber != null && last.sequenceNumber === point.sequenceNumber && last.trackId === point.trackId) ||
        (last.timestamp === point.timestamp && last.lat === point.lat && last.lon === point.lon));
      if (!duplicate) {
        const routePoint = localRoutePoint(point);
        route.push(routePoint);
        localStorage.setItem(LOCAL_ROUTE_STORAGE_KEY, JSON.stringify(route.slice(-2000)));
        routeReductionState.lastRoutePoint = routePoint;
        if (point.breakBefore) setRouteBreakPending(false);
        queueTrackPoint(routePoint);
      }
    } catch (error) {}
  }

  function openTileDb() {
    return new Promise(function (resolve, reject) {
      const req = indexedDB.open(TILE_DB, 1);
      req.onupgradeneeded = function () {
        req.result.createObjectStore(TILE_STORE);
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
  }

  async function tileGet(key) {
    const db = await openTileDb();
    return new Promise(function (resolve, reject) {
      const tx = db.transaction(TILE_STORE, 'readonly');
      const req = tx.objectStore(TILE_STORE).get(key);
      req.onsuccess = function () { resolve(req.result || null); };
      req.onerror = function () { reject(req.error); };
    });
  }

  async function tilePut(key, blob) {
    const db = await openTileDb();
    return new Promise(function (resolve, reject) {
      const tx = db.transaction(TILE_STORE, 'readwrite');
      const req = tx.objectStore(TILE_STORE).put(blob, key);
      req.onsuccess = function () { resolve(true); };
      req.onerror = function () { reject(req.error); };
    });
  }

  async function isOnline() {
    const Network = plugins().Network;
    if (Network) {
      try {
        const status = await Network.getStatus();
        return !!status.connected;
      } catch (error) {}
    }
    return navigator.onLine !== false;
  }

  function liveSamplePoint(point) {
    if (!point) return null;
    const livePoint = Object.assign({}, point, {
      routePoint: false,
      final: false,
      liveSample: true
    });
    delete livePoint.segmentId;
    delete livePoint.breakBefore;
    return livePoint;
  }

  function trackPayloadFromPoint(point, allowLiveSample) {
    if (!point) return null;
    const isRoutePoint = point.routePoint === true && point.final === true;
    if (!isRoutePoint && !allowLiveSample) return null;
    const lat = num(point.lat);
    const lon = num(point.lon != null ? point.lon : point.lng);
    if (lat == null || lon == null) return null;
    const incomingSequence = point.sequenceNumber != null ? Number(point.sequenceNumber) : null;
    const payload = {
      lat: lat,
      lon: lon,
      timestamp: num(point.timestamp) || Date.now(),
      speed: num(point.speed),
      heading: num(point.heading),
      accuracy: num(point.accuracy),
      source: 'mobile_app',
      trackId: point.trackId || (isRoutePoint ? ensureTrackId(false) : null),
      sequenceNumber: isRoutePoint ? (Number.isFinite(incomingSequence) ? incomingSequence : nextSequenceNumber()) : null,
      routePoint: isRoutePoint,
      final: isRoutePoint,
      liveSample: !isRoutePoint
    };
    if (point.segmentId != null) payload.segmentId = point.segmentId;
    if (point.breakBefore) payload.breakBefore = true;
    return payload;
  }

  function queuedTrackPayload(point) {
    const payload = trackPayloadFromPoint(point);
    if (payload) payload._mqttTopic = point._mqttTopic || mqttTopicForDevice();
    return payload ? Object.assign({}, payload) : null;
  }

  function queueTrackPoint(point) {
    const uploadPoint = queuedTrackPayload(point);
    if (!uploadPoint) return false;
    const queue = readQueue();
    const duplicate = queue.some(function (queuedPoint) {
      return queuedPoint &&
        ((queuedPoint.trackId === uploadPoint.trackId &&
          queuedPoint.sequenceNumber === uploadPoint.sequenceNumber) ||
        (queuedPoint.timestamp === uploadPoint.timestamp &&
          queuedPoint.lat === uploadPoint.lat &&
          queuedPoint.lon === uploadPoint.lon));
    });
    if (!duplicate) {
      queue.push(uploadPoint);
      writeQueue(queue);
    }
    return true;
  }

  function queuedTrackPointMatches(queuedPoint, uploadPoint) {
    return queuedPoint && uploadPoint &&
      ((queuedPoint.trackId === uploadPoint.trackId &&
        queuedPoint.sequenceNumber === uploadPoint.sequenceNumber) ||
      (queuedPoint.timestamp === uploadPoint.timestamp &&
        queuedPoint.lat === uploadPoint.lat &&
        queuedPoint.lon === uploadPoint.lon));
  }

  function mergeRoutePoints(target, incoming, limit) {
    const merged = Array.isArray(target) ? target.slice() : [];
    (Array.isArray(incoming) ? incoming : []).forEach(function (point) {
      if (!point || point.routePoint !== true || point.final !== true || num(point.lat) == null || num(point.lon) == null) return;
      const duplicate = merged.some(function (existing) {
        return queuedTrackPointMatches(existing, point);
      });
      if (!duplicate) merged.push(point);
    });
    merged.sort(function (a, b) {
      return (Number(a && a.timestamp) || 0) - (Number(b && b.timestamp) || 0);
    });
    return merged.slice(-Math.max(1, limit || 2000));
  }

  function parseJsonArray(text) {
    try {
      const parsed = typeof text === 'string' ? JSON.parse(text) : text;
      return Array.isArray(parsed) ? parsed : [];
    } catch (error) {
      return [];
    }
  }

  function removeQueuedTrackPoint(point) {
    const uploadPoint = queuedTrackPayload(point) || point;
    if (!uploadPoint) return false;
    const queue = readQueue();
    const nextQueue = queue.filter(function (queuedPoint) {
      return !queuedTrackPointMatches(queuedPoint, uploadPoint);
    });
    if (nextQueue.length !== queue.length) {
      writeQueue(nextQueue);
      return true;
    }
    return false;
  }

  async function importNativeBufferedRoute() {
    const nativeUpload = nativeUploadPlugin();
    if (!nativeUpload || typeof nativeUpload.getBufferedRoute !== 'function') return false;
    try {
      const result = await nativeUpload.getBufferedRoute({});
      const nativeRoute = parseJsonArray(result && result.localRouteJson);
      const nativeQueue = parseJsonArray(result && result.queueJson);
      let changed = false;
      if (nativeRoute.length) {
        const mergedRoute = mergeRoutePoints(readLocalRoute(), nativeRoute, 2000);
        localStorage.setItem(LOCAL_ROUTE_STORAGE_KEY, JSON.stringify(mergedRoute));
        routeReductionState.lastRoutePoint = mergedRoute.length ? mergedRoute[mergedRoute.length - 1] : null;
        lastFinalLocalPoint = routeReductionState.lastRoutePoint || lastFinalLocalPoint;
        changed = true;
      }
      if (nativeQueue.length) {
        writeQueue(mergeRoutePoints(readQueue(), nativeQueue, 500));
        changed = true;
      } else {
        dispatchQueueState(readQueue());
      }
      if (result && result.tracking != null) {
        trackingActive = !!result.tracking || trackingActive;
        localStorage.setItem(TRACKING_ACTIVE_STORAGE_KEY, trackingActive ? '1' : '0');
      }
      if (lastFinalLocalPoint) {
        global.dispatchEvent(new CustomEvent('capacitor-gps-point', { detail: lastFinalLocalPoint }));
      }
      return changed;
    } catch (error) {
      return false;
    }
  }

  function resetLocalRoute() {
    try {
      localStorage.removeItem(LOCAL_ROUTE_STORAGE_KEY);
      localStorage.removeItem(QUEUE_STORAGE_KEY);
      localStorage.removeItem(LOCAL_FINAL_POINT_STORAGE_KEY);
      localStorage.removeItem(LOCAL_ROUTE_BREAK_STORAGE_KEY);
      localStorage.removeItem(TRACK_ID_STORAGE_KEY);
      localStorage.removeItem(TRACK_DEVICE_KEY_STORAGE_KEY);
      localStorage.setItem(TRACK_SEQUENCE_STORAGE_KEY, '0');
      localStorage.setItem(TRACKING_ACTIVE_STORAGE_KEY, '0');
      localStorage.setItem(TRACKING_STOPPED_AT_STORAGE_KEY, String(Date.now()));
      trackingActive = false;
      routeReductionState.lastRoutePoint = null;
      lastFinalLocalPoint = null;
      writeRouteSegmentId(readRouteSegmentId() + 1);
      dispatchQueueState([]);
      const nativeUpload = nativeUploadPlugin();
      if (nativeUpload && typeof nativeUpload.resetRouteState === 'function') {
        Promise.resolve(nativeUpload.resetRouteState({})).catch(function () {});
      }
    } catch (error) {}
    global.dispatchEvent(new CustomEvent('capacitor-local-route-reset', {
      detail: { deviceKey: deviceKey, updatedAt: Date.now() }
    }));
  }

  function loadMqttScript() {
    if (global.mqtt && typeof global.mqtt.connect === 'function') return Promise.resolve(true);
    if (mqttScriptPromise) return mqttScriptPromise;
    mqttScriptPromise = new Promise(function (resolve, reject) {
      const script = document.createElement('script');
      script.src = MQTT_SCRIPT_PATH;
      script.async = true;
      script.onload = function () { resolve(!!(global.mqtt && typeof global.mqtt.connect === 'function')); };
      script.onerror = function () { reject(new Error('MQTT client library not available')); };
      document.head.appendChild(script);
    });
    return mqttScriptPromise;
  }

  async function ensureMqttClient() {
    if (!serverUploadEnabled || !(await isOnline())) return null;
    const targetUrl = mqttWebSocketUrl();
    if (!targetUrl) {
      setStatus('Kein Server konfiguriert - nur lokale Anzeige');
      dispatchTransportState({ connected: false, connecting: false, serverConfigured: false });
      return null;
    }
    if (mqttClient && mqttClient.connected) return mqttClient;
    if (mqttConnectPromise) return mqttConnectPromise;
    mqttConnectPromise = loadMqttScript().then(function () {
      return new Promise(function (resolve) {
        if (!global.mqtt || typeof global.mqtt.connect !== 'function') {
          resolve(null);
          return;
        }
        const clientId = 'mobile_app_' + sanitizePart(deviceKey, 'phone').replace(/[/.]/g, '_') + '_' + Math.random().toString(16).slice(2);
        const client = global.mqtt.connect(targetUrl, {
          clientId: clientId,
          clean: true,
          connectTimeout: 5000,
          reconnectPeriod: 0
        });
        let settled = false;
        const finish = function (value) {
          if (settled) return;
          settled = true;
          resolve(value);
        };
        client.on('connect', function () {
          mqttClient = client;
          try {
            client.subscribe(mqttCommandTopicForDevice(), { qos: 1 }, function () {});
          } catch (error) {}
          dispatchTransportState({ connected: true, connecting: false, serverConfigured: true });
          finish(client);
        });
        client.on('message', function (topic, payload) {
          handleMqttCommand(topic, payload);
        });
        client.on('error', function () {
          try { client.end(true); } catch (error) {}
          finish(null);
        });
        client.on('close', function () {
          if (mqttClient === client && !client.connected) mqttClient = null;
          if (serverUploadEnabled) {
            dispatchTransportState({ connected: false, connecting: false, serverConfigured: !!mqttWebSocketUrl() });
          }
        });
        setTimeout(function () { finish(client.connected ? client : null); }, 5500);
      });
    }).catch(function () {
      return null;
    }).finally(function () {
      mqttConnectPromise = null;
    });
    return mqttConnectPromise;
  }

  function parseMqttCommandPayload(payload) {
    if (!payload) return null;
    let text = typeof payload === 'string' ? payload : '';
    if (!text && payload instanceof Uint8Array && typeof TextDecoder !== 'undefined') {
      try {
        text = new TextDecoder('utf-8').decode(payload);
      } catch (error) {}
    }
    if (!text) text = String(payload);
    try {
      return JSON.parse(text);
    } catch (error) {
      return null;
    }
  }

  function handleMqttCommand(topic, payload) {
    if (String(topic || '') !== mqttCommandTopicForDevice()) return false;
    const command = parseMqttCommandPayload(payload);
    const action = String(command && command.action || '').trim();
    if (action === 'sync_saved_items' || action === 'syncSavedItems') {
      if (typeof global.__syncLocalSavedItems === 'function') {
        Promise.resolve(global.__syncLocalSavedItems({ remoteCommand: true })).catch(function () {});
      } else {
        global.dispatchEvent(new CustomEvent('capacitor-sync-saved-items-requested', { detail: command || {} }));
      }
      return true;
    }
    if (action !== 'request_location_update' && action !== 'requestLocation') return true;
    const latestPoint = getLastLocalPoint();
    if (latestPoint) {
      global.dispatchEvent(new CustomEvent('capacitor-gps-point', { detail: latestPoint }));
      if (serverUploadEnabled) {
        if (latestPoint.routePoint === true) sendPointToServer(latestPoint, trackingActive).catch(function () {});
        else publishLivePointToServer(latestPoint, true).catch(function () {});
      }
    }
    requestLocationNow({ tracking: trackingActive, commandResponse: true })
      .catch(function () {});
    return true;
  }

  async function publishMqttPoint(point) {
    const payload = queuedTrackPayload(point);
    if (!payload) return false;
    const client = await ensureMqttClient();
    if (!client || !client.connected) return false;
    const topic = payload._mqttTopic || mqttTopicForDevice();
    const wirePayload = Object.assign({}, payload);
    delete wirePayload._mqttTopic;
    return new Promise(function (resolve) {
      client.publish(topic, JSON.stringify(wirePayload), { qos: 1, retain: false }, function (error) {
        resolve(!error);
      });
    });
  }

  async function publishLivePointToServer(point, force) {
    if (!point || !serverUploadEnabled) return false;
    if (!isLiveSendDue(point, force)) return false;
    const payload = trackPayloadFromPoint(liveSamplePoint(point), true);
    if (!payload || payload.routePoint === true) return false;
    payload._mqttTopic = point._mqttTopic || mqttTopicForDevice();
    const online = await isOnline();
    if (!online) return false;
    const client = await ensureMqttClient();
    if (!client || !client.connected) return false;
    const topic = payload._mqttTopic || mqttTopicForDevice();
    const wirePayload = Object.assign({}, payload);
    delete wirePayload._mqttTopic;
    const ok = await new Promise(function (resolve) {
      client.publish(topic, JSON.stringify(wirePayload), { qos: 1, retain: false }, function (error) {
        resolve(!error);
      });
    });
    if (ok) {
      lastLiveSendMs = Date.now();
      dispatchTransportState({ connected: true, connecting: false, serverConfigured: true });
      global.dispatchEvent(new CustomEvent('capacitor-live-sent', {
        detail: {
          deviceKey: deviceKey,
          count: 1,
          transport: 'mqtt',
          kind: 'live',
          receivedAt: lastLiveSendMs
        }
      }));
    }
    return ok;
  }

  async function postPoints(points, withTrackingFlag) {
    if (!points || !points.length || !deviceKey) return false;
    for (let i = 0; i < points.length; i += 1) {
      const ok = await publishMqttPoint(points[i]);
      if (!ok) return false;
    }
    global.dispatchEvent(new CustomEvent('capacitor-points-uploaded', {
      detail: { deviceKey: deviceKey, count: points.length, transport: 'mqtt', kind: 'route', receivedAt: Date.now() }
    }));
    return true;
  }

  async function flushQueue() {
    if (syncInFlight || !serverUploadEnabled) return;
    if (!(await isOnline())) return;
    const queue = readQueue();
    if (!queue.length) return;
    syncInFlight = true;
    try {
      const chunk = queue.slice(0, 40);
      const ok = await postPoints(chunk, trackingActive);
      if (ok) {
        writeQueue(queue.slice(chunk.length));
        if (readQueue().length) await flushQueue();
      }
    } finally {
      syncInFlight = false;
    }
  }

  async function sendLastLocalPointIfAvailable() {
    if (!serverUploadEnabled) return false;
    const point = getLastLocalPoint();
    if (!point) return false;
    if (point.routePoint !== true) return publishLivePointToServer(point, true);
    return sendPointToServer(point, trackingActive);
  }

  function setStatus(text) {
    const el = document.getElementById('nativeGpsStatus');
    if (el) el.textContent = text;
    global.dispatchEvent(new CustomEvent('capacitor-bridge-status', { detail: text }));
  }

  function dispatchTransportState(data) {
    global.dispatchEvent(new CustomEvent('capacitor-bridge-transport', {
      detail: Object.assign({
        deviceKey: deviceKey,
        transport: 'mqtt',
        serverUploadEnabled: serverUploadEnabled,
        serverConfigured: hasConfiguredMqttTarget(),
        updatedAt: Date.now()
      }, data || {})
    }));
  }

  async function publishPoint(base, withTrackingFlag) {
    if (!base) return null;
    const point = await enrichPoint(base);
    point.deviceKey = deviceKey;
    point.source = 'mobile_app';
    point.filters = displayFilterSettingsPayload();
    markRoutePointIfNeeded(point, withTrackingFlag != null ? !!withTrackingFlag : trackingActive);
    lastFinalLocalPoint = Object.assign({}, point);
    storeFinalLocalPoint(point, withTrackingFlag != null ? !!withTrackingFlag : trackingActive);
    global.dispatchEvent(new CustomEvent('capacitor-gps-point', { detail: point }));
    return point;
  }

  function positionFilterPayload(cfg) {
    return {
      minMoveM: cfg.minMoveM,
      maxAccuracyM: cfg.maxAccuracyM,
      walkingSpeedKmh: cfg.walkingSpeedKmh,
      movingSpeedKmh: cfg.movingSpeedKmh,
      stationaryRadiusM: cfg.stationaryRadiusM,
      stationaryMaxRadiusM: cfg.stationaryMaxRadiusM,
      confirmPoints: cfg.confirmPoints,
      speedJumpKmh: cfg.speedJumpKmh
    };
  }

  function displayFilterSettingsPayload() {
    return positionFilterPayload(displaySettings);
  }

  function headingDelta(a, b) {
    if (a == null || b == null) return Infinity;
    const d = Math.abs(a - b) % 360;
    return d > 180 ? 360 - d : d;
  }

  function movementHeadingForRoute(previousPoint, point) {
    if (!previousPoint || !point) return point && point.heading != null ? point.heading : null;
    const distance = distanceMeters(previousPoint.lat, previousPoint.lon, point.lat, point.lon);
    if (distance >= Math.max(0.8, displaySettings.minMoveM || 1)) {
      return headingFromMovement(previousPoint.lat, previousPoint.lon, point.lat, point.lon);
    }
    return point.heading != null ? point.heading : previousPoint.heading;
  }

  function routeDistanceTargetMeters(point, previousPoint, headingChanged) {
    const cfg = displaySettings;
    const speed = Math.max(0, num(point && point.speed) || 0);
    const minMove = cfg.minMoveM || 1;
    if (speed < 7) return Math.max(minMove, headingChanged ? 0.4 : 0.9);
    if (speed < 15) return Math.max(minMove, headingChanged ? 0.8 : 1.4);
    if (speed < 30) return Math.max(minMove, headingChanged ? 1.2 : 2.4);
    if (speed < 50) return Math.max(minMove, headingChanged ? 2 : 4);
    return Math.max(minMove, headingChanged ? 4 : 8);
  }

  function routePointDecision(point, withTrackingFlag) {
    if (!point || !withTrackingFlag) return { accept: false };
    if (point.accuracy != null && point.accuracy > (displaySettings.maxAccuracyM || 20)) return { accept: false };
    if (point.stationary && point.speed != null && point.speed < (displaySettings.walkingSpeedKmh || 1.6)) {
      const lastStationaryRoute = routeReductionState.lastRoutePoint || lastStoredRoutePoint();
      if (lastStationaryRoute) {
        const stationaryDistance = distanceMeters(lastStationaryRoute.lat, lastStationaryRoute.lon, point.lat, point.lon);
        const stationaryLimit = Math.max(displaySettings.minMoveM || 1, Math.min(displaySettings.stationaryRadiusM || 18, (num(point.accuracy) || 0) * 1.3));
        if (stationaryDistance < stationaryLimit) return { accept: false };
      }
    }
    const previous = routeReductionState.lastRoutePoint || lastStoredRoutePoint();
    const breakBefore = routeBreakPending();
    if (!previous || breakBefore) {
      return { accept: true, breakBefore: breakBefore };
    }
    const distance = distanceMeters(previous.lat, previous.lon, point.lat, point.lon);
    const prevTime = Number(previous.timestamp || 0);
    const currentTime = Number(point.timestamp || Date.now());
    const elapsedSeconds = prevTime > 0 && currentTime > prevTime ? (currentTime - prevTime) / 1000 : null;
    if (elapsedSeconds && elapsedSeconds < 0.25) return { accept: false };
    if (elapsedSeconds && distance / elapsedSeconds * 3.6 > Math.max(80, (num(previous.speed) || 0) + (displaySettings.speedJumpKmh || 8) * 6)) {
      return { accept: false };
    }
    const previousHeading = previous.heading != null ? previous.heading : movementHeadingForRoute(previous, point);
    const currentHeading = movementHeadingForRoute(previous, point);
    const headingChange = headingDelta(previousHeading, currentHeading);
    const headingChanged = headingChange >= Math.max(10, (displaySettings.headingFilterMapBearingDeadbandDeg || 6) * 1.6);
    const targetDistance = routeDistanceTargetMeters(point, previous, headingChanged);
    const keepAliveMs = 5 * 60 * 1000;
    const timeKeepAlive = prevTime > 0 && currentTime - prevTime >= keepAliveMs && distance >= Math.max(displaySettings.minMoveM || 1, targetDistance * 0.5);
    return { accept: distance >= targetDistance || timeKeepAlive, breakBefore: false };
  }

  function markRoutePointIfNeeded(point, withTrackingFlag) {
    const decision = routePointDecision(point, withTrackingFlag);
    if (!decision.accept) {
      point.liveSample = true;
      point.routePoint = false;
      point.final = false;
      return point;
    }
    point.liveSample = true;
    point.routePoint = true;
    point.final = true;
    point.trackId = point.trackId || ensureTrackId(false);
    if (point.sequenceNumber == null) point.sequenceNumber = nextSequenceNumber();
    point.segmentId = readRouteSegmentId();
    point.breakBefore = !!decision.breakBefore;
    return point;
  }

  function publishHeadingBurstIfNeeded() {
    const finalStable = lastFinalLocalPoint || displayFilterState.stablePoint;
    if (!finalStable || latestCompassHeading == null || document.hidden) return;
    const now = Date.now();
    if (headingDelta(latestCompassHeading, lastHeadingBurstHeading) < uploadSettings.headingBurstDeg) return;
    if (now - lastHeadingBurstMs < uploadSettings.headingBurstSec * 1000) return;
    if (headingBurstInFlight || !serverUploadEnabled) return;
    lastHeadingBurstMs = now;
    lastHeadingBurstHeading = latestCompassHeading;
    const point = Object.assign({}, finalStable, {
      heading: latestCompassHeading,
      timestamp: now,
      stationary: true,
      deviceKey: deviceKey,
      filters: displayFilterSettingsPayload(),
      liveSample: true,
      routePoint: false,
      final: false
    });
    headingBurstInFlight = true;
    enrichPoint(point).then(function (enriched) {
      if (!enriched) return;
      enriched.filters = displayFilterSettingsPayload();
      global.dispatchEvent(new CustomEvent('capacitor-gps-point', { detail: enriched }));
      return publishLivePointToServer(enriched, true);
    }).catch(function () {}).finally(function () {
      headingBurstInFlight = false;
    });
  }

  async function publishLocalPoint(position, withTrackingFlag) {
    const raw = pointFromNative(position);
    if (!raw) return null;
    const filtered = stabilizeDisplayPoint(raw, { firstFix: !getLastLocalPoint() });
    if (!filtered) return null;
    return publishPoint(filtered, withTrackingFlag);
  }

  async function sendPointToServer(point, withTracking) {
    if (!point || !serverUploadEnabled) return false;
    const uploadPoint = queuedTrackPayload(point);
    if (!uploadPoint) return false;
    const online = await isOnline();
    if (online) {
      const ok = await postPoints([uploadPoint], withTracking);
      if (!ok) {
        queueTrackPoint(uploadPoint);
      } else {
        lastLat = point.lat;
        lastLon = point.lon;
        lastSendMs = Date.now();
        removeQueuedTrackPoint(uploadPoint);
        await flushQueue();
        const mode = withTracking ? 'Tracking' : 'Live';
        setStatus(mode + ' — Punkt gesendet');
      }
      return ok;
    }
    queueTrackPoint(uploadPoint);
    setStatus('Offline — Punkt zwischengespeichert');
    return false;
  }

  async function sendPoint(position, withTracking) {
    const displayPoint = await publishLocalPoint(position, withTracking);
    if (!displayPoint) return false;
    if (!serverUploadEnabled) {
      lastLat = displayPoint.lat;
      lastLon = displayPoint.lon;
      setStatus('Nur lokale Anzeige — kein Server-Upload');
      return false;
    }
    if (displayPoint.routePoint !== true) {
      return publishLivePointToServer(displayPoint);
    }
    if (withTracking && displayPoint.routePoint === true && !isSendDue(displayPoint)) {
      queueTrackPoint(displayPoint);
      setStatus('Tracking - Route-Punkt in Queue');
      return false;
    }
    return sendPointToServer(displayPoint, withTracking);
  }

  async function requestLocationNow(options) {
    if (requestLocationInFlight) return requestLocationInFlight;
    requestLocationInFlight = (async function () {
      await loadSettings();
      await ensureDeviceKey();
      const Geolocation = plugins().Geolocation;
      if (!Geolocation || !(await ensureLocalGpsPermission())) {
        setStatus('Standortberechtigung fehlt');
        return null;
      }
      const position = await Geolocation.getCurrentPosition({
        enableHighAccuracy: true,
        timeout: 15000,
        maximumAge: 0
      });
      const raw = pointFromNative(position);
      if (!raw) return null;
      const displayPoint = stabilizeDisplayPoint(Object.assign({}, raw), {
        firstFix: !!(options && options.firstFix) || !getLastLocalPoint()
      });
      if (!displayPoint) {
        setStatus('GPS sucht noch - bitte Standort aktivieren oder kurz warten');
        return null;
      }
      const requestTracking = options && options.tracking != null ? !!options.tracking : trackingActive;
      const localOnly = !!(options && options.localOnly);
      const localPoint = await publishPoint(displayPoint, requestTracking);
      if (serverUploadEnabled) {
        if (!localOnly && localPoint.routePoint === true) {
          sendPointToServer(localPoint, requestTracking).catch(function () {});
        } else {
          publishLivePointToServer(localPoint, true).catch(function () {});
        }
      } else if (!serverUploadEnabled) {
        setStatus('Nur lokale Anzeige - kein Server-Upload');
      }
      return localPoint;
    })().finally(function () {
      requestLocationInFlight = null;
    });
    return requestLocationInFlight;
  }

  function betterBurstPoint(candidate, best) {
    if (!candidate) return best;
    if (!best) return candidate;
    const candidateAccuracy = num(candidate.accuracy);
    const bestAccuracy = num(best.accuracy);
    if (candidateAccuracy != null && bestAccuracy != null && candidateAccuracy + 0.5 < bestAccuracy) return candidate;
    if (candidateAccuracy != null && bestAccuracy == null) return candidate;
    const candidateTimestamp = num(candidate.timestamp) || 0;
    const bestTimestamp = num(best.timestamp) || 0;
    return candidateTimestamp >= bestTimestamp ? candidate : best;
  }

  function waitMs(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  async function requestLocationBurst(options) {
    if (locationBurstInFlight) return locationBurstInFlight;
    locationBurstInFlight = (async function () {
      options = options || {};
      await loadSettings();
      await ensureDeviceKey();
      const Geolocation = plugins().Geolocation;
      if (!Geolocation || !(await ensureLocalGpsPermission())) {
        setStatus('Standortberechtigung fehlt');
        return null;
      }
      const requestTracking = options.tracking != null ? !!options.tracking : trackingActive;
      const localOnly = options.localOnly !== false;
      const firstFix = !!options.firstFix || !getLastLocalPoint();
      const sampleCount = Math.max(3, Math.min(firstFix ? 20 : 15, Math.round(num(options.samples) || (firstFix ? 20 : 12))));
      const deadline = Date.now() + Math.max(1200, Math.min(firstFix ? 15000 : 6000, Math.round(num(options.maxMs) || (firstFix ? 14000 : 3600))));
      let bestPoint = null;
      for (let i = 0; i < sampleCount && Date.now() < deadline; i += 1) {
        try {
          const position = await Geolocation.getCurrentPosition({
            enableHighAccuracy: true,
            timeout: Math.min(5000, Math.max(1200, deadline - Date.now())),
            maximumAge: i === 0 ? 0 : 350
          });
          const raw = pointFromNative(position);
          const finalPoint = raw ? stabilizeDisplayPoint(Object.assign({}, raw), { firstFix: firstFix }) : null;
          bestPoint = betterBurstPoint(finalPoint, bestPoint);
        } catch (error) {}
        if (i < sampleCount - 1 && Date.now() < deadline) await waitMs(180);
      }
      if (bestPoint) {
        bestPoint = await publishPoint(bestPoint, requestTracking);
        if (serverUploadEnabled) {
          if (!localOnly && bestPoint.routePoint === true) sendPointToServer(bestPoint, requestTracking).catch(function () {});
          else publishLivePointToServer(bestPoint, true).catch(function () {});
        }
      } else {
        setStatus('GPS sucht noch - bitte Standort aktivieren oder kurz warten');
      }
      return bestPoint;
    })().finally(function () {
      locationBurstInFlight = null;
    });
    return locationBurstInFlight;
  }

  async function buildDeviceKeyFromProfile() {
    return buildDeviceKey(await prefGet(PREF_USER, 'mobile'), await prefGet(PREF_DEVICE_NAME, ''));
  }

  async function ensureDeviceKey() {
    let key = await prefGet(PREF_DEVICE_KEY, '');
    if (!key) {
      const user = sanitizePart(await prefGet(PREF_USER, 'mobile'), 'mobile');
      if (!(await prefGet(PREF_USER, ''))) await prefSet(PREF_USER, user);
      key = await buildDeviceKeyFromProfile();
      await prefSet(PREF_DEVICE_KEY, key);
    }
    deviceKey = key;
    return key;
  }

  function announceLocalDevice() {
    if (!deviceKey) return;
    if (typeof global.__capacitorSelectDevice === 'function') {
      global.__capacitorSelectDevice(deviceKey, { registerOnly: true, force: true });
    }
    global.dispatchEvent(new CustomEvent('capacitor-device-ready', {
      detail: { deviceKey: deviceKey, source: 'mobile_app', local: true, updatedAt: Date.now() }
    }));
  }

  async function ensureLocationPermissions() {
    const Geolocation = plugins().Geolocation;
    if (!Geolocation) return false;
    try {
      const perm = await Geolocation.requestPermissions();
      localGpsPermissionReady = !!(perm && (perm.location === 'granted' || perm.coarseLocation === 'granted'));
      return localGpsPermissionReady;
    } catch (error) {
      return false;
    }
  }

  function ensureLocalGpsPermission() {
    if (localGpsPermissionReady) return Promise.resolve(true);
    if (localGpsPermissionPromise) return localGpsPermissionPromise;
    localGpsPermissionPromise = ensureLocationPermissions().finally(function () {
      localGpsPermissionPromise = null;
    });
    return localGpsPermissionPromise;
  }

  async function registerInitialPoint() {
    await ensureDeviceKey();
    announceLocalDevice();
    const granted = await ensureLocalGpsPermission();
    if (!granted) {
      setStatus('Standortberechtigung fehlt');
      return false;
    }
    try {
      const point = await requestLocationBurst({
        tracking: false,
        localOnly: true,
        firstFix: true,
        samples: 20,
        maxMs: 14000
      });
      if (point) {
        setStatus('Geraet registriert - ' + deviceKey);
        return true;
      }
      setStatus('GPS sucht noch - bitte Standort aktivieren oder kurz warten');
      return false;
    } catch (error) {
      setStatus('GPS sucht noch - bitte Standort aktivieren oder kurz warten');
      return false;
    }
  }

  function isAppForeground() {
    return !document.hidden;
  }

  function nativeServerUploadEnabled() {
    return serverUploadEnabled && backgroundUploadEnabled;
  }

  function usesNativePersistentUpload() {
    return trackingActive || nativeServerUploadEnabled();
  }

  async function setNativeUploadPaused(paused) {
    if (usesNativePersistentUpload()) paused = false;
    const nativeUpload = nativeUploadPlugin();
    if (!nativeUpload || typeof nativeUpload.setPaused !== 'function') return;
    try {
      await nativeUpload.setPaused({ paused: !!paused });
    } catch (error) {}
  }

  function syncNativeUploadPauseForLifecycle() {
    if (!usesNativePersistentUpload()) return;
    setNativeUploadPaused(false);
  }

  function stopPointLoop() {
    if (pointLoopTimer != null) {
      clearInterval(pointLoopTimer);
      pointLoopTimer = null;
    }
  }

  function stopLocalGpsPoll() {
    if (localPollTimer != null) {
      clearInterval(localPollTimer);
      localPollTimer = null;
    }
  }

  function stopLocalGpsWatch() {
    const Geolocation = plugins().Geolocation;
    if (Geolocation && localWatchId != null && typeof Geolocation.clearWatch === 'function') {
      Promise.resolve(Geolocation.clearWatch({ id: localWatchId })).catch(function () {});
    }
    localWatchId = null;
  }

  function stopLocalGpsMonitoring() {
    stopLocalGpsWatch();
    stopLocalGpsPoll();
  }

  function pollLocalGpsOnce() {
    if (document.hidden) return;
    const Geolocation = plugins().Geolocation;
    if (!Geolocation) return;
    Geolocation.getCurrentPosition({
      enableHighAccuracy: true,
      timeout: 12000,
      maximumAge: 0
    }).then(function (position) {
      return publishLocalPoint(position);
    }).catch(function () {});
  }

  function startLocalGpsPoll() {
    if (document.hidden) return;
    stopLocalGpsPoll();
    pollLocalGpsOnce();
    localPollTimer = setInterval(pollLocalGpsOnce, 400);
  }

  function startLocalGpsWatch() {
    if (document.hidden) return;
    stopLocalGpsWatch();
    const Geolocation = plugins().Geolocation;
    if (!Geolocation || typeof Geolocation.watchPosition !== 'function') return;
    Promise.resolve(Geolocation.watchPosition({
      enableHighAccuracy: true,
      timeout: 15000,
      maximumAge: 0
    }, function (position, error) {
      if (error || !position) return;
      publishLocalPoint(position).catch(function () {});
    })).then(function (watchId) {
      localWatchId = watchId;
    }).catch(function () {});
  }

  function startLocalGpsMonitoring() {
    if (document.hidden) return;
    startCompassHeadingWatch();
    ensureLocalGpsPermission().then(function (granted) {
      if (!granted || document.hidden) return;
      startLocalGpsWatch();
      startLocalGpsPoll();
    }).catch(function () {
      setStatus('Standortberechtigung fehlt');
    });
  }

  function syncPointLoopWithVisibility() {
    syncNativeUploadPauseForLifecycle();
    if (document.hidden) {
      stopPointLoop();
      stopLocalGpsMonitoring();
    } else {
      startLocalGpsMonitoring();
      startServerPointLoop();
    }
  }

  function setupAppLifecycleHandlers() {
    if (appLifecycleHandlersBound) return;
    appLifecycleHandlersBound = true;
    document.addEventListener('pause', syncPointLoopWithVisibility);
    document.addEventListener('resume', syncPointLoopWithVisibility);
  }

  function setupAppVisibilityHandlers() {
    if (visibilityHandlersBound) return;
    visibilityHandlersBound = true;
    document.addEventListener('visibilitychange', syncPointLoopWithVisibility);
    setupAppLifecycleHandlers();
    syncPointLoopWithVisibility();
  }

  function startServerPointLoop() {
    stopPointLoop();
    if (!serverUploadEnabled || !hasConfiguredMqttTarget() || document.hidden || (persistentUploadActive && backgroundUploadEnabled)) return;
    pointLoopTimer = setInterval(function () {
      if (sendInFlight || !serverUploadEnabled) return;
      if (lastFinalLocalPoint && lastFinalLocalPoint.routePoint === true && isSendDue(lastFinalLocalPoint)) {
        sendInFlight = true;
        sendPointToServer(lastFinalLocalPoint, trackingActive).catch(function () {}).finally(function () {
          sendInFlight = false;
        });
        return;
      }
      const Geolocation = plugins().Geolocation;
      if (!Geolocation) return;
      sendInFlight = true;
      Geolocation.getCurrentPosition({
        enableHighAccuracy: true,
        timeout: 12000,
        maximumAge: 800
      }).then(function (position) {
        return trySendPosition(position, trackingActive);
      }).catch(function () {}).finally(function () {
        sendInFlight = false;
      });
    }, Math.max(200, Math.min(LOOP_TICK_MS, uploadSettings.movingSec * 500)));
  }

  function startPointLoop() {
    startServerPointLoop();
  }

  function serverBaseUrl() {
    const raw = String(configuredServerUrl || '').trim();
    if (raw) {
      try {
        const parsed = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : 'https://' + raw);
        if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
          return parsed.origin.replace(/\/$/, '');
        }
      } catch (error) {}
    }
    const origin = global.location && /^https?:$/.test(global.location.protocol || '') && global.location.origin
      ? String(global.location.origin)
      : '';
    return origin.replace(/\/$/, '');
  }

  function nativeUploadPlugin() {
    return plugins().NativeGpsUpload || null;
  }

  function nativeUploadConfig() {
    return {
      serverUrl: serverBaseUrl(),
      deviceKey: deviceKey,
      tracking: trackingActive,
      mqttHost: mqttHost(),
      mqttPort: mqttPort(),
      mqttTopicPrefix: MQTT_TOPIC_PREFIX,
      trackId: ensureTrackId(false),
      sequenceNumber: Number(localStorage.getItem(TRACK_SEQUENCE_STORAGE_KEY) || '0') || 0,
      segmentId: readRouteSegmentId(),
      breakBefore: routeBreakPending(),
      idleSec: uploadSettings.idleSec,
      movingSec: uploadSettings.movingSec,
      intervalMin: uploadSettings.intervalMin,
      minMoveM: displaySettings.minMoveM,
      maxAccuracyM: displaySettings.maxAccuracyM,
      walkingSpeedKmh: displaySettings.walkingSpeedKmh,
      movingSpeedKmh: displaySettings.movingSpeedKmh,
      stationaryRadiusM: displaySettings.stationaryRadiusM,
      stationaryMaxRadiusM: displaySettings.stationaryMaxRadiusM,
      confirmPoints: displaySettings.confirmPoints,
      speedJumpKmh: displaySettings.speedJumpKmh,
      headingMapBearingDeadbandDeg: displaySettings.headingFilterMapBearingDeadbandDeg,
      headingBurstDeg: uploadSettings.headingBurstDeg,
      headingBurstSec: uploadSettings.headingBurstSec,
      paused: false,
      serverUploadEnabled: nativeServerUploadEnabled()
    };
  }

  async function syncNativeUploadPause() {
    syncNativeUploadPauseForLifecycle();
  }

  async function syncNativePersistentUpload() {
    const nativeUpload = nativeUploadPlugin();
    if (!nativeUpload) return false;
    const payload = nativeUploadConfig();
    payload.enabled = true;
    try {
      if (typeof nativeUpload.start === 'function') {
        await nativeUpload.start(payload);
      } else if (typeof nativeUpload.updateConfig === 'function') {
        await nativeUpload.updateConfig(payload);
      } else {
        return false;
      }
      return true;
    } catch (error) {
      return false;
    }
  }

  async function stopNativePersistentUpload() {
    persistentUploadActive = false;
    const nativeUpload = nativeUploadPlugin();
    if (nativeUpload && typeof nativeUpload.stop === 'function') {
      try { await nativeUpload.stop(); } catch (error) {}
    }
    await stopBackgroundWatch();
  }

  async function startPersistentLocationUpload() {
    if (!usesNativePersistentUpload()) {
      persistentUploadActive = false;
      await stopBackgroundWatch();
      return false;
    }
    if (await syncNativePersistentUpload()) {
      await stopBackgroundWatch();
      persistentUploadActive = true;
      return true;
    }
    persistentUploadActive = await startBackgroundWatch();
    return persistentUploadActive;
  }

  async function applyBackgroundUploadMode() {
    if (!trackingActive && !nativeServerUploadEnabled()) {
      await stopNativePersistentUpload();
      syncPointLoopWithVisibility();
      setStatus(serverUploadEnabled ? 'Live-Uebertragung nur im Vordergrund aktiv' : 'Offline-Modus - nur lokale Anzeige auf dem Handy');
      return false;
    }
    const started = await startPersistentLocationUpload();
    await setNativeUploadPaused(false);
    syncPointLoopWithVisibility();
    if (trackingActive && serverUploadEnabled) {
      setStatus(started
        ? (backgroundUploadEnabled ? 'Tracking + Live-Uebertragung aktiv' : 'Tracking lokal aktiv - Live nur im Vordergrund aktiv')
        : 'Tracking + Live nur im Vordergrund aktiv');
    } else if (trackingActive) {
      setStatus(started ? 'Tracking lokal aktiv - Hintergrunddienst laeuft' : 'Tracking lokal aktiv - Vordergrund-GPS aktiv');
    } else if (serverUploadEnabled) {
      setStatus(started ? 'Live-Uebertragung aktiv' : 'Live-Uebertragung nur im Vordergrund aktiv');
    }
    return started;
  }

  async function setBackgroundUploadEnabled(enabled) {
    backgroundUploadEnabled = !!enabled;
    await prefSet(PREF_BACKGROUND_UPLOAD, backgroundUploadEnabled ? '1' : '0');
    return applyBackgroundUploadMode();
  }

  async function setServerUploadEnabled(enabled) {
    serverUploadEnabled = !!enabled;
    await prefSet(PREF_SERVER_UPLOAD, serverUploadEnabled ? '1' : '0');
    if (typeof global.__capacitorOnServerUploadModeChange === 'function') {
      global.__capacitorOnServerUploadModeChange(serverUploadEnabled);
    }
    if (serverUploadEnabled) {
      if (!hasConfiguredMqttTarget()) {
        setStatus('Kein Server konfiguriert - nur lokale Anzeige');
        dispatchTransportState({ connected: false, connecting: false, serverConfigured: false });
        await applyBackgroundUploadMode();
        syncPointLoopWithVisibility();
        return serverUploadEnabled;
      }
      setStatus('MQTT verbindet...');
      dispatchTransportState({ connected: false, connecting: true, serverConfigured: true });
      ensureMqttClient().then(function (client) {
        if (!client || !client.connected) {
          setStatus('MQTT nicht verbunden - Queue bleibt lokal');
          dispatchTransportState({ connected: false, connecting: false });
          return;
        }
        setStatus('MQTT verbunden');
        sendLastLocalPointIfAvailable().catch(function () {});
        flushQueue().catch(function () {});
      }).catch(function () {
        dispatchTransportState({ connected: false, connecting: false });
      });
    } else if (mqttClient) {
      try { mqttClient.end(true); } catch (error) {}
      mqttClient = null;
      setStatus('Getrennt - nur lokale Anzeige');
      dispatchTransportState({ connected: false, connecting: false, serverUploadEnabled: false });
    } else {
      setStatus('Getrennt - nur lokale Anzeige');
      dispatchTransportState({ connected: false, connecting: false, serverUploadEnabled: false });
    }
    await applyBackgroundUploadMode();
    syncPointLoopWithVisibility();
    return serverUploadEnabled;
  }

  async function stopBackgroundWatch() {
    const BackgroundGeolocation = plugins().BackgroundGeolocation;
    if (BackgroundGeolocation && backgroundWatcherId != null) {
      try { await BackgroundGeolocation.removeWatcher({ id: backgroundWatcherId }); } catch (error) {}
    }
    backgroundWatcherId = null;
  }

  function backgroundWatchOptions() {
    if (trackingActive) {
      return {
        backgroundMessage: 'GPS Tracking sendet Standortpunkte',
        backgroundTitle: 'GPS Tracking aktiv',
        requestPermissions: true,
        stale: false,
        distanceFilter: 0
      };
    }
    return {
      backgroundMessage: 'GPS sendet Live-Standortpunkte',
      backgroundTitle: 'GPS Live aktiv',
      requestPermissions: true,
      stale: false,
      distanceFilter: 0
    };
  }

  async function startBackgroundWatch() {
    const BackgroundGeolocation = plugins().BackgroundGeolocation;
    if (!BackgroundGeolocation) return false;
    await stopBackgroundWatch();
    try {
      backgroundWatcherId = await BackgroundGeolocation.addWatcher(
        backgroundWatchOptions(),
        function (location, error) {
          if (error) {
            setStatus('Hintergrund-GPS: ' + String(error.message || error));
            return;
          }
          if (!location) return;
          publishLocalPoint(location, trackingActive).then(function (finalPoint) {
            if (!serverUploadEnabled || !backgroundUploadEnabled || !finalPoint) return null;
            if (finalPoint.routePoint !== true) return publishLivePointToServer(finalPoint);
            if (!isSendDue(finalPoint)) {
              queueTrackPoint(finalPoint);
              return null;
            }
            return sendPointToServer(finalPoint, trackingActive);
          }).catch(function () {});
        }
      );
      return true;
    } catch (error) {
      return false;
    }
  }

  async function setTrackingActive(active, key) {
    await ensureDeviceKey();
    if (key && String(key) !== deviceKey) return false;
    const wasTrackingActive = trackingActive;
    trackingActive = !!active;
    try {
      localStorage.setItem(TRACKING_ACTIVE_STORAGE_KEY, trackingActive ? '1' : '0');
      if (!trackingActive) localStorage.setItem(TRACKING_STOPPED_AT_STORAGE_KEY, String(Date.now()));
      else localStorage.removeItem(TRACKING_STOPPED_AT_STORAGE_KEY);
    } catch (error) {}
    if (trackingActive && !wasTrackingActive) {
      ensureTrackId(true);
      beginNewRouteSegment();
    } else if (!trackingActive && wasTrackingActive) {
      setRouteBreakPending(true);
    }
    await applyBackgroundUploadMode();
    if (trackingActive) {
      setStatus('Tracking aktiv');
      const Geolocation = plugins().Geolocation;
      if (Geolocation) {
        try {
          const pos = await Geolocation.getCurrentPosition({ enableHighAccuracy: true, timeout: 15000, maximumAge: 1000 });
          await sendPoint(pos, true);
        } catch (error) {}
      }
    } else {
      setStatus('Live-Punkte aktiv — Tracking aus');
    }
  }

  function lonLatToTile(lon, lat, zoom) {
    const n = Math.pow(2, zoom);
    const x = Math.floor((lon + 180) / 360 * n);
    const latRad = lat * Math.PI / 180;
    const y = Math.floor((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * n);
    return { x: x, y: y };
  }

  async function cacheMapRegion(options) {
    const map = typeof global.__getLeafletMap === 'function' ? global.__getLeafletMap() : null;
    if (!map || !map.getBounds) throw new Error('Karte nicht bereit');
    const bounds = map.getBounds();
    const zoomMin = Math.max(2, num(options && options.zoomMin) || Math.max(2, map.getZoom() - 1));
    const zoomMax = Math.min(16, num(options && options.zoomMax) || Math.min(16, Math.ceil(map.getZoom()) + 1));
    let tileCount = 0;
    setStatus('Offline-Karte: 0 Kacheln…');
    for (let z = zoomMin; z <= zoomMax; z += 1) {
      const nw = lonLatToTile(bounds.getWest(), bounds.getNorth(), z);
      const se = lonLatToTile(bounds.getEast(), bounds.getSouth(), z);
      const xMin = Math.min(nw.x, se.x);
      const xMax = Math.max(nw.x, se.x);
      const yMin = Math.min(nw.y, se.y);
      const yMax = Math.max(nw.y, se.y);
      for (let x = xMin; x <= xMax; x += 1) {
        for (let y = yMin; y <= yMax; y += 1) {
          const key = z + '/' + x + '/' + y;
          try {
            const response = await fetch(tileUrl(z, x, y), { cache: 'force-cache' });
            if (!response.ok) continue;
            await tilePut(key, await response.blob());
            tileCount += 1;
          } catch (error) {}
        }
      }
    }
    setStatus('Offline-Karte bereit (' + tileCount + ' Kacheln)');
    return { tileCount: tileCount };
  }

  function applyOfflineLayer(active) {
    const map = typeof global.__getLeafletMap === 'function' ? global.__getLeafletMap() : null;
    if (!map || !global.L) return;
    offlineModeActive = !!active;
    if (offlineLayer) {
      map.removeLayer(offlineLayer);
      offlineLayer = null;
    }
    if (!active) return;
    offlineLayer = global.L.tileLayer('', { minZoom: 2, maxZoom: 18, tileSize: 256 });
    offlineLayer.getTileUrl = function () { return ''; };
    offlineLayer.createTile = function (coords, done) {
      const tile = document.createElement('img');
      tile.alt = '';
      const key = coords.z + '/' + coords.x + '/' + coords.y;
      tileGet(key).then(function (blob) {
        tile.src = blob ? URL.createObjectURL(blob) : 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==';
        done(null, tile);
      }).catch(function () { done(null, tile); });
      return tile;
    };
    offlineLayer.addTo(map);
    offlineLayer.bringToBack();
  }

  async function refreshNetworkMode() {
    const online = await isOnline();
    if (!online) {
      applyOfflineLayer(true);
      setStatus('Offline — gespeicherte Karte aktiv');
    } else if (offlineModeActive) {
      applyOfflineLayer(false);
    }
    if (online && serverUploadEnabled) {
      ensureMqttClient().then(function (client) {
        if (client && client.connected) {
          sendLastLocalPointIfAvailable().catch(function () {});
        }
      }).catch(function () {});
    }
    if (online) await flushQueue();
  }

  function headingFilterPayloadFrom(cfg) {
    return {
      headingFilterPreset: cfg.headingFilterPreset,
      headingFilterMaxJumpDeg: cfg.headingFilterMaxJumpDeg,
      headingFilterDeadbandDeg: cfg.headingFilterDeadbandDeg,
      headingFilterSmoothLevel: cfg.headingFilterSmoothLevel,
      headingFilterSampleMax: cfg.headingFilterSampleMax,
      headingFilterTurnConfirmSamples: cfg.headingFilterTurnConfirmSamples,
      headingFilterMapSpikeRejectDeg: cfg.headingFilterMapSpikeRejectDeg,
      headingFilterMapBearingDeadbandDeg: cfg.headingFilterMapBearingDeadbandDeg
    };
  }

  function profileFilterPayload(cfg, uploadMode) {
    if (uploadMode) {
      return {
        idleSec: cfg.idleSec,
        movingSec: cfg.movingSec,
        intervalMin: cfg.intervalMin,
        headingBurstDeg: cfg.headingBurstDeg,
        headingBurstSec: cfg.headingBurstSec
      };
    }
    const payload = Object.assign({}, positionFilterPayload(cfg));
    Object.assign(payload, headingFilterPayloadFrom(cfg));
    return payload;
  }

  function applyPositionFilterFromData(data, cfg, uploadMode) {
    if (!data) return;
    if (uploadMode) {
      if (data.idleSec != null) cfg.idleSec = clamp(data.idleSec, 1, 3600, DEFAULT_IDLE_SEC);
      if (data.movingSec != null) cfg.movingSec = clamp(data.movingSec, 0.2, 60, DEFAULT_MOVING_SEC);
      if (data.intervalMin != null) cfg.intervalMin = clamp(data.intervalMin, 0, 1440, 0);
      if (data.headingBurstDeg != null) cfg.headingBurstDeg = clamp(data.headingBurstDeg, 3, 90, cfg.headingBurstDeg);
      if (data.headingBurstSec != null) cfg.headingBurstSec = clamp(data.headingBurstSec, 0.15, 5, cfg.headingBurstSec);
      return;
    }
    if (data.minMoveM != null) cfg.minMoveM = clamp(data.minMoveM, 0.2, 20, cfg.minMoveM);
    if (data.maxAccuracyM != null) cfg.maxAccuracyM = clamp(data.maxAccuracyM, 5, 100, cfg.maxAccuracyM);
    if (data.walkingSpeedKmh != null) cfg.walkingSpeedKmh = clamp(data.walkingSpeedKmh, 0.5, 8, cfg.walkingSpeedKmh);
    if (data.movingSpeedKmh != null) cfg.movingSpeedKmh = clamp(data.movingSpeedKmh, cfg.walkingSpeedKmh, 30, cfg.movingSpeedKmh);
    if (data.stationaryRadiusM != null) cfg.stationaryRadiusM = clamp(data.stationaryRadiusM, 3, 80, cfg.stationaryRadiusM);
    if (data.stationaryMaxRadiusM != null) cfg.stationaryMaxRadiusM = clamp(data.stationaryMaxRadiusM, cfg.stationaryRadiusM, 150, cfg.stationaryMaxRadiusM);
    if (data.confirmPoints != null) cfg.confirmPoints = clampInt(data.confirmPoints, 1, 8, cfg.confirmPoints);
    if (data.speedJumpKmh != null) cfg.speedJumpKmh = clamp(data.speedJumpKmh, 2, 60, cfg.speedJumpKmh);
  }

  async function getProfileSettings() {
    await loadSettings();
    const user = await prefGet(PREF_USER, 'mobile');
    const deviceName = await prefGet(PREF_DEVICE_NAME, '');
    const parts = String(deviceKey || '').split('/');
    const display = profileFilterPayload(displaySettings, false);
    const upload = profileFilterPayload(uploadSettings, true);
    return Object.assign({
      user: user,
      deviceName: deviceName || (parts.length > 1 ? parts.slice(1).join('/') : ''),
      deviceKey: deviceKey,
      display: display,
      upload: upload,
      serverUrl: configuredServerUrl,
      mqttWebSocketUrl: mqttWebSocketUrl(),
      backgroundUploadEnabled: backgroundUploadEnabled,
      serverUploadEnabled: serverUploadEnabled
    }, display, upload);
  }

  async function saveProfileSettings(data) {
    data = data || {};
    const oldDeviceKey = deviceKey;
    const oldParts = String(oldDeviceKey || '').split('/');
    const user = sanitizePart(data.user, 'mobile');
    const deviceName = sanitizePart(data.deviceName, oldParts.slice(1).join('/') || 'phone');
    const displayData = data.display || data;
    const uploadData = data.upload || data;
    applyPositionFilterFromData(displayData, displaySettings, false);
    applyPositionFilterFromData(uploadData, uploadSettings, true);
    applyHeadingFilterSettingsFromData(displayData);
    if (data.backgroundUploadEnabled != null) {
      backgroundUploadEnabled = !!data.backgroundUploadEnabled;
      await prefSet(PREF_BACKGROUND_UPLOAD, backgroundUploadEnabled ? '1' : '0');
    }
    if (data.serverUrl != null || data.mqttWebSocketUrl != null) {
      const rawServerInput = String(data.serverUrl != null ? data.serverUrl : data.mqttWebSocketUrl || '').trim();
      configuredServerUrl = rawServerInput;
      configuredMqttWebSocketUrl = normalizeServerOrMqttUrl(rawServerInput);
      await prefSet(PREF_SERVER_URL, configuredServerUrl);
      await prefSet(PREF_MQTT_WS_URL, configuredMqttWebSocketUrl);
      try {
        localStorage.setItem('gpsTrackingServerUrl', configuredServerUrl);
        localStorage.setItem('gpsTrackingMqttUrl', configuredMqttWebSocketUrl);
      } catch (error) {}
      if (mqttClient) {
        try { mqttClient.end(true); } catch (error) {}
        mqttClient = null;
      }
    }
    if (data.serverUploadEnabled != null) {
      serverUploadEnabled = !!data.serverUploadEnabled;
      await prefSet(PREF_SERVER_UPLOAD, serverUploadEnabled ? '1' : '0');
      dispatchTransportState({
        connected: mqttClient && mqttClient.connected,
        connecting: serverUploadEnabled && !(mqttClient && mqttClient.connected),
        serverUploadEnabled: serverUploadEnabled
      });
      if (!serverUploadEnabled && mqttClient) {
        try { mqttClient.end(true); } catch (error) {}
        mqttClient = null;
      }
    }
    const newKey = buildDeviceKey(user, deviceName);
    await Promise.all([
      prefSet(PREF_USER, user),
      prefSet(PREF_DEVICE_NAME, deviceName),
      prefSet(PREF_MIN_MOVE_M, displaySettings.minMoveM),
      prefSet(PREF_MAX_ACCURACY_M, displaySettings.maxAccuracyM),
      prefSet(PREF_WALKING_SPEED_KMH, displaySettings.walkingSpeedKmh),
      prefSet(PREF_MOVING_SPEED_KMH, displaySettings.movingSpeedKmh),
      prefSet(PREF_STATIONARY_RADIUS_M, displaySettings.stationaryRadiusM),
      prefSet(PREF_STATIONARY_MAX_RADIUS_M, displaySettings.stationaryMaxRadiusM),
      prefSet(PREF_CONFIRM_POINTS, displaySettings.confirmPoints),
      prefSet(PREF_SPEED_JUMP_KMH, displaySettings.speedJumpKmh),
      prefSet(PREF_HEADING_FILTER_PRESET, displaySettings.headingFilterPreset),
      prefSet(PREF_HEADING_FILTER_MAX_JUMP_DEG, displaySettings.headingFilterMaxJumpDeg),
      prefSet(PREF_HEADING_FILTER_DEADBAND_DEG, displaySettings.headingFilterDeadbandDeg),
      prefSet(PREF_HEADING_FILTER_SMOOTH_LEVEL, displaySettings.headingFilterSmoothLevel),
      prefSet(PREF_HEADING_FILTER_SAMPLE_MAX, displaySettings.headingFilterSampleMax),
      prefSet(PREF_HEADING_FILTER_TURN_CONFIRM, displaySettings.headingFilterTurnConfirmSamples),
      prefSet(PREF_HEADING_FILTER_MAP_SPIKE_DEG, displaySettings.headingFilterMapSpikeRejectDeg),
      prefSet(PREF_HEADING_FILTER_MAP_BEARING_DEG, displaySettings.headingFilterMapBearingDeadbandDeg),
      prefSet(PREF_UPLOAD_IDLE_SEC, uploadSettings.idleSec),
      prefSet(PREF_UPLOAD_MOVING_SEC, uploadSettings.movingSec),
      prefSet(PREF_UPLOAD_INTERVAL_MIN, uploadSettings.intervalMin),
      prefSet(PREF_UPLOAD_HEADING_BURST_DEG, uploadSettings.headingBurstDeg),
      prefSet(PREF_UPLOAD_HEADING_BURST_SEC, uploadSettings.headingBurstSec),
      prefSet(PREF_DEVICE_KEY, newKey)
    ]);
    deviceKey = newKey;
    if (mqttClient) {
      try { mqttClient.end(true); } catch (error) {}
      mqttClient = null;
    }
    lastSendMs = 0;
    lastLat = null;
    lastLon = null;
    resetFilterStates();
    resetHeadingStabilizer();
    announceLocalDevice();
    registerInitialPoint().catch(function () {
      setStatus('Lokale Anzeige bereit - Standort folgt');
    });
    await applyBackgroundUploadMode();
    if (serverUploadEnabled) {
      ensureMqttClient().then(function (client) {
        if (client && client.connected) {
          sendLastLocalPointIfAvailable().catch(function () {});
          flushQueue().catch(function () {});
        }
      }).catch(function () {});
    }
    setupAppVisibilityHandlers();
    if (typeof global.__capacitorSelectDevice === 'function') {
      global.__capacitorSelectDevice(deviceKey, { registerOnly: true });
    }
    const profile = await getProfileSettings();
    profile.oldDeviceKey = oldDeviceKey;
    return profile;
  }

  async function refreshNow() {
    await loadSettings();
    await importNativeBufferedRoute();
    await registerInitialPoint();
    await refreshNetworkMode();
    if (serverUploadEnabled && !document.hidden) startServerPointLoop();
    return getProfileSettings();
  }

  async function init() {
    if (!isNative()) return false;
    if (bridgeReady) return true;
    await loadSettings();
    await ensureDeviceKey();
    await importNativeBufferedRoute();
    document.documentElement.classList.add('native-app');
    setStatus('Lokale App bereit - Standort folgt');
    announceLocalDevice();
    registerInitialPoint().catch(function () {
      setStatus('Lokale App bereit - Standort anfordern');
    });
    if (!(await applyBackgroundUploadMode()) && backgroundUploadEnabled && serverUploadEnabled && hasConfiguredMqttTarget()) {
      setStatus('Hintergrund-GPS nicht verfügbar — Vordergrund-Upload aktiv');
    }
    setupAppVisibilityHandlers();
    if (serverUploadEnabled && !document.hidden) {
      startServerPointLoop();
    }
    if (serverUploadEnabled) {
      ensureMqttClient().then(function (client) {
        if (client && client.connected) {
          sendLastLocalPointIfAvailable().catch(function () {});
          flushQueue().catch(function () {});
        }
      }).catch(function () {});
    }
    const Network = plugins().Network;
    if (Network) {
      Network.addListener('networkStatusChange', function () { refreshNetworkMode(); });
    }
    global.addEventListener('online', refreshNetworkMode);
    global.addEventListener('offline', refreshNetworkMode);
    await refreshNetworkMode();
    bridgeReady = true;
    return true;
  }

  global.CapacitorMobileBridge = {
    init: init,
    isNative: isNative,
    getDeviceKey: function () { return deviceKey; },
    getTrackingState: function () {
      let sequenceNumber = 0;
      let stoppedAt = null;
      try {
        sequenceNumber = Number(localStorage.getItem(TRACK_SEQUENCE_STORAGE_KEY) || '0') || 0;
        stoppedAt = Number(localStorage.getItem(TRACKING_STOPPED_AT_STORAGE_KEY) || '0') || null;
      } catch (error) {}
      return {
        active: trackingActive,
        trackId: ensureTrackId(false),
        sequenceNumber: sequenceNumber,
        stoppedAt: stoppedAt
      };
    },
    setTrackingActive: setTrackingActive,
    getProfileSettings: getProfileSettings,
    saveProfileSettings: saveProfileSettings,
    getHeadingFilterDebug: getHeadingFilterDebug,
    getHeadingFilterPresetValues: getHeadingFilterPresetValues,
    applyHeadingFilterPreview: function (data) {
      applyHeadingFilterSettingsFromData(data || {});
      resetHeadingStabilizer();
      return resolveHeadingFilterSettings();
    },
    setBackgroundUploadEnabled: setBackgroundUploadEnabled,
    setServerUploadEnabled: setServerUploadEnabled,
    getLastLocalPoint: getLastLocalPoint,
    getLocalRoute: function () { return readLocalRoute(); },
    getQueueLength: function () { return readQueue().length; },
    importNativeBufferedRoute: importNativeBufferedRoute,
    resetLocalRoute: resetLocalRoute,
    requestLocationNow: requestLocationNow,
    requestLocationBurst: requestLocationBurst,
    cacheMapRegion: cacheMapRegion,
    refreshNow: refreshNow,
    flushQueue: flushQueue
  };
})(window);
