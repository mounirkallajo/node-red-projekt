(function (global) {
  'use strict';

  global.__CAPACITOR_BRIDGE_VERSION = '20260531-display-interval-upload-v1';
  console.log('MobileBridgeRuntimeVersion phase16-1d-remove-live-heading-js-ui-20260615-1258');

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

  if (typeof global.fetch === 'function' && !global.__OFFLINE_MAP_FETCH_PATCH) {
    global.__OFFLINE_MAP_FETCH_PATCH = true;
    const upstreamFetch = global.fetch;
    global.__offlineMapState = global.__offlineMapState || {
      captureActive: false,
      captureTotalBytes: 0,
      captureSession: null
    };
    global.__offlineMapDebugCounters = global.__offlineMapDebugCounters || {
      cacheHits: 0,
      cacheMisses: 0,
      glyphCacheHits: 0,
      glyphCacheMisses: 0,
      glyphFallbackServed: 0,
      glyphRuntimeMisses: 0,
      glyphRuntimeMissSuppressed: 0,
      blockedOfflineNetworkRequests: 0,
      httpDownloads: 0,
      httpErrors: 0,
      skippedAlreadyPresent: 0
    };
    global.fetch = function (input, init) {
      const requestUrl = typeof input === 'string' ? input : (input && typeof input.url === 'string' ? input.url : '');
      if (!requestUrl || !offlineShouldInterceptUrl(requestUrl)) {
        return upstreamFetch.call(global, input, init);
      }
      return offlineCachedFetch(requestUrl, input, init, upstreamFetch);
    };
  }

  function offlineShouldInterceptUrl(url) {
    url = offlineTargetUrlForRequest(url);
    if (!url) return false;
    for (let i = 0; i < OFFLINE_HOSTS.length; i += 1) {
      const host = OFFLINE_HOSTS[i];
      if (url.indexOf('//' + host + '/') >= 0 || url.indexOf('//' + host + ':') >= 0) return true;
    }
    return false;
  }

  function offlineTargetUrlForRequest(url) {
    const raw = String(url || '');
    if (raw.indexOf('_capacitor_http_interceptor_') < 0) return raw;
    try {
      const parsed = new URL(raw, global.location && global.location.href);
      const target = parsed.searchParams.get('u');
      if (target) return target;
    } catch (error) {}
    const queryStart = raw.indexOf('?');
    if (queryStart < 0) return raw;
    const query = raw.slice(queryStart + 1).split('&');
    for (let i = 0; i < query.length; i += 1) {
      const part = query[i];
      const eq = part.indexOf('=');
      const key = eq >= 0 ? part.slice(0, eq) : part;
      if (key !== 'u') continue;
      return offlineDecodePathComponentRepeated(eq >= 0 ? part.slice(eq + 1) : '');
    }
    return raw;
  }

  function offlineCanonicalUrl(url) {
    try {
      const parsed = new URL(url, global.location && global.location.href);
      parsed.searchParams.delete('key');
      parsed.searchParams.delete('apikey');
      parsed.searchParams.delete('access_token');
      parsed.hash = '';
      return offlineNormalizeGlyphUrl(parsed.toString());
    } catch (error) {
      const queryIndex = String(url).indexOf('?');
      return offlineNormalizeGlyphUrl(queryIndex >= 0 ? String(url).slice(0, queryIndex) : String(url));
    }
  }

  function offlineIsTileUrl(url) {
    return /\/(\d+)\/(\d+)\/(\d+)\.(?:png|webp|jpe?g|pbf)(?:\?|$)/i.test(url);
  }

  function offlineIsTileJsonUrl(url) {
    return /\/tiles\/[^/?#]+\/tiles\.json(?:\?|$)/i.test(String(url || ''));
  }

  function offlineIsStyleUrl(url) {
    return /\/maps\/[^/?#]+\/style\.json(?:\?|$)/i.test(String(url || ''));
  }

  function offlineIsGlyphUrl(url) {
    return /\/fonts\/[^/?#]+\/\d+-\d+\.pbf(?:\?|$)/i.test(url);
  }

  function offlineIsUnsupportedGlyphRangeUrl(url) {
    return /\/fonts\/[^/?#]+\/(?:65024-65279|127744-127999)\.pbf(?:\?|$)/i.test(offlineCanonicalUrl(url));
  }

  function offlineDecodePathComponentRepeated(value) {
    let output = String(value || '');
    for (let i = 0; i < 2; i += 1) {
      try {
        const next = decodeURIComponent(output);
        if (next === output) break;
        output = next;
      } catch (error) {
        break;
      }
    }
    return output;
  }

  function offlineEncodeGlyphFontstack(fontstack) {
    return offlineDecodePathComponentRepeated(fontstack)
      .split(',')
      .map(function (font) { return font.trim(); })
      .filter(Boolean)
      .map(function (font) { return encodeURIComponent(font); })
      .join(',');
  }

  function offlineNormalizeGlyphUrl(url) {
    return String(url || '').replace(/(\/fonts\/)([^/?#]+)(\/\d+-\d+\.pbf)/i, function (_, prefix, fontstack, suffix) {
      return prefix + offlineEncodeGlyphFontstack(fontstack) + suffix;
    });
  }

  function offlineIncrementDebugCounter(key, amount) {
    global.__offlineMapDebugCounters = global.__offlineMapDebugCounters || {};
    const delta = Number(amount || 1);
    global.__offlineMapDebugCounters[key] = Number(global.__offlineMapDebugCounters[key] || 0) + (Number.isFinite(delta) ? delta : 1);
  }

  function offlineLog(message, detail) {
    try {
      if (!global.console || typeof global.console.info !== 'function') return;
      global.console.info('[offline-map] ' + message + (detail ? ': ' + detail : ''));
    } catch (error) {}
  }

  function mobileStartupLog(message, detail) {
    try {
      if (!global.console || typeof global.console.info !== 'function') return;
      global.console.info('MobileStartup ' + message + (detail ? ': ' + detail : ''));
    } catch (error) {}
  }

  function serverFallbackLog(reason, detail) {
    try {
      if (!global.console || typeof global.console.info !== 'function') return;
      global.console.info('ServerFallback ' + reason + (detail ? ': ' + detail : ''));
    } catch (error) {}
  }

  function perfTraceStackLabel(skipPattern) {
    try {
      const stack = String((new Error()).stack || '').split('\n');
      const names = [];
      for (let i = 1; i < stack.length; i += 1) {
        let line = String(stack[i] || '').trim();
        if (!line) continue;
        if (/perfTrace|Error/.test(line)) continue;
        if (skipPattern && skipPattern.test(line)) continue;
        const match = line.match(/^at\s+([^\s(]+)/);
        line = match && match[1] ? match[1] : line.replace(/^at\s+/, '');
        line = line.replace(/[^a-zA-Z0-9_$.\-<>]/g, '_');
        if (!line) continue;
        names.push(line);
        if (names.length >= 3) break;
      }
      return names.join('>');
    } catch (error) {
      return '';
    }
  }

  function perfTraceLog(topic, fields, throttleKey, throttleMs) {
    try {
      if (!global.console || typeof global.console.info !== 'function') return;
      const fieldList = Array.isArray(fields) ? fields : [];
      const sourceField = fieldList.find(function (field) { return /^source=/.test(String(field || '')); }) || '';
      const actionField = fieldList.find(function (field) { return /^action=/.test(String(field || '')); }) || '';
      const source = String(sourceField).replace(/^source=/, '');
      const action = String(actionField).replace(/^action=/, '');
      const verbose = global.__MOBILE_PERF_TRACE_VERBOSE === true;
      const noisySource = topic !== 'NetworkStatus' && (source === 'cache' || source === 'inFlight' || source === 'idb');
      const noisyAction = /^(schedule|applyCached|skipMapEvent|throttle|skipInFlight)$/.test(action);
      if (!verbose && (noisySource || noisyAction)) return;
      const key = String(topic || '') + ':' + String(throttleKey || '');
      const now = Date.now();
      const throttle = Math.max(0, Number(throttleMs || PERF_TRACE_THROTTLE_MS) || 0);
      if (perfTraceLastLogAt[key] && now - perfTraceLastLogAt[key] < throttle) return;
      perfTraceLastLogAt[key] = now;
      global.console.info('PerfTrace ' + topic + ' ' + fieldList.filter(Boolean).join(' '));
    } catch (error) {}
  }

  function locationServicesErrorText(error) {
    const parts = [];
    function add(value) {
      if (value == null) return;
      const text = String(value).trim();
      if (text) parts.push(text);
    }
    if (typeof error === 'string') add(error);
    if (error && typeof error === 'object') {
      add(error.code);
      add(error.name);
      add(error.message);
      add(error.errorMessage);
      add(error.localizedMessage);
      add(error.reason);
    }
    return parts.join(' | ');
  }

  function locationServicesDisabledReason(error) {
    const text = locationServicesErrorText(error);
    const lower = text.toLowerCase();
    if (!lower) return '';
    if (/os-plug-gloc-0007|location_services?_disabled|provider_disabled/.test(lower)) return 'location-services-disabled';
    if (/location services?\s+(?:(?:are|is)\s+)?(?:disabled|off|not enabled|unavailable)/.test(lower)) return 'location-services-disabled';
    if (/location service disabled/.test(lower)) return 'location-service-disabled';
    if (/provider\s+(?:is\s+)?disabled/.test(lower)) return 'provider-disabled';
    if (/gps\s+(?:is\s+)?disabled/.test(lower)) return 'gps-disabled';
    if (/settings\s+(?:are\s+)?disabled/.test(lower)) return 'settings-disabled';
    if (/enable\s+location/.test(lower)) return 'enable-location';
    if (/standort\s+(?:ist\s+)?deaktiviert/.test(lower)) return 'standort-deaktiviert';
    if (/standortdienst(?:e)?\s+(?:(?:ist|sind)\s+)?deaktiviert/.test(lower)) return 'standortdienst-deaktiviert';
    if (/standort\s+aktivieren/.test(lower)) return 'standort-aktivieren';
    if (/(^|[^a-z])location unavailable([^a-z]|$)/.test(lower) &&
        !/(timeout|timed out|time out|temporar|accuracy|permission denied|denied)/.test(lower)) {
      return 'location-unavailable';
    }
    return '';
  }

  function isLocationServicesDisabledError(error) {
    return !!locationServicesDisabledReason(error);
  }

  function traceLocationServicesBlocked(action, reason) {
    lastLocationServicesBlockedLogMs = Date.now();
    perfTraceLog('LocationServiceBlocked', [
      'action=' + String(action || 'unknown'),
      'reason=' + String(reason || locationServicesBlockedReason || 'unknown').replace(/[^a-zA-Z0-9_.:-]/g, '-'),
      'untilMs=' + String(Math.max(0, Math.round(locationServicesBlockedUntilMs || 0)))
    ], 'location-services-blocked:' + String(action || 'unknown'), LOCATION_SERVICES_BLOCKED_LOG_THROTTLE_MS);
  }

  function traceLocationServicesPrompt(action, reason) {
    lastLocationServicesPromptLogMs = Date.now();
    perfTraceLog('LocationServicePrompt', [
      'action=' + String(action || 'unknown'),
      'reason=' + String(reason || lastLocationServicesPromptReason || 'unknown').replace(/[^a-zA-Z0-9_.:-]/g, '-')
    ], 'location-services-prompt:' + String(action || 'unknown'), LOCATION_SERVICES_PROMPT_LOG_THROTTLE_MS);
  }

  function locationTraceValue(value) {
    return String(value || 'unknown').replace(/[^a-zA-Z0-9_.:-]/g, '-');
  }

  function traceLocationRequired(action, result) {
    perfTraceLog('LocationRequired', [
      'action=' + locationTraceValue(action),
      'result=' + locationTraceValue(result)
    ], 'location-required:' + locationTraceValue(action) + ':' + locationTraceValue(result), PERF_TRACE_THROTTLE_MS);
  }

  function setLocationServiceState(state, reason) {
    const next = state || 'unknown';
    if (locationServiceState === next && !reason) return;
    locationServiceState = next;
    perfTraceLog('LocationServiceState', [
      'state=' + locationTraceValue(next),
      'reason=' + locationTraceValue(reason)
    ], 'location-service-state:' + locationTraceValue(next) + ':' + locationTraceValue(reason), PERF_TRACE_THROTTLE_MS);
  }

  function normalizeLocationRequiredAction(action) {
    const raw = String(action || '').trim();
    if (/hard|burst/i.test(raw)) return 'locateHardRefresh';
    if (/tracking/i.test(raw)) return 'trackingStart';
    if (/server|upload|send/i.test(raw)) return 'serverUpload';
    if (/startup|init|register/i.test(raw)) return 'startup';
    if (/locate|location|request/i.test(raw)) return 'locateShort';
    return raw || 'locateShort';
  }

  function locationRequiredPromptAllowed(action, options) {
    if (options && options.prompt === false) return false;
    if (locationPromptInFlight || locationSettingsOpenInFlight || locationServicesPromptInFlight) {
      traceLocationServicesPrompt('inFlight', action);
      return false;
    }
    const normalized = normalizeLocationRequiredAction(action);
    const now = Date.now();
    const lastAt = locationRequiredActionPromptAt[normalized] || 0;
    if (lastAt && now - lastAt < LOCATION_REQUIRED_ACTION_DEBOUNCE_MS) {
      traceLocationServicesPrompt('skip', normalized);
      return false;
    }
    return true;
  }

  function noteLocationRequiredPrompt(action) {
    const normalized = normalizeLocationRequiredAction(action);
    lastLocationPromptAction = normalized;
    lastLocationPromptAt = Date.now();
    locationRequiredActionPromptAt[normalized] = lastLocationPromptAt;
    locationRequiredActionPending = normalized;
  }

  function locationServicesPromptRecentlyShown() {
    if (!locationServicesPromptedUntilMs) return false;
    if (Date.now() < locationServicesPromptedUntilMs) return true;
    locationServicesPromptedUntilMs = 0;
    lastLocationServicesPromptReason = '';
    return false;
  }

  function locationSettingsRecentlyOpened() {
    if (!locationSettingsOpenedUntilMs) return false;
    if (Date.now() < locationSettingsOpenedUntilMs) return true;
    locationSettingsOpenedUntilMs = 0;
    lastLocationSettingsOpenReason = '';
    return false;
  }

  function clearLocationServicesBlocked() {
    locationServicesBlockedUntilMs = 0;
    locationServicesBlockedReason = '';
    locationBlockedFinalActive = false;
    locationBlockedFinalAtMs = 0;
    locationLastAvailableAtMs = Date.now();
    locationServicesPromptedUntilMs = 0;
    lastLocationServicesPromptReason = '';
    locationSettingsOpenedUntilMs = 0;
    lastLocationSettingsOpenReason = '';
    cancelLocationRequiredRecheck();
    locationRequiredActionPending = '';
    setLocationServiceState('available', 'fix');
  }

  function pointAllowedAfterBlockedFinal(point) {
    if (!locationBlockedFinalActive || !locationBlockedFinalAtMs) return true;
    const timestamp = num(point && point.timestamp);
    return !!(timestamp && timestamp >= locationBlockedFinalAtMs);
  }

  function locationBlockedWithoutUsablePoint() {
    if (locationBlockedFinalActive && locationServiceState !== 'available') return true;
    const blocked = locationBlockedFinalActive || locationServiceState === 'disabled' || locationServicesBlockedActive();
    return blocked && !validLocalPoint(getUsableLocalPoint(LOCATION_USABLE_CACHED_POINT_MS));
  }

  function expireLocationServicesBlocked() {
    locationServicesBlockedUntilMs = 0;
    if (locationBlockedFinalActive) return;
    locationServicesBlockedReason = '';
    if (locationServiceState === 'disabled') setLocationServiceState('unknown', 'cooldown-expired');
  }

  function cancelLocationRequiredRecheck() {
    if (locationRequiredRecheckTimer != null) {
      clearTimeout(locationRequiredRecheckTimer);
      locationRequiredRecheckTimer = null;
    }
  }

  function dispatchTrackingState(reason) {
    let sequenceNumber = 0;
    let stoppedAt = null;
    try {
      sequenceNumber = Number(localStorage.getItem(TRACK_SEQUENCE_STORAGE_KEY) || '0') || 0;
      stoppedAt = Number(localStorage.getItem(TRACKING_STOPPED_AT_STORAGE_KEY) || '0') || null;
    } catch (error) {}
    global.dispatchEvent(new CustomEvent('capacitor-tracking-state', {
      detail: {
        active: !!trackingActive,
        deviceKey: deviceKey,
        trackId: ensureTrackId(false),
        sequenceNumber: sequenceNumber,
        stoppedAt: stoppedAt,
        reason: reason || 'unknown',
        locationServiceState: locationServiceState,
        updatedAt: Date.now()
      }
    }));
  }

  async function disableServerUploadForLocationRequired(action) {
    const wasEnabled = !!serverUploadEnabled;
    serverUploadEnabled = false;
    try { await prefSet(PREF_SERVER_UPLOAD, '0'); } catch (error) {}
    if (typeof global.__capacitorOnServerUploadModeChange === 'function') {
      try { global.__capacitorOnServerUploadModeChange(false); } catch (error) {}
    }
    if (mqttClient) {
      try { mqttClient.end(true); } catch (error) {}
      mqttClient = null;
    }
    dispatchTransportState({
      connected: false,
      connecting: false,
      serverConfigured: hasConfiguredMqttTarget(),
      serverUploadEnabled: false
    });
    if (wasEnabled) traceLocationRequired(action || 'serverUpload', 'serverUpload-off');
    return wasEnabled;
  }

  async function finalizeLocationRequiredBlocked(action, result) {
    const normalized = normalizeLocationRequiredAction(action || locationRequiredActionPending || lastLocationPromptAction);
    const finalResult = result || 'blocked-final';
    cancelLocationRequiredRecheck();
    locationPromptInFlight = null;
    locationRequiredRecheckInFlight = null;
    locationServicesPromptInFlight = null;
    locationSettingsOpenInFlight = null;
    localGpsPermissionPromise = null;
    localGpsPermissionReady = false;
    locationBlockedFinalActive = true;
    locationBlockedFinalAtMs = Date.now();
    if (!locationServicesBlockedUntilMs || Date.now() >= locationServicesBlockedUntilMs) {
      locationServicesBlockedUntilMs = Date.now() + LOCATION_SERVICES_BLOCKED_COOLDOWN_MS;
      locationServicesBlockedReason = 'location-required-' + finalResult;
      traceLocationServicesBlocked('start', locationServicesBlockedReason);
    }
    locationRequiredActionPending = '';
    setLocationServiceState('disabled', finalResult);
    traceLocationRequired(normalized, finalResult);
    try {
      stopPointLoop();
      stopLocalGpsMonitoring();
    } catch (error) {}
    let stateChanged = false;
    if (trackingActive) {
      trackingActive = false;
      stateChanged = true;
      try {
        localStorage.setItem(TRACKING_ACTIVE_STORAGE_KEY, '0');
        localStorage.setItem(TRACKING_STOPPED_AT_STORAGE_KEY, String(Date.now()));
      } catch (error) {}
    }
    dispatchTrackingState(finalResult);
    if (serverUploadEnabled) {
      stateChanged = true;
      await disableServerUploadForLocationRequired(normalized);
    }
    await stopNativePersistentUpload();
    syncPointLoopWithVisibility();
    setStatus('GPS sucht noch - bitte Standort aktivieren oder kurz warten');
    if (stateChanged) publishTrackingStatus().catch(function () {});
    return false;
  }

  function markLocationServicesBlocked(error, fallbackReason, options) {
    const reason = locationServicesDisabledReason(error) || fallbackReason || '';
    if (!reason) return false;
    locationServicesBlockedUntilMs = Date.now() + LOCATION_SERVICES_BLOCKED_COOLDOWN_MS;
    locationServicesBlockedReason = reason;
    localGpsPermissionReady = false;
    setLocationServiceState('disabled', reason);
    traceLocationServicesBlocked('start', reason);
    if (options && options.requiredAction) {
      traceLocationRequired(options.requiredAction, options.openSettings === true ? 'prompt' : 'blocked');
      locationRequiredActionPending = normalizeLocationRequiredAction(options.requiredAction);
    }
    if (options && options.openSettings === true) {
      openLocationSettingsOnce(options.promptReason || fallbackReason || reason, options).catch(function () {});
      if (options.requiredAction) scheduleLocationRequiredRecheck(options.requiredAction);
    }
    try {
      stopLocalGpsWatch();
      stopLocalGpsPoll();
    } catch (ignored) {}
    if ((trackingActive || nativeServerUploadEnabled()) &&
        !validLocalPoint(getUsableLocalPoint(LOCATION_USABLE_CACHED_POINT_MS))) {
      stopNativePersistentUpload().catch(function () {});
      setStatus('GPS sucht noch - bitte Standort aktivieren oder kurz warten');
    }
    if (!(options && options.openSettings === true) &&
        !(options && options.deferFinalize === true) &&
        (trackingActive || serverUploadEnabled || nativeUploadStarted || persistentUploadActive) &&
        !validLocalPoint(getUsableLocalPoint(LOCATION_USABLE_CACHED_POINT_MS))) {
      finalizeLocationRequiredBlocked(options && options.requiredAction || fallbackReason || reason, 'blocked-final').catch(function () {});
    }
    return true;
  }

  function locationServicesBlockedActive() {
    if (!locationServicesBlockedUntilMs) return false;
    if (Date.now() < locationServicesBlockedUntilMs) return true;
    expireLocationServicesBlocked();
    return false;
  }

  function shouldSkipLocationServicesNativeCall(action) {
    if (!locationBlockedWithoutUsablePoint()) return false;
    traceLocationServicesBlocked('skip', locationServicesBlockedReason || String(action || 'unknown'));
    return true;
  }

  function openLocationSettingsFallback(nativeUpload, promptReason) {
    if (!nativeUpload || typeof nativeUpload.openLocationSettings !== 'function') {
      traceLocationServicesPrompt('openSettingsFailed', promptReason);
      return Promise.resolve(false);
    }
    traceLocationServicesPrompt('openSettingsFallback', promptReason);
    return Promise.resolve(nativeUpload.openLocationSettings()).then(function () {
      return true;
    }).catch(function () {
      traceLocationServicesPrompt('openSettingsFailed', promptReason);
      return false;
    });
  }

  function openLocationSettingsOnce(reason, options) {
    const nativeUpload = nativeUploadPlugin();
    const promptReason = String(reason || 'unknown');
    if (!locationServicesPromptAllowed(options || {})) {
      if (options && options.logSkip) traceLocationServicesPrompt('skip', promptReason);
      return Promise.resolve(false);
    }
    if (!nativeUpload ||
        (typeof nativeUpload.requestLocationSettingsResolution !== 'function' &&
         typeof nativeUpload.openLocationSettings !== 'function')) {
      traceLocationServicesPrompt('openSettingsFailed', promptReason);
      return Promise.resolve(false);
    }
    if (locationSettingsOpenInFlight) {
      traceLocationServicesPrompt('inFlight', promptReason);
      return locationSettingsOpenInFlight;
    }
    if (locationSettingsRecentlyOpened() && !(options && options.explicitAction === true)) {
      traceLocationServicesPrompt('skip', promptReason);
      return Promise.resolve(false);
    }
    const until = Date.now() + LOCATION_SERVICES_BLOCKED_COOLDOWN_MS;
    locationSettingsOpenedUntilMs = until;
    locationServicesPromptedUntilMs = Math.max(locationServicesPromptedUntilMs || 0, until);
    lastLocationSettingsOpenReason = promptReason;
    lastLocationServicesPromptReason = promptReason;
    setLocationServiceState('prompting', promptReason);
    if (typeof nativeUpload.requestLocationSettingsResolution !== 'function') {
      locationSettingsOpenInFlight = openLocationSettingsFallback(nativeUpload, promptReason).finally(function () {
        locationSettingsOpenInFlight = null;
      });
      return locationSettingsOpenInFlight;
    }
    traceLocationServicesPrompt('resolutionDialog', promptReason);
    locationSettingsOpenInFlight = Promise.resolve(nativeUpload.requestLocationSettingsResolution()).then(function (result) {
      if (result && result.fallback === true) traceLocationServicesPrompt('openSettingsFallback', promptReason);
      return true;
    }).catch(function () {
      return openLocationSettingsFallback(nativeUpload, promptReason);
    }).finally(function () {
      locationSettingsOpenInFlight = null;
    });
    return locationSettingsOpenInFlight;
  }

  function maybePromptLocationSettingsOnColdStart(reason) {
    const promptReason = String(reason || 'appOpen');
    if (startupLocationSettingsPromptDone) {
      traceLocationServicesPrompt('startupSkip', 'alreadyDone');
      return Promise.resolve(false);
    }
    startupLocationSettingsPromptDone = true;
    traceLocationServicesPrompt('startupCheck', promptReason);
    if (!isNative()) {
      traceLocationServicesPrompt('startupSkip', 'notNative');
      return Promise.resolve(false);
    }
    if (document.hidden) {
      traceLocationServicesPrompt('startupSkip', 'hidden');
      return Promise.resolve(false);
    }
    if (locationPromptInFlight || locationSettingsOpenInFlight || locationServicesPromptInFlight) {
      traceLocationServicesPrompt('startupSkip', 'inFlight');
      return Promise.resolve(false);
    }
    if (locationSettingsRecentlyOpened() || locationServicesPromptRecentlyShown()) {
      traceLocationServicesPrompt('startupSkip', 'cooldown');
      return Promise.resolve(false);
    }
    const nativeUpload = nativeUploadPlugin();
    if (!nativeUpload || typeof nativeUpload.requestLocationSettingsResolution !== 'function') {
      traceLocationServicesPrompt('startupSkip', 'nativeUnavailable');
      return Promise.resolve(false);
    }
    locationSettingsOpenInFlight = Promise.resolve(nativeUpload.requestLocationSettingsResolution()).then(function (result) {
      if (result && (result.resolutionDialog === true || result.fallback === true)) {
        const until = Date.now() + LOCATION_SERVICES_BLOCKED_COOLDOWN_MS;
        locationSettingsOpenedUntilMs = until;
        locationServicesPromptedUntilMs = Math.max(locationServicesPromptedUntilMs || 0, until);
        lastLocationSettingsOpenReason = promptReason;
        lastLocationServicesPromptReason = promptReason;
        traceLocationServicesPrompt('startupResolution', promptReason);
        if (result.fallback === true) traceLocationServicesPrompt('openSettingsFallback', promptReason);
        return true;
      }
      traceLocationServicesPrompt('startupSkip', 'settingsSatisfied');
      return false;
    }).catch(function () {
      traceLocationServicesPrompt('startupSkip', 'nativeFailed');
      return false;
    }).finally(function () {
      locationSettingsOpenInFlight = null;
    });
    return locationSettingsOpenInFlight;
  }

  function locationServicesPromptAllowed(options) {
    if (options && options.prompt === false) return false;
    if (document.hidden && !(options && options.allowHidden === true)) return false;
    return true;
  }

  function requestLocationServiceActivationOnce(reason, options) {
    const Geolocation = plugins().Geolocation;
    const promptReason = String(reason || 'unknown');
    if (!Geolocation || typeof Geolocation.requestPermissions !== 'function') return Promise.resolve(false);
    if (!locationServicesPromptAllowed(options || {})) {
      if (options && options.logSkip) traceLocationServicesPrompt('skip', promptReason);
      return Promise.resolve(false);
    }
    if (locationServicesPromptInFlight) {
      traceLocationServicesPrompt('inFlight', promptReason);
      return locationServicesPromptInFlight;
    }
    if (locationServicesPromptRecentlyShown() && !(options && options.explicitAction === true)) {
      traceLocationServicesPrompt('skip', promptReason);
      return Promise.resolve(false);
    }
    locationServicesPromptedUntilMs = Date.now() + LOCATION_SERVICES_BLOCKED_COOLDOWN_MS;
    lastLocationServicesPromptReason = promptReason;
    setLocationServiceState('prompting', promptReason);
    traceLocationServicesPrompt('show', promptReason);
    const promptStartedAtMs = Date.now();
    locationServicesPromptInFlight = Promise.resolve(Geolocation.requestPermissions()).then(function (perm) {
      localGpsPermissionReady = !!(perm && (perm.location === 'granted' || perm.coarseLocation === 'granted'));
      return localGpsPermissionReady;
    }).catch(function (error) {
      if (locationLastAvailableAtMs && promptStartedAtMs < locationLastAvailableAtMs) {
        traceLocationServicesBlocked('skip', locationServicesBlockedReason || promptReason);
        return false;
      }
      if (locationBlockedFinalActive && locationBlockedFinalAtMs && promptStartedAtMs < locationBlockedFinalAtMs) {
        traceLocationServicesBlocked('skip', locationServicesBlockedReason || promptReason);
        return false;
      }
      markLocationServicesBlocked(error, null, {
        openSettings: true,
        promptReason: promptReason,
        logSkip: true,
        allowHidden: options && options.allowHidden === true,
        explicitAction: options && options.explicitAction === true,
        requiredAction: options && options.requiredAction
      });
      return false;
    }).finally(function () {
      locationServicesPromptInFlight = null;
    });
    return locationServicesPromptInFlight;
  }

  function scheduleLocationRequiredRecheck(action) {
    const normalized = normalizeLocationRequiredAction(action || locationRequiredActionPending || lastLocationPromptAction);
    if (!normalized) return;
    if (normalized === 'startup' && !trackingActive && !(serverUploadEnabled && hasConfiguredMqttTarget())) return;
    if (locationRequiredRecheckTimer != null || locationRequiredRecheckInFlight) return;
    locationRequiredActionPending = normalized;
    locationRequiredRecheckTimer = setTimeout(function () {
      locationRequiredRecheckTimer = null;
      runLocationRequiredRecheck(normalized).catch(function () {});
    }, LOCATION_REQUIRED_RECHECK_DELAY_MS);
  }

  function waitForLocationRequiredOutcome(action, timeoutMs) {
    const normalized = normalizeLocationRequiredAction(action);
    const deadline = Date.now() + Math.max(1000, Number(timeoutMs || 18000) || 18000);
    return new Promise(function (resolve) {
      function check() {
        const point = getUsableLocalPoint(LOCATION_USABLE_CACHED_POINT_MS);
        if (validLocalPoint(point) && locationServiceState === 'available') {
          resolve(point);
          return;
        }
        if (locationServiceState === 'disabled' &&
            !locationRequiredActionPending &&
            !locationRequiredRecheckInFlight &&
            locationRequiredRecheckTimer == null) {
          resolve(null);
          return;
        }
        if (Date.now() >= deadline ||
            (!locationRequiredActionPending && !locationRequiredRecheckInFlight && locationRequiredRecheckTimer == null)) {
          resolve(null);
          return;
        }
        setTimeout(check, 250);
      }
      check();
    });
  }

  async function promptLocationRequiredAction(action, options) {
    const normalized = normalizeLocationRequiredAction(action);
    options = Object.assign({}, options || {}, {
      prompt: true,
      logSkip: true,
      explicitAction: options && options.explicitAction === true,
      requiredAction: normalized
    });
    if (!locationRequiredPromptAllowed(normalized, options)) {
      traceLocationRequired(normalized, 'blocked');
      return false;
    }
    noteLocationRequiredPrompt(normalized);
    traceLocationRequired(normalized, 'prompt');
    setLocationServiceState('prompting', normalized);
    locationPromptInFlight = Promise.resolve()
      .then(function () {
        return requestLocationServiceActivationOnce(normalized, options);
      })
      .then(function () {
        return openLocationSettingsOnce(normalized, options);
      })
      .then(function () {
        scheduleLocationRequiredRecheck(normalized);
        return true;
      })
      .catch(function () {
        traceLocationRequired(normalized, 'blocked');
        return false;
      })
      .finally(function () {
        locationPromptInFlight = null;
      });
    return locationPromptInFlight;
  }

  async function runLocationRequiredRecheck(action) {
    const normalized = normalizeLocationRequiredAction(action || locationRequiredActionPending);
    if (!normalized || document.hidden) return null;
    if (locationRequiredRecheckInFlight) return locationRequiredRecheckInFlight;
    const Geolocation = plugins().Geolocation;
    if (!Geolocation) {
      await finalizeLocationRequiredBlocked(normalized, 'blocked-final');
      return null;
    }
    locationRequiredRecheckInFlight = (async function () {
      try {
        const position = await getCurrentPositionWithReason('locationRequiredRecheck', {
          enableHighAccuracy: true,
          timeout: 15000,
          maximumAge: 0
        }, {
          allowWhileBlocked: true,
          openSettings: false,
          promptReason: normalized,
          requiredAction: normalized
        });
        const raw = pointFromNative(position);
        if (!raw) {
          const recoveredPoint = getUsableLocalPoint(LOCATION_USABLE_CACHED_POINT_MS);
          if (locationServiceState === 'available' && validLocalPoint(recoveredPoint)) return recoveredPoint;
          await finalizeLocationRequiredBlocked(normalized, 'blocked-final');
          return null;
        }
        const displayPoint = stabilizeDisplayPoint(Object.assign({}, raw), {
          firstFix: !getLastLocalPoint()
        });
        if (!displayPoint) {
          if (locationServiceState === 'available') return null;
          await finalizeLocationRequiredBlocked(normalized, 'blocked-final');
          return null;
        }
        const completeServerUploadEnable = normalized === 'serverUpload' && locationRequiredActionPending === normalized;
        const localPoint = await publishDisplayPoint(displayPoint, false);
        if (!localPoint) {
          if (locationServiceState === 'available') return null;
          await finalizeLocationRequiredBlocked(normalized, 'blocked-final');
          return null;
        }
        traceLocationRequired(normalized, 'ready');
        if (normalized === 'trackingStart' && !trackingActive) {
          await setTrackingActive(true, deviceKey);
        } else if (completeServerUploadEnable) {
          await setServerUploadEnabled(true);
          tickServerUpload(true).catch(function () {});
        }
        if (locationRequiredActionPending === normalized) locationRequiredActionPending = '';
        return localPoint;
      } catch (error) {
        markLocationServicesBlocked(error, null, { requiredAction: normalized, deferFinalize: true });
        await finalizeLocationRequiredBlocked(normalized, 'blocked-final');
        return null;
      } finally {
        locationRequiredRecheckInFlight = null;
      }
    })();
    return locationRequiredRecheckInFlight;
  }

  function offlineUrlForLog(url) {
    try { return offlineCanonicalUrl(url); } catch (error) { return String(url || ''); }
  }

  function offlineNetworkBlocked() {
    return !!offlineModeActive || (typeof navigator !== 'undefined' && navigator.onLine === false);
  }

  function offlineIsMapTilerVectorTileUrl(url) {
    try {
      const parsed = new URL(url, global.location && global.location.href);
      return parsed.hostname === 'api.maptiler.com'
        && /^\/tiles\/[^/]+\/\d+\/\d+\/\d+\.pbf$/i.test(parsed.pathname || '');
    } catch (error) {
      return false;
    }
  }

  function offlineMapTilerTileCooldownState() {
    global.__offlineMapTilerTileCooldown = global.__offlineMapTilerTileCooldown || {
      until: 0,
      probeInFlight: false,
      reason: ''
    };
    return global.__offlineMapTilerTileCooldown;
  }

  function offlineMapTilerTileRequestMode() {
    const state = offlineMapTilerTileCooldownState();
    const now = Date.now();
    const until = Number(state.until || 0);
    if (state.probeInFlight) return 'blocked';
    if (until > now) return 'blocked';
    if (until > 0) {
      state.until = 0;
      state.probeInFlight = true;
      state.reason = 'probe';
      return 'probe';
    }
    return 'normal';
  }

  function offlineStartMapTilerTileCooldown(reason, durationMs) {
    const state = offlineMapTilerTileCooldownState();
    const now = Date.now();
    const wasActive = Number(state.until || 0) > now || state.probeInFlight;
    state.until = Math.max(Number(state.until || 0), now + durationMs);
    state.probeInFlight = false;
    state.reason = reason || 'network';
    if (!wasActive) {
      offlineLog('maptiler tile cooldown started', state.reason + ' for ' + Math.ceil(durationMs / 1000) + 's');
    }
  }

  function offlineClearMapTilerTileCooldown() {
    const state = offlineMapTilerTileCooldownState();
    state.until = 0;
    state.probeInFlight = false;
    state.reason = '';
  }

  function offlineMapTilerTileCooldownResponse() {
    offlineIncrementDebugCounter('blockedOfflineNetworkRequests', 1);
    return new Response(new Uint8Array(0), {
      status: 200,
      headers: {
        'Content-Type': 'application/x-protobuf',
        'Cache-Control': 'no-store',
        'Access-Control-Allow-Origin': '*',
        'X-Offline-Cache': 'maptiler-tile-cooldown'
      }
    });
  }

  function offlineTileJsonBody(url) {
    let tileSet = 'v3';
    let key = '';
    try {
      const parsed = new URL(url, global.location && global.location.href);
      const match = parsed.pathname.match(/\/tiles\/([^/]+)\/tiles\.json$/i);
      if (match && match[1]) tileSet = match[1];
      key = parsed.searchParams.get('key') || parsed.searchParams.get('apikey') || parsed.searchParams.get('access_token') || '';
    } catch (error) {}
    const tileUrl = 'https://api.maptiler.com/tiles/' + tileSet + '/{z}/{x}/{y}.pbf' + (key ? '?key=' + encodeURIComponent(key) : '');
    return JSON.stringify({
      tilejson: '2.2.0',
      name: 'offline-' + tileSet,
      version: '1.0.0',
      scheme: 'xyz',
      type: 'overlay',
      format: 'pbf',
      minzoom: 0,
      maxzoom: 14,
      tiles: [tileUrl]
    });
  }

  function offlineTileJsonFallbackResponse(url) {
    offlineIncrementDebugCounter('blockedOfflineNetworkRequests', 1);
    offlineLog('blocked offline network request', offlineUrlForLog(url));
    offlineLog('offline tilejson fallback', offlineUrlForLog(url));
    return new Response(offlineTileJsonBody(url), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
        'Access-Control-Allow-Origin': '*',
        'X-Offline-Cache': 'tilejson-placeholder'
      }
    });
  }

  async function offlineCachedFetch(requestUrl, input, init, upstreamFetch) {
    const targetUrl = offlineTargetUrlForRequest(requestUrl);
    const canonical = offlineCanonicalUrl(targetUrl);
    const mapTilerVectorTile = offlineIsMapTilerVectorTileUrl(canonical);
    try {
      const cachedTile = await idbGet(TILE_STORE, canonical);
      if (cachedTile) {
        offlineIncrementDebugCounter('cacheHits', 1);
        if (offlineIsGlyphUrl(canonical)) offlineIncrementDebugCounter('glyphCacheHits', 1);
        if (offlineIsTileUrl(canonical)) offlineLog('OfflineLocalTileHit', offlineUrlForLog(canonical));
        else offlineLog('OfflineLocalHit', offlineUrlForLog(canonical));
        return new Response(cachedTile, {
          status: 200,
          headers: { 'Content-Type': cachedTile.type || 'application/octet-stream', 'X-Offline-Cache': 'tile' }
        });
      }
      const cachedResource = await idbGet(RESOURCE_STORE, canonical);
      if (cachedResource && cachedResource.blob) {
        offlineIncrementDebugCounter('cacheHits', 1);
        if (offlineIsGlyphUrl(canonical)) offlineIncrementDebugCounter('glyphCacheHits', 1);
        if (offlineIsStyleUrl(canonical)) offlineLog('OfflineLocalStyleHit', offlineUrlForLog(canonical));
        else if (offlineIsTileJsonUrl(canonical)) offlineLog('OfflineLocalHit', offlineUrlForLog(canonical));
        else offlineLog('OfflineLocalHit', offlineUrlForLog(canonical));
        return new Response(cachedResource.blob, {
          status: 200,
          headers: { 'Content-Type': cachedResource.contentType || cachedResource.blob.type || 'application/octet-stream', 'X-Offline-Cache': 'resource' }
        });
      }
    } catch (error) {}
    if (offlineIsGlyphUrl(canonical)) {
      const knownMiss = offlineKnownRuntimeGlyphMiss(canonical);
      if (offlineIsUnsupportedGlyphRangeUrl(canonical) || offlineModeActive || knownMiss || (typeof navigator !== 'undefined' && navigator.onLine === false)) {
        return offlineRuntimeGlyphFallbackResponse(canonical, knownMiss);
      }
      offlineIncrementDebugCounter('cacheMisses', 1);
      offlineIncrementDebugCounter('glyphCacheMisses', 1);
    } else {
      offlineIncrementDebugCounter('cacheMisses', 1);
      if (offlineIsTileJsonUrl(canonical)) {
        offlineLog('offline tilejson miss', offlineUrlForLog(canonical));
        if (offlineNetworkBlocked()) return offlineTileJsonFallbackResponse(targetUrl);
      } else if (offlineIsTileUrl(canonical)) {
        offlineLog('offline tile miss', offlineUrlForLog(canonical));
      }
    }
    const mapTilerTileRequestMode = mapTilerVectorTile ? offlineMapTilerTileRequestMode() : 'normal';
    if (mapTilerTileRequestMode === 'blocked') {
      return offlineMapTilerTileCooldownResponse();
    }
    let response;
    try {
      response = await upstreamFetch.call(global, input, init);
    } catch (networkError) {
      offlineIncrementDebugCounter('httpErrors', 1);
      if (offlineIsGlyphUrl(canonical)) return offlineRuntimeGlyphFallbackResponse(canonical, offlineKnownRuntimeGlyphMiss(canonical));
      if (mapTilerVectorTile) {
        offlineStartMapTilerTileCooldown('network', MAPTILER_TILE_COOLDOWN_NETWORK_MS);
        return offlineMapTilerTileCooldownResponse();
      }
      throw networkError;
    }
    if (mapTilerVectorTile && (!response || !response.ok)) {
      offlineIncrementDebugCounter('httpErrors', 1);
      const status = response && Number(response.status || 0);
      offlineStartMapTilerTileCooldown(
        status ? 'HTTP ' + status : 'empty response',
        status === 403 ? MAPTILER_TILE_COOLDOWN_FORBIDDEN_MS : MAPTILER_TILE_COOLDOWN_NETWORK_MS
      );
      return offlineMapTilerTileCooldownResponse();
    }
    if (!response || !response.ok) offlineIncrementDebugCounter('httpErrors', 1);
    else {
      offlineIncrementDebugCounter('httpDownloads', 1);
      if (mapTilerTileRequestMode === 'probe') offlineClearMapTilerTileCooldown();
    }
    if (response && response.ok && global.__offlineMapState && global.__offlineMapState.captureActive) {
      try {
        const cloned = response.clone();
        const blob = await cloned.blob();
        const targetStore = offlineIsTileUrl(targetUrl) ? TILE_STORE : RESOURCE_STORE;
        let existingEntry = null;
        try { existingEntry = await idbGet(targetStore, canonical); } catch (lookupError) { existingEntry = null; }
        const wasNewlyInserted = !existingEntry;
        if (targetStore === TILE_STORE) {
          await idbPut(TILE_STORE, canonical, blob);
        } else {
          await idbPut(RESOURCE_STORE, canonical, { blob: blob, contentType: blob.type || response.headers.get('content-type') || '' });
        }
        const session = global.__offlineMapState.captureSession;
        if (wasNewlyInserted && session) {
          if (targetStore === TILE_STORE) session.tileUrls.add(canonical);
          else session.resourceUrls.add(canonical);
        }
        global.__offlineMapState.captureTotalBytes += blob.size || 0;
      } catch (storeError) {}
    }
    return response;
  }

  function offlineVarintBytes(value) {
    let n = Math.max(0, Number(value) || 0);
    const out = [];
    while (n > 127) {
      out.push((n & 0x7f) | 0x80);
      n = Math.floor(n / 128);
    }
    out.push(n & 0x7f);
    return out;
  }

  function offlineEmptyGlyphPbf(url) {
    const match = String(url || '').match(/\/fonts\/([^/?#]+)\/\d+-\d+\.pbf/i);
    const fontstack = match ? offlineDecodePathComponentRepeated(match[1]) : '';
    if (!fontstack) return new Uint8Array(0);
    const encoder = typeof TextEncoder !== 'undefined' ? new TextEncoder() : null;
    const nameBytes = encoder ? Array.from(encoder.encode(fontstack)) : Array.from(unescape(encodeURIComponent(fontstack))).map(function (ch) { return ch.charCodeAt(0); });
    const inner = [0x0a].concat(offlineVarintBytes(nameBytes.length), nameBytes);
    return new Uint8Array([0x0a].concat(offlineVarintBytes(inner.length), inner));
  }

  function offlineEmptyGlyphResponse(url) {
    return new Response(offlineEmptyGlyphPbf(url), {
      status: 200,
      headers: {
        'Content-Type': 'application/x-protobuf',
        'Cache-Control': 'no-store',
        'Access-Control-Allow-Origin': '*',
        'X-Offline-Cache': 'glyph-placeholder'
      }
    });
  }

  function offlineGlyphRangeLabel(url) {
    const match = String(url || '').match(/\/fonts\/([^/?#]+)\/(\d+-\d+)\.pbf/i);
    if (!match) return '';
    return offlineDecodePathComponentRepeated(match[1]) + ' / ' + match[2];
  }

  function offlineRuntimeGlyphMissState() {
    global.__offlineMapRuntimeGlyphMisses = global.__offlineMapRuntimeGlyphMisses || {};
    return global.__offlineMapRuntimeGlyphMisses;
  }

  function offlineKnownRuntimeGlyphMiss(url) {
    const canonical = offlineCanonicalUrl(url);
    return !!offlineRuntimeGlyphMissState()[canonical];
  }

  function offlineRecordRuntimeGlyphMiss(url, alreadyKnown) {
    const canonical = offlineCanonicalUrl(url);
    const misses = offlineRuntimeGlyphMissState();
    const label = offlineGlyphRangeLabel(canonical) || canonical;
    if (!misses[canonical]) {
      misses[canonical] = { url: canonical, label: label, count: 0, suppressed: 0, lastAt: 0 };
      offlineIncrementDebugCounter('glyphRuntimeMisses', 1);
    } else if (alreadyKnown) {
      misses[canonical].suppressed += 1;
      offlineIncrementDebugCounter('glyphRuntimeMissSuppressed', 1);
    }
    misses[canonical].count += 1;
    misses[canonical].lastAt = Date.now();
  }

  function offlineRuntimeGlyphMissList() {
    const values = Object.keys(offlineRuntimeGlyphMissState()).map(function (key) {
      return offlineRuntimeGlyphMissState()[key];
    });
    values.sort(function (a, b) { return (b.count || 0) - (a.count || 0) || String(a.label || '').localeCompare(String(b.label || '')); });
    return values.slice(0, 12);
  }

  function offlineRuntimeGlyphFallbackResponse(url, alreadyKnown) {
    offlineRecordRuntimeGlyphMiss(url, !!alreadyKnown);
    offlineIncrementDebugCounter('glyphFallbackServed', 1);
    return offlineEmptyGlyphResponse(url);
  }

  async function rollbackOfflineMapSession(session) {
    if (!session) return { rolledBackTiles: 0, rolledBackResources: 0 };
    let tilesRemoved = 0;
    let resourcesRemoved = 0;
    const tileIterator = session.tileUrls ? Array.from(session.tileUrls) : [];
    const resourceIterator = session.resourceUrls ? Array.from(session.resourceUrls) : [];
    for (let i = 0; i < tileIterator.length; i += 1) {
      try { await idbDelete(TILE_STORE, tileIterator[i]); tilesRemoved += 1; } catch (deleteError) {}
    }
    for (let i = 0; i < resourceIterator.length; i += 1) {
      try { await idbDelete(RESOURCE_STORE, resourceIterator[i]); resourcesRemoved += 1; } catch (deleteError) {}
    }
    if (session && session.tileUrls && typeof session.tileUrls.clear === 'function') session.tileUrls.clear();
    if (session && session.resourceUrls && typeof session.resourceUrls.clear === 'function') session.resourceUrls.clear();
    return { rolledBackTiles: tilesRemoved, rolledBackResources: resourcesRemoved };
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
  const PREF_HEADING_FILTER_PRESET = 'gpsHeadingFilterPreset';
  const PREF_HEADING_FILTER_MAX_JUMP_DEG = 'gpsHeadingFilterMaxJumpDeg';
  const PREF_HEADING_FILTER_DEADBAND_DEG = 'gpsHeadingFilterDeadbandDeg';
  const PREF_HEADING_FILTER_SMOOTH_LEVEL = 'gpsHeadingFilterSmoothLevel';
  const PREF_HEADING_FILTER_SAMPLE_MAX = 'gpsHeadingFilterSampleMax';
  const PREF_HEADING_FILTER_TURN_CONFIRM = 'gpsHeadingFilterTurnConfirm';
  const PREF_HEADING_FILTER_MAP_SPIKE_DEG = 'gpsHeadingFilterMapSpikeRejectDeg';
  const PREF_HEADING_FILTER_MAP_BEARING_DEG = 'gpsHeadingFilterMapBearingDeadbandDeg';
  const PREF_DRIVE_ENTER_SPEED_KMH = 'gpsDriveEnterSpeedKmh';
  const PREF_DRIVE_EXIT_SPEED_KMH = 'gpsDriveExitSpeedKmh';
  const PREF_DRIVE_CONFIRM_FIXES = 'gpsDriveConfirmFixes';
  const PREF_DRIVE_EXIT_HOLD_MS = 'gpsDriveExitHoldMs';
  const PREF_DRIVE_MIN_MOVE_M = 'gpsDriveMinMoveM';
  const PREF_BACKGROUND_UPLOAD = 'gpsBackgroundUploadEnabled';
  const PREF_SERVER_UPLOAD = 'gpsServerUploadEnabled';
  const PREF_SERVER_HOST = 'gpsTrackingServerHost';
  const PREF_REST_PORT = 'gpsTrackingRestPort';
  const PREF_MQTT_TCP_PORT = 'gpsTrackingMqttTcpPort';
  const PREF_LEGACY_SERVER_URL = 'gpsTrackingServerUrl';
  const PREF_LEGACY_MQTT_WS_URL = 'gpsTrackingMqttUrl';
  const PREF_LEGACY_MQTT_TCP_HOST = 'gpsTrackingMqttHost';
  const PREF_LEGACY_MQTT_TCP_PORT = 'gpsTrackingMqttPort';
  const DEFAULT_REST_PORT = 1880;
  const DEFAULT_MQTT_TCP_PORT = 1883;
  const DEFAULT_MQTT_WS_PORT = 9001;
  const DEFAULT_SERVER_BASE_URL = String(global.MOBILE_DEFAULT_SERVER_BASE_URL || '').trim();
  const STALE_PROJECT_DEFAULT_HOST = 'raspberrypi.tail47e91f.ts.net';
  const STALE_PROJECT_DEFAULT_LEGACY_URL = 'https://raspberrypi.tail47e91f.ts.net';
  const STALE_PROJECT_DEFAULT_REST_PORT = 443;
  const CURRENT_PROJECT_DEFAULT_HOST = '100.83.91.99';
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
  const TILE_DB_VERSION = 2;
  const TILE_STORE = 'tiles';
  const REGION_STORE = 'regions';
  const RESOURCE_STORE = 'resources';
  const OFFLINE_HOSTS = ['api.maptiler.com', 'unpkg.com'];
  const OFFLINE_RTL_TEXT_PLUGIN_URL = 'https://unpkg.com/@mapbox/mapbox-gl-rtl-text@0.3.0/dist/mapbox-gl-rtl-text.js';
  const OFFLINE_TILE_FETCH_CONCURRENCY = 6;
  const OFFLINE_GLYPH_RANGES = [0, 256, 512, 768, 1024, 1280, 1536, 1792, 2048, 2304, 2560, 2816, 3072, 3328, 7680, 8192, 65024, 127744];
  const OFFLINE_MAX_TILES_PER_REGION = 60000;
  const OFFLINE_ESTIMATED_BYTES_PER_URL = 40000;
  const OFFLINE_ZOOM_PROFILES = {
    save: { label: 'Speicher sparen' },
    standard: { label: 'Standard' },
    detail: { label: 'Hohe Details' }
  };
  const OFFLINE_ROUTE_CORRIDOR_METERS = { save: 1000, standard: 2000, detail: 3000 };
  const MAPTILER_KEY_FALLBACK = '6uXvc8ULbaW0mi6jY4ig';
  const MAPTILER_TILE_COOLDOWN_NETWORK_MS = 60 * 1000;
  const MAPTILER_TILE_COOLDOWN_FORBIDDEN_MS = 5 * 60 * 1000;
  const DEFAULT_IDLE_SEC = 3;
  const DEFAULT_MOVING_SEC = 1;
  const LOOP_TICK_MS = 200;
  const LOCAL_GPS_POLL_INTERVAL_MS = 250;
  const LOCAL_GPS_POLL_MAX_AGE_MS = 120;
  const LOCAL_GPS_POLL_TIMEOUT_MS = 3500;
  const PREF_GET_CACHE_TTL_MS = 3000;
  const SETTINGS_CACHE_TTL_MS = 2500;
  const OFFLINE_REGIONS_CACHE_TTL_MS = 15000;
  const OFFLINE_RECOVER_CACHE_TTL_MS = 10000;
  const BUFFERED_ROUTE_CACHE_TTL_MS = 30000;
  const NETWORK_STATUS_CACHE_TTL_MS = 15000;
  const LOCAL_GPS_WATCH_POLL_SKIP_MS = 2500;
  const LOCAL_GPS_WATCH_POLL_FALLBACK_MS = 10000;
  const LOCAL_GPS_POLL_SUCCESS_SUPPRESS_MS = 20000;
  const PERF_TRACE_THROTTLE_MS = 3000;
  const LOCATION_SERVICES_BLOCKED_COOLDOWN_MS = 45 * 1000;
  const LOCATION_SERVICES_BLOCKED_LOG_THROTTLE_MS = 10000;
  const LOCATION_SERVICES_PROMPT_LOG_THROTTLE_MS = 10000;
  const LOCATION_REQUIRED_ACTION_DEBOUNCE_MS = 2500;
  const LOCATION_REQUIRED_RECHECK_DELAY_MS = 1800;
  const LOCATION_USABLE_CACHED_POINT_MS = 30000;

  let deviceKey = '';
  let trackingActive = false;
  let backgroundWatcherId = null;
  let pointLoopTimer = null;
  let localWatchId = null;
  let localWatchStartPromise = null;
  let localWatchStartGeneration = 0;
  let localWatchStartedAtMs = 0;
  let localPollTimer = null;
  let localGpsPollInFlight = false;
  let lastLocalGpsWatchFixMs = 0;
  let lastLocalGpsWatchPoint = null;
  let lastLocalGpsSuccessfulFixMs = 0;
  let localGpsPermissionReady = false;
  let localGpsPermissionPromise = null;
  let locationServicesBlockedUntilMs = 0;
  let locationServicesBlockedReason = '';
  let lastLocationServicesBlockedLogMs = 0;
  let locationServicesPromptInFlight = null;
  let locationServicesPromptedUntilMs = 0;
  let lastLocationServicesPromptReason = '';
  let lastLocationServicesPromptLogMs = 0;
  let locationSettingsOpenInFlight = null;
  let locationSettingsOpenedUntilMs = 0;
  let lastLocationSettingsOpenReason = '';
  let startupLocationSettingsPromptDone = false;
  let locationServiceState = 'unknown';
  let locationPromptInFlight = null;
  let locationRequiredActionPending = '';
  let lastLocationPromptAction = '';
  let lastLocationPromptAt = 0;
  let locationRequiredRecheckInFlight = null;
  let locationRequiredRecheckTimer = null;
  let locationBlockedFinalActive = false;
  let locationBlockedFinalAtMs = 0;
  let locationLastAvailableAtMs = 0;
  const locationRequiredActionPromptAt = {};
  const prefGetCache = {};
  const perfTraceLastLogAt = {};
  let loadSettingsPromise = null;
  let loadSettingsCachedAt = 0;
  let loadSettingsCacheVersion = 0;
  let settingsLoadedOnce = false;
  let settingsSaveBatchDepth = 0;
  let settingsSaveBatchInvalidated = false;
  let onlineStatusPromise = null;
  let onlineStatusCache = null;
  let onlineStatusCacheAt = 0;
  let onlineStatusCacheVersion = 0;
  let networkStatusListenerRegistered = false;
  let networkStatusListenerPromise = null;
  let browserNetworkListenersRegistered = false;
  let offlineRegionsPromise = null;
  let offlineRegionsCache = null;
  let offlineRegionsCacheAt = 0;
  let offlineRegionsCacheVersion = 0;
  let offlineRecoverPromise = null;
  let offlineRecoverCache = null;
  let offlineRecoverCacheAtMs = 0;
  let bufferedRoutePromise = null;
  let bufferedRouteCache = null;
  let bufferedRouteCacheAt = 0;
  let nativeUploadStarted = null;
  let nativeUploadStartInFlight = null;
  let nativeUploadStartInFlightKey = '';
  let lastStartConfigKey = '';
  let nativeUploadPaused = null;
  let nativeUploadPauseInFlight = null;
  let nativeUploadPauseInFlightValue = null;
  let lastPauseValue = null;
  let nativeUploadStopInFlight = null;

  function invalidateBufferedRouteCache() {
    bufferedRouteCache = null;
    bufferedRouteCacheAt = 0;
  }
  let sendInFlight = false;
  let lastSendMs = 0;
  let lastLiveSendMs = 0;
  let lastRouteSendMs = 0;
  let lastKeepaliveSendMs = 0;
  let lastLat = null;
  let lastLon = null;
  const displayFilterState = { stablePoint: null, stationaryExitCount: 0 };
  const routeReductionState = { lastRoutePoint: null };
  let lastFinalLocalPoint = null;
  let latestCompassHeading = null;
  let lastNativeCompassHeading = null;
  let lastNativeCompassHeadingSyncMs = 0;
  let lastRawCompassHeading = null;
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
  const compassStabilizer = createHeadingStabilizerState();
  const movementStabilizer = createHeadingStabilizerState();
  const NATIVE_COMPASS_SYNC_KEEPALIVE_MS = 4000;
  let driveModeActive = false;
  let driveConfirmStreak = 0;
  let driveExitSinceMs = 0;
  let lastMovementHoldHeading = null;
  let lastEffectiveHeading = { value: null, source: 'hold', mode: 'stationary' };
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
  let configuredServerHost = '';
  let configuredRestPort = DEFAULT_REST_PORT;
  let configuredMqttTcpPort = DEFAULT_MQTT_TCP_PORT;
  let lastServerConfigLogKey = '';
  let staleDefaultMigrationLogEmitted = false;
  let persistentUploadActive = false;
  let serverAvailabilityCheckInFlight = false;

  function defaultPositionFilterSettings() {
    return {
      minMoveM: 0.2,
      maxAccuracyM: 10,
      walkingSpeedKmh: 0.5,
      movingSpeedKmh: 1,
      stationaryRadiusM: 3,
      stationaryMaxRadiusM: 5,
      confirmPoints: 3,
      speedJumpKmh: 3
    };
  }

  const displaySettings = Object.assign(defaultPositionFilterSettings(), {
    headingFilterPreset: 'responsive',
    headingFilterMaxJumpDeg: 55,
    headingFilterDeadbandDeg: 1.5,
    headingFilterSmoothLevel: 7,
    headingFilterSampleMax: 5,
    headingFilterTurnConfirmSamples: 2,
    headingFilterMapSpikeRejectDeg: 60,
    headingFilterMapBearingDeadbandDeg: 2,
    driveEnterSpeedKmh: 10,
    driveExitSpeedKmh: 6,
    driveConfirmFixes: 3,
    driveExitHoldMs: 4000,
    driveMinMoveM: 1
  });

  const uploadSettings = {
    idleSec: DEFAULT_IDLE_SEC,
    movingSec: DEFAULT_MOVING_SEC,
    intervalMin: 0
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

  function prefCacheEntry(key) {
    const cacheKey = String(key || '');
    if (!prefGetCache[cacheKey]) {
      prefGetCache[cacheKey] = { value: null, timestamp: 0, inFlight: null, version: 0 };
    }
    return prefGetCache[cacheKey];
  }

  function prefValueOrFallback(value, fallback) {
    return value != null && value !== '' ? value : fallback;
  }

  async function readPrefStoredValue(key) {
    const Preferences = plugins().Preferences;
    if (Preferences) {
      try {
        perfTraceLog('PreferencesNativeGet', [
          'key=' + String(key || ''),
          'cache=miss',
          'inFlight=false',
          'caller=' + (perfTraceStackLabel(/readPrefStoredValue|prefGet|prefGetWithLegacy/) || 'unknown')
        ], 'pref:' + String(key || ''), PERF_TRACE_THROTTLE_MS);
        const result = await Preferences.get({ key: key });
        if (result && result.value != null && result.value !== '') return result.value;
      } catch (error) {}
    }
    return readLocalPrefStoredValue(key);
  }

  function readLocalPrefStoredValue(key) {
    const raw = localStorage.getItem(key);
    return raw != null && raw !== '' ? raw : null;
  }

  async function prefGet(key, fallback) {
    const entry = prefCacheEntry(key);
    const now = Date.now();
    if (entry.timestamp && now - entry.timestamp < PREF_GET_CACHE_TTL_MS) {
      return prefValueOrFallback(entry.value, fallback);
    }
    if (!entry.inFlight) {
      const version = entry.version;
      entry.inFlight = readPrefStoredValue(key).then(function (value) {
        if (version === entry.version) {
          entry.value = value;
          entry.timestamp = Date.now();
        }
        return value;
      }).finally(function () {
        if (version === entry.version) entry.inFlight = null;
      });
    }
    return entry.inFlight.then(function (value) {
      return prefValueOrFallback(value, fallback);
    });
  }

  function notifySettingsPreferenceChanged(options) {
    if (options && options.deferInvalidate && settingsSaveBatchDepth > 0) {
      settingsSaveBatchInvalidated = true;
      return;
    }
    invalidateSettingsCache();
  }

  function beginSettingsSaveBatch() {
    settingsSaveBatchDepth += 1;
  }

  function endSettingsSaveBatch() {
    if (settingsSaveBatchDepth > 0) settingsSaveBatchDepth -= 1;
    if (settingsSaveBatchDepth === 0 && settingsSaveBatchInvalidated) {
      settingsSaveBatchInvalidated = false;
      invalidateSettingsCache();
      return true;
    }
    return false;
  }

  function markSettingsCacheFresh() {
    loadSettingsCachedAt = Date.now();
    settingsLoadedOnce = true;
  }

  function updatePrefCacheAfterSet(key, stringValue) {
    const entry = prefCacheEntry(key);
    entry.value = stringValue !== '' ? stringValue : readLocalPrefStoredValue(key);
    entry.timestamp = Date.now();
    entry.inFlight = null;
  }

  function prefEffectiveString(value) {
    return value != null && value !== '' ? String(value) : '';
  }

  async function prefSet(key, value, options) {
    const stringValue = String(value);
    const entry = prefCacheEntry(key);
    entry.version += 1;
    entry.inFlight = null;
    const Preferences = plugins().Preferences;
    if (Preferences) {
      try {
        await Preferences.set({ key: key, value: stringValue });
        updatePrefCacheAfterSet(key, stringValue);
        notifySettingsPreferenceChanged(options);
        return;
      } catch (error) {}
    }
    localStorage.setItem(key, stringValue);
    updatePrefCacheAfterSet(key, stringValue);
    notifySettingsPreferenceChanged(options);
  }

  async function prefSetIfChanged(key, value, options) {
    options = options || {};
    const stringValue = String(value);
    const entry = prefCacheEntry(key);
    const hasProvidedCurrent = Object.prototype.hasOwnProperty.call(options, 'currentValue');
    let currentValue = hasProvidedCurrent ? options.currentValue : null;
    if (!hasProvidedCurrent) {
      currentValue = entry.timestamp ? entry.value : await prefGet(key, null);
    } else if (!plugins().Preferences) {
      const localCurrent = readLocalPrefStoredValue(key);
      if (localCurrent != null || currentValue == null) currentValue = localCurrent;
    }
    if (prefEffectiveString(currentValue) === stringValue) {
      entry.version += 1;
      updatePrefCacheAfterSet(key, stringValue);
      return false;
    }
    await prefSet(key, stringValue, options);
    return true;
  }

  async function prefGetWithLegacy(primaryKey, legacyKey, fallback) {
    const primary = await prefGet(primaryKey, null);
    if (primary != null && primary !== '') return primary;
    return prefGet(legacyKey, fallback);
  }

  async function loadPositionFilterSettings(cfg, uploadMode) {
    const minMoveFallbackPromise = prefGet(PREF_MIN_MOVE_M, 0.2);
    const minMovePromise = minMoveFallbackPromise.then(function (minMoveFallback) {
      return prefGetWithLegacy(
        uploadMode ? PREF_UPLOAD_MIN_MOVE_M : PREF_MIN_MOVE_M, PREF_MIN_MOVE_M, minMoveFallback);
    });
    const [
      minMoveRaw,
      maxAccuracyRaw,
      walkingSpeedRaw,
      movingSpeedRaw,
      stationaryRadiusRaw,
      stationaryMaxRadiusRaw,
      confirmPointsRaw,
      speedJumpRaw
    ] = await Promise.all([
      minMovePromise,
      prefGetWithLegacy(uploadMode ? PREF_UPLOAD_MAX_ACCURACY_M : PREF_MAX_ACCURACY_M, PREF_MAX_ACCURACY_M, 10),
      prefGetWithLegacy(uploadMode ? PREF_UPLOAD_WALKING_SPEED_KMH : PREF_WALKING_SPEED_KMH, PREF_WALKING_SPEED_KMH, 0.5),
      prefGetWithLegacy(uploadMode ? PREF_UPLOAD_MOVING_SPEED_KMH : PREF_MOVING_SPEED_KMH, PREF_MOVING_SPEED_KMH, 1),
      prefGetWithLegacy(uploadMode ? PREF_UPLOAD_STATIONARY_RADIUS_M : PREF_STATIONARY_RADIUS_M, PREF_STATIONARY_RADIUS_M, 3),
      prefGetWithLegacy(uploadMode ? PREF_UPLOAD_STATIONARY_MAX_RADIUS_M : PREF_STATIONARY_MAX_RADIUS_M, PREF_STATIONARY_MAX_RADIUS_M, 5),
      prefGetWithLegacy(uploadMode ? PREF_UPLOAD_CONFIRM_POINTS : PREF_CONFIRM_POINTS, PREF_CONFIRM_POINTS, 3),
      prefGetWithLegacy(uploadMode ? PREF_UPLOAD_SPEED_JUMP_KMH : PREF_SPEED_JUMP_KMH, PREF_SPEED_JUMP_KMH, 3)
    ]);
    cfg.minMoveM = clamp(minMoveRaw, 0.2, 20, 0.2);
    cfg.maxAccuracyM = clamp(maxAccuracyRaw, 5, 100, 10);
    cfg.walkingSpeedKmh = clamp(walkingSpeedRaw, 0.5, 8, 0.5);
    cfg.movingSpeedKmh = clamp(movingSpeedRaw, cfg.walkingSpeedKmh, 30, 1);
    cfg.stationaryRadiusM = clamp(stationaryRadiusRaw, 3, 80, 3);
    cfg.stationaryMaxRadiusM = clamp(stationaryMaxRadiusRaw, cfg.stationaryRadiusM, 150, 5);
    cfg.confirmPoints = clampInt(confirmPointsRaw, 1, 8, 3);
    cfg.speedJumpKmh = clamp(speedJumpRaw, 2, 60, 3);
  }

  function invalidateSettingsCache() {
    loadSettingsCachedAt = 0;
    loadSettingsCacheVersion += 1;
  }

  function settingsTraceReason(reason, skipPattern) {
    return String(reason || perfTraceStackLabel(skipPattern || /loadSettings|ensureSettingsLoadedOnce/) || 'unknown');
  }

  async function loadSettingsFromStorage() {
    const startedAt = Date.now();
    const filterPromise = loadPositionFilterSettings(displaySettings, false);
    const headingAndDrivePromise = Promise.all([
      prefGet(PREF_HEADING_FILTER_PRESET, 'responsive'),
      prefGet(PREF_HEADING_FILTER_MAX_JUMP_DEG, 55),
      prefGet(PREF_HEADING_FILTER_DEADBAND_DEG, 1.5),
      prefGet(PREF_HEADING_FILTER_SMOOTH_LEVEL, 7),
      prefGet(PREF_HEADING_FILTER_SAMPLE_MAX, 5),
      prefGet(PREF_HEADING_FILTER_TURN_CONFIRM, 2),
      prefGet(PREF_HEADING_FILTER_MAP_SPIKE_DEG, 60),
      prefGet(PREF_HEADING_FILTER_MAP_BEARING_DEG, 2),
      prefGet(PREF_DRIVE_ENTER_SPEED_KMH, 10),
      prefGet(PREF_DRIVE_EXIT_SPEED_KMH, 6),
      prefGet(PREF_DRIVE_CONFIRM_FIXES, 3),
      prefGet(PREF_DRIVE_EXIT_HOLD_MS, 4000),
      prefGet(PREF_DRIVE_MIN_MOVE_M, 1)
    ]);
    const uploadPromise = Promise.all([
      prefGetWithLegacy(PREF_UPLOAD_IDLE_SEC, PREF_IDLE_SEC, DEFAULT_IDLE_SEC),
      prefGetWithLegacy(PREF_UPLOAD_MOVING_SEC, PREF_MOVING_SEC, DEFAULT_MOVING_SEC),
      prefGetWithLegacy(PREF_UPLOAD_INTERVAL_MIN, PREF_INTERVAL_MIN, 0)
    ]);
    const connectionPromise = Promise.all([
      prefGet(PREF_BACKGROUND_UPLOAD, '1'),
      prefGet(PREF_SERVER_UPLOAD, '1'),
      prefGet(PREF_SERVER_HOST, ''),
      prefGet(PREF_REST_PORT, ''),
      prefGet(PREF_MQTT_TCP_PORT, ''),
      prefGet(PREF_LEGACY_SERVER_URL, ''),
      prefGet(PREF_LEGACY_MQTT_WS_URL, ''),
      prefGet(PREF_LEGACY_MQTT_TCP_HOST, ''),
      prefGet(PREF_LEGACY_MQTT_TCP_PORT, '')
    ]);
    const [
      ,
      headingAndDriveValues,
      uploadValues,
      connectionValues
    ] = await Promise.all([
      filterPromise,
      headingAndDrivePromise,
      uploadPromise,
      connectionPromise
    ]);
    const [
      headingFilterPresetRaw,
      headingFilterMaxJumpDegRaw,
      headingFilterDeadbandDegRaw,
      headingFilterSmoothLevelRaw,
      headingFilterSampleMaxRaw,
      headingFilterTurnConfirmRaw,
      headingFilterMapSpikeRaw,
      headingFilterMapBearingRaw,
      driveEnterSpeedRaw,
      driveExitSpeedRaw,
      driveConfirmFixesRaw,
      driveExitHoldRaw,
      driveMinMoveRaw
    ] = headingAndDriveValues;
    displaySettings.headingFilterPreset = String(headingFilterPresetRaw || 'responsive');
    displaySettings.headingFilterMaxJumpDeg = clamp(headingFilterMaxJumpDegRaw, 15, 60, 55);
    displaySettings.headingFilterDeadbandDeg = clamp(headingFilterDeadbandDegRaw, 1, 8, 1.5);
    displaySettings.headingFilterSmoothLevel = clampInt(headingFilterSmoothLevelRaw, 1, 10, 7);
    displaySettings.headingFilterSampleMax = clampInt(headingFilterSampleMaxRaw, 5, 13, 5);
    displaySettings.headingFilterTurnConfirmSamples = clampInt(headingFilterTurnConfirmRaw, 2, 6, 2);
    displaySettings.headingFilterMapSpikeRejectDeg = clamp(headingFilterMapSpikeRaw, 20, 70, 60);
    displaySettings.headingFilterMapBearingDeadbandDeg = clamp(headingFilterMapBearingRaw, 1, 10, 2);
    displaySettings.driveEnterSpeedKmh = clamp(driveEnterSpeedRaw, 5, 40, 10);
    displaySettings.driveExitSpeedKmh = clamp(driveExitSpeedRaw, 3, 30, 6);
    displaySettings.driveConfirmFixes = clampInt(driveConfirmFixesRaw, 2, 6, 3);
    displaySettings.driveExitHoldMs = clampInt(driveExitHoldRaw, 1000, 15000, 4000);
    displaySettings.driveMinMoveM = clamp(driveMinMoveRaw, 0.2, 20, 1);

    const [
      uploadIdleRaw,
      uploadMovingRaw,
      uploadIntervalRaw
    ] = uploadValues;
    uploadSettings.idleSec = clamp(uploadIdleRaw, 1, 3600, DEFAULT_IDLE_SEC);
    uploadSettings.movingSec = clamp(uploadMovingRaw, 0.2, 60, DEFAULT_MOVING_SEC);
    uploadSettings.intervalMin = clamp(uploadIntervalRaw, 0, 1440, 0);

    const [
      rawBackgroundUpload,
      rawServerUpload,
      rawServerHost,
      rawRestPort,
      rawMqttTcpPort,
      rawLegacyServerUrl,
      rawLegacyMqttWebSocketUrl,
      rawLegacyMqttTcpHost,
      rawLegacyMqttTcpPort
    ] = connectionValues;
    backgroundUploadEnabled = String(rawBackgroundUpload) !== '0' && String(rawBackgroundUpload).toLowerCase() !== 'false';
    serverUploadEnabled = String(rawServerUpload) !== '0' && String(rawServerUpload).toLowerCase() !== 'false';
    const migratedServerConfig = serverConfigFromStored({
      serverHost: rawServerHost,
      restPort: rawRestPort,
      mqttTcpPort: rawMqttTcpPort,
      legacyServerUrl: rawLegacyServerUrl,
      legacyMqttWebSocketUrl: rawLegacyMqttWebSocketUrl,
      legacyMqttTcpHost: rawLegacyMqttTcpHost,
      legacyMqttTcpPort: rawLegacyMqttTcpPort
    });
    configuredServerHost = migratedServerConfig.host;
    configuredRestPort = migratedServerConfig.restPort;
    configuredMqttTcpPort = migratedServerConfig.mqttTcpPort;
    await migrateServerConfigPrefsIfNeeded({
      serverHost: rawServerHost,
      restPort: rawRestPort,
      mqttTcpPort: rawMqttTcpPort
    }, migratedServerConfig);
    logServerConfig('derived', migratedServerConfig);
    try {
      trackingActive = String(localStorage.getItem(TRACKING_ACTIVE_STORAGE_KEY) || '0') === '1';
    } catch (error) {}
    perfTraceLog('SettingsLoadHydrate', [
      'mode=parallel',
      'keys=29',
      'elapsedMs=' + String(Date.now() - startedAt)
    ], 'settings-load-hydrate', PERF_TRACE_THROTTLE_MS);
  }

  async function loadSettings(reason) {
    const now = Date.now();
    if (loadSettingsCachedAt && now - loadSettingsCachedAt < SETTINGS_CACHE_TTL_MS) return;
    if (loadSettingsPromise) return loadSettingsPromise;
    const traceReason = settingsTraceReason(reason, /loadSettings|ensureSettingsLoadedOnce/);
    perfTraceLog('SettingsLoadFull', [
      'reason=' + traceReason,
      'caller=' + (perfTraceStackLabel(/loadSettings|ensureSettingsLoadedOnce/) || traceReason)
    ], 'settings-load-full:' + traceReason, PERF_TRACE_THROTTLE_MS);
    const version = loadSettingsCacheVersion;
    loadSettingsPromise = loadSettingsFromStorage().then(function (result) {
      settingsLoadedOnce = true;
      if (version === loadSettingsCacheVersion) loadSettingsCachedAt = Date.now();
      return result;
    }).finally(function () {
      loadSettingsPromise = null;
    });
    return loadSettingsPromise;
  }

  async function ensureSettingsLoadedOnce() {
    if (settingsLoadedOnce) return;
    return loadSettings('ensureSettingsLoadedOnce');
  }

  function mapTilerKey() {
    return String(global.MAPTILER_API_KEY || localStorage.getItem('maptilerApiKey') || MAPTILER_KEY_FALLBACK).trim();
  }

  function resolveMapStyleUrl(mapId) {
    return 'https://api.maptiler.com/maps/' + mapId + '/style.json?key=' + encodeURIComponent(mapTilerKey());
  }

  function resolveCurrentMapStyleConfig() {
    if (typeof global.__getCurrentBaseMapStyleConfig === 'function') {
      try { return global.__getCurrentBaseMapStyleConfig() || null; } catch (error) {}
    }
    return null;
  }

  function resolveActiveLeafletMap() {
    if (typeof global.__getLeafletMap !== 'function') return null;
    try { return global.__getLeafletMap() || null; } catch (error) { return null; }
  }

  function resolveActiveNativeMapLibreMap() {
    const adapter = resolveActiveLeafletMap();
    if (!adapter) return null;
    if (typeof global.__getMapLibreNativeMap === 'function') {
      try { return global.__getMapLibreNativeMap() || (adapter._native || null); } catch (error) {}
    }
    return adapter._native || null;
  }

  function resolveCurrentMapBounds() {
    const nativeMap = resolveActiveNativeMapLibreMap();
    if (!nativeMap || typeof nativeMap.getBounds !== 'function') return null;
    let nativeBounds;
    try { nativeBounds = nativeMap.getBounds(); } catch (error) { return null; }
    if (!nativeBounds) return null;
    const north = typeof nativeBounds.getNorth === 'function' ? nativeBounds.getNorth() : (nativeBounds._ne && nativeBounds._ne.lat);
    const south = typeof nativeBounds.getSouth === 'function' ? nativeBounds.getSouth() : (nativeBounds._sw && nativeBounds._sw.lat);
    const east = typeof nativeBounds.getEast === 'function' ? nativeBounds.getEast() : (nativeBounds._ne && nativeBounds._ne.lng);
    const west = typeof nativeBounds.getWest === 'function' ? nativeBounds.getWest() : (nativeBounds._sw && nativeBounds._sw.lng);
    if (![north, south, east, west].every(Number.isFinite)) return null;
    return { north: north, south: south, east: east, west: west };
  }

  function resolveCurrentMapZoom() {
    const nativeMap = resolveActiveNativeMapLibreMap();
    if (!nativeMap || typeof nativeMap.getZoom !== 'function') return null;
    try {
      const zoomValue = nativeMap.getZoom();
      return Number.isFinite(zoomValue) ? zoomValue : null;
    } catch (error) { return null; }
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
    const preset = String(presetKey || 'responsive').toLowerCase();
    if (preset === 'custom') return null;
    return mapHeadingFilterPresetToProfileFields(HEADING_FILTER_PRESETS[preset]);
  }

  function resolveHeadingFilterSettings() {
    const presetKey = String(displaySettings.headingFilterPreset || 'responsive').toLowerCase();
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
    const preset = String((data && data.headingFilterPreset) || displaySettings.headingFilterPreset || 'responsive').toLowerCase();
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
    return lastEffectiveHeading.value;
  }

  function createHeadingStabilizerState() {
    return {
      samples: [],
      stable: null,
      output: null,
      turnCandidate: null,
      turnStreak: 0,
      lastRejectedRaw: null,
      lastRejectedMs: 0
    };
  }

  function resetHeadingStabilizerState(stabilizer) {
    if (!stabilizer) return;
    stabilizer.samples = [];
    stabilizer.stable = null;
    stabilizer.output = null;
    stabilizer.turnCandidate = null;
    stabilizer.turnStreak = 0;
    stabilizer.lastRejectedRaw = null;
    stabilizer.lastRejectedMs = 0;
  }

  function resetDriveModeState() {
    driveModeActive = false;
    driveConfirmStreak = 0;
    driveExitSinceMs = 0;
    lastMovementHoldHeading = null;
    lastEffectiveHeading = { value: null, source: 'hold', mode: 'stationary' };
  }

  function updateDriveModeState(speedKmh, distanceM, timestampMs) {
    const cfg = displaySettings;
    const nowMs = timestampMs != null ? timestampMs : Date.now();
    const enterSpeed = cfg.driveEnterSpeedKmh;
    const exitSpeed = cfg.driveExitSpeedKmh;
    const minMove = cfg.driveMinMoveM;
    if (speedKmh != null && speedKmh >= enterSpeed && distanceM >= minMove) {
      driveConfirmStreak += 1;
      driveExitSinceMs = 0;
      if (driveConfirmStreak >= cfg.driveConfirmFixes) {
        driveModeActive = true;
      }
      return;
    }
    if (speedKmh != null && speedKmh < exitSpeed) {
      driveConfirmStreak = 0;
      if (driveModeActive) {
        if (!driveExitSinceMs) {
          driveExitSinceMs = nowMs;
        } else if (nowMs - driveExitSinceMs >= cfg.driveExitHoldMs) {
          driveModeActive = false;
          driveExitSinceMs = 0;
        }
      }
      return;
    }
    if (!driveModeActive) {
      driveConfirmStreak = 0;
    }
  }

  function resolveMovementMode(speedKmh, distanceM, movingNow) {
    if (driveModeActive) return 'drive';
    const minMove = Math.min(displaySettings.minMoveM, 0.8);
    if (movingNow || (speedKmh != null && speedKmh >= displaySettings.walkingSpeedKmh && distanceM >= minMove)) {
      return 'walk';
    }
    return 'stationary';
  }

  function ingestCompassHeadingSample(rawHeading, options) {
    return ingestHeadingSampleInto(compassStabilizer, rawHeading, options);
  }

  function ingestMovementHeadingSample(rawHeading, options) {
    const filter = resolveHeadingFilterSettings();
    const defaults = {
      maxJumpDeg: Math.min(75, filter.maxJumpDeg + 30),
      alpha: Math.min(0.38, headingFilterAlphaFromLevel(filter.smoothLevel) + 0.08),
      turnConfirmSamples: Math.max(2, filter.turnConfirmSamples - 1),
      sampleMax: filter.sampleMax,
      deadbandDeg: filter.deadbandDeg
    };
    return ingestHeadingSampleInto(movementStabilizer, rawHeading, Object.assign(defaults, options || {}));
  }

  function driveMovementHeadingFilterOptions(speedKmh, distanceM) {
    const fastDrive = speedKmh != null && speedKmh >= Math.max(displaySettings.driveEnterSpeedKmh, 18);
    const solidMove = distanceM >= Math.max(2.5, displaySettings.driveMinMoveM * 2);
    return {
      maxJumpDeg: fastDrive || solidMove ? 42 : 55,
      alpha: fastDrive ? 0.58 : 0.46,
      turnConfirmSamples: fastDrive || solidMove ? 1 : 2,
      sampleMax: fastDrive ? 3 : 5,
      deadbandDeg: fastDrive ? 1.5 : 2,
      // Bewegungsrichtung im Auto darf echte 60-120 Grad Kurven annehmen.
      // Einzelne Ausreisser werden durch Median + Turn-Confirm abgefangen.
      preRejectDeg: 181
    };
  }

  function applyEffectiveHeadingToPoint(point, effective) {
    if (!point || !effective) return point;
    point.heading = effective.value;
    point.headingSource = effective.source;
    point.headingMode = effective.mode;
    point.driveModeActive = !!driveModeActive;
    return point;
  }

  function resolveEffectiveHeading(stablePoint, point) {
    if (!point) return lastEffectiveHeading;
    const cfg = displaySettings;
    const distanceM = stablePoint && num(stablePoint.lat) != null && num(stablePoint.lon) != null &&
      num(point.lat) != null && num(point.lon) != null
      ? distanceMeters(stablePoint.lat, stablePoint.lon, point.lat, point.lon)
      : 0;
    let speedKmh = point.speed;
    if ((speedKmh == null || speedKmh < cfg.walkingSpeedKmh) && stablePoint) {
      const dtSeconds = Math.max(0.2, ((point.timestamp || Date.now()) - (stablePoint.timestamp || Date.now())) / 1000);
      if (dtSeconds < 20 && distanceM > 0) {
        const inferredSpeedKmh = distanceM / dtSeconds * 3.6;
        if (inferredSpeedKmh >= cfg.walkingSpeedKmh) {
          speedKmh = inferredSpeedKmh;
        }
      }
    }
    const pointTimestampMs = point.timestamp || Date.now();
    updateDriveModeState(speedKmh, distanceM, pointTimestampMs);
    const minMove = Math.min(cfg.minMoveM, 0.8);
    const movingNow = distanceM >= minMove && speedKmh != null && speedKmh >= cfg.walkingSpeedKmh;
    const mode = resolveMovementMode(speedKmh, distanceM, movingNow);
    const moveHeading = stablePoint && distanceM >= minMove
      ? headingFromMovement(stablePoint.lat, stablePoint.lon, point.lat, point.lon)
      : null;
    const gpsBearing = point.gpsBearing != null ? point.gpsBearing : null;
    const movementModeActive = mode === 'drive';
    const prefersCompassForLiveMode = mode === 'walk' || mode === 'stationary';
    let source = 'hold';
    let rawValue = null;

    if (movementModeActive) {
      const weakMoveVector = distanceM < Math.max(2.5, cfg.driveMinMoveM * 2);
      if (moveHeading != null && gpsBearing != null && weakMoveVector &&
        speedKmh != null && speedKmh >= cfg.driveEnterSpeedKmh &&
        headingDelta(moveHeading, gpsBearing) > 35) {
        rawValue = gpsBearing;
        source = 'gps';
      } else if (moveHeading != null) {
        rawValue = moveHeading;
        source = 'movement';
      } else if (gpsBearing != null) {
        rawValue = gpsBearing;
        source = 'gps';
      } else if (lastMovementHoldHeading != null) {
        rawValue = lastMovementHoldHeading;
        source = 'hold';
      } else if (lastEffectiveHeading.value != null) {
        rawValue = lastEffectiveHeading.value;
        source = 'hold';
      }
    } else if (prefersCompassForLiveMode && latestCompassHeading != null) {
      rawValue = latestCompassHeading;
      source = 'compass';
    } else if (lastMovementHoldHeading != null) {
      rawValue = lastMovementHoldHeading;
      source = 'hold';
    } else if (lastEffectiveHeading.value != null) {
      rawValue = lastEffectiveHeading.value;
      source = lastEffectiveHeading.source === 'compass' && !movementModeActive
        ? 'compass'
        : 'hold';
    } else if (latestCompassHeading != null) {
      rawValue = latestCompassHeading;
      source = 'compass';
    } else if (point.gpsBearing != null) {
      rawValue = point.gpsBearing;
      source = 'gps';
    } else if (moveHeading != null) {
      rawValue = moveHeading;
      source = 'movement';
    } else if (stablePoint && stablePoint.heading != null) {
      rawValue = stablePoint.heading;
      source = stablePoint.headingSource || 'hold';
    } else if (point.heading != null) {
      rawValue = point.heading;
      source = point.headingSource || 'hold';
    }

    let value = rawValue;
    if (rawValue != null && (source === 'movement' || source === 'gps')) {
      value = ingestMovementHeadingSample(rawValue, movementModeActive
        ? driveMovementHeadingFilterOptions(speedKmh, distanceM)
        : null);
    }
    if (value != null && (source === 'movement' || source === 'gps')) {
      lastMovementHoldHeading = value;
    }

    const effective = {
      value: value,
      source: source,
      mode: mode
    };
    lastEffectiveHeading = effective;
    return effective;
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
    latestCompassHeading = ingestCompassHeadingSample(rawHeading, {
      maxJumpDeg: filter.maxJumpDeg,
      alpha: headingFilterAlphaFromLevel(filter.smoothLevel),
      turnConfirmSamples: filter.turnConfirmSamples,
      sampleMax: filter.sampleMax,
      deadbandDeg: filter.deadbandDeg,
      preRejectDeg: Math.max(18, filter.maxJumpDeg * 0.75)
    });
    syncLatestCompassHeadingToNative();
    publishHeadingFilterDebugEvent();
  }

  function syncLatestCompassHeadingToNative() {
    const heading = normalizeHeadingValue(latestCompassHeading);
    if (heading == null) return;
    const plugin = nativeUploadPlugin();
    if (!plugin || typeof plugin.setCompassHeading !== 'function') return;
    const now = Date.now();
    const filter = resolveHeadingFilterSettings();
    const deadbandDeg = filter && filter.deadbandDeg != null ? filter.deadbandDeg : 2;
    const changedEnough = lastNativeCompassHeading == null ||
      headingDelta(heading, lastNativeCompassHeading) >= deadbandDeg;
    const keepaliveExpired = !lastNativeCompassHeadingSyncMs ||
      now - lastNativeCompassHeadingSyncMs >= NATIVE_COMPASS_SYNC_KEEPALIVE_MS;
    if (!changedEnough && !keepaliveExpired) return;
    lastNativeCompassHeading = heading;
    lastNativeCompassHeadingSyncMs = now;
    try {
      const result = plugin.setCompassHeading({
        headingDeg: heading,
        timestampMs: now
      });
      if (result && typeof result.catch === 'function') result.catch(function () {});
    } catch (error) {}
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
    resetHeadingStabilizerState(compassStabilizer);
    resetHeadingStabilizerState(movementStabilizer);
    resetDriveModeState();
    latestCompassHeading = null;
    lastRawCompassHeading = null;
  }

  function getHeadingFilterDebug() {
    return {
      raw: lastRawCompassHeading,
      filtered: compassStabilizer.output,
      stable: compassStabilizer.stable,
      lastRejectedRaw: compassStabilizer.lastRejectedRaw,
      lastRejectedMs: compassStabilizer.lastRejectedMs,
      compass: {
        raw: lastRawCompassHeading,
        filtered: compassStabilizer.output,
        stable: compassStabilizer.stable
      },
      movement: {
        filtered: movementStabilizer.output,
        stable: movementStabilizer.stable
      },
      effective: Object.assign({}, lastEffectiveHeading),
      driveModeActive: driveModeActive,
      settings: resolveHeadingFilterSettings()
    };
  }

  function publishHeadingFilterDebugEvent() {
    global.dispatchEvent(new CustomEvent('capacitor-heading-filter-debug', { detail: getHeadingFilterDebug() }));
  }

  function ingestHeadingSampleInto(stabilizer, rawHeading, options) {
    const normalized = normalizeHeadingValue(rawHeading);
    if (normalized == null) return stabilizer.output;
    const filter = resolveHeadingFilterSettings();
    const opts = options || {};
    const maxJumpDeg = opts.maxJumpDeg != null ? opts.maxJumpDeg : filter.maxJumpDeg;
    const alpha = opts.alpha != null ? opts.alpha : headingFilterAlphaFromLevel(filter.smoothLevel);
    const turnConfirmSamples = opts.turnConfirmSamples != null ? opts.turnConfirmSamples : filter.turnConfirmSamples;
    const sampleMax = opts.sampleMax != null ? opts.sampleMax : filter.sampleMax;
    const deadbandDeg = opts.deadbandDeg != null ? opts.deadbandDeg : filter.deadbandDeg;
    const preRejectDeg = opts.preRejectDeg != null ? opts.preRejectDeg : Math.max(18, maxJumpDeg * 0.75);
    const turnToleranceDeg = Math.max(10, Math.min(18, maxJumpDeg * 0.35));

    if (stabilizer.stable != null && headingDelta(normalized, stabilizer.stable) > preRejectDeg) {
      stabilizer.lastRejectedRaw = normalized;
      stabilizer.lastRejectedMs = Date.now();
      return stabilizer.output;
    }

    stabilizer.samples.push(normalized);
    if (stabilizer.samples.length > sampleMax) {
      stabilizer.samples.shift();
    }

    const medianHeading = circularMedianHeading(stabilizer.samples);
    if (medianHeading == null) return stabilizer.output;

    if (stabilizer.stable == null) {
      stabilizer.stable = medianHeading;
      stabilizer.output = medianHeading;
      stabilizer.turnCandidate = null;
      stabilizer.turnStreak = 0;
      return stabilizer.output;
    }

    const jumpFromStable = headingDelta(medianHeading, stabilizer.stable);
    if (jumpFromStable > maxJumpDeg) {
      if (stabilizer.turnCandidate != null &&
        headingDelta(medianHeading, stabilizer.turnCandidate) <= turnToleranceDeg) {
        stabilizer.turnStreak += 1;
      } else {
        stabilizer.turnCandidate = medianHeading;
        stabilizer.turnStreak = 1;
      }
      if (stabilizer.turnStreak >= turnConfirmSamples &&
        stabilizer.samples.length >= Math.min(3, sampleMax)) {
        const turnDelta = ((medianHeading - stabilizer.stable + 540) % 360) - 180;
        stabilizer.stable = normalizeHeadingValue(
          stabilizer.stable + turnDelta * Math.max(alpha, 0.35)
        );
        stabilizer.turnCandidate = null;
        stabilizer.turnStreak = 0;
      } else {
        stabilizer.lastRejectedRaw = medianHeading;
        stabilizer.lastRejectedMs = Date.now();
      }
    } else {
      stabilizer.turnCandidate = null;
      stabilizer.turnStreak = 0;
      const delta = ((medianHeading - stabilizer.stable + 540) % 360) - 180;
      stabilizer.stable = normalizeHeadingValue(
        stabilizer.stable + delta * alpha
      );
    }

    if (stabilizer.output == null ||
      headingDelta(stabilizer.stable, stabilizer.output) >= deadbandDeg) {
      stabilizer.output = stabilizer.stable;
    }
    return stabilizer.output;
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

  function getRouteSendIntervalMs() {
    if (uploadSettings.intervalMin > 0) return uploadSettings.intervalMin * 60 * 1000;
    return Math.max(200, uploadSettings.movingSec * 1000);
  }

  function getKeepaliveSendIntervalMs() {
    if (uploadSettings.intervalMin > 0) return uploadSettings.intervalMin * 60 * 1000;
    return Math.max(1000, uploadSettings.idleSec * 1000);
  }

  function isRouteSendDue() {
    const intervalMs = getRouteSendIntervalMs();
    return lastRouteSendMs <= 0 || Date.now() - lastRouteSendMs >= intervalMs;
  }

  function isKeepaliveSendDue() {
    const intervalMs = getKeepaliveSendIntervalMs();
    return lastKeepaliveSendMs <= 0 || Date.now() - lastKeepaliveSendMs >= intervalMs;
  }

  function isSendDue() {
    return readQueue().length > 0 ? isRouteSendDue() : isKeepaliveSendDue();
  }

  function isLiveSendDue(point, force) {
    if (force) return true;
    return isKeepaliveSendDue();
  }

  function attachUploadHeadingMetadata(payload, point) {
    if (!payload) return payload;
    if (point && point.headingSource) payload.headingSource = point.headingSource;
    else if (lastEffectiveHeading.source) payload.headingSource = lastEffectiveHeading.source;
    if (point && point.headingMode) payload.headingMode = point.headingMode;
    else if (lastEffectiveHeading.mode) payload.headingMode = lastEffectiveHeading.mode;
    payload.driveModeActive = !!(point && point.driveModeActive != null ? point.driveModeActive : driveModeActive);
    return payload;
  }

  function buildKeepalivePoint(base) {
    if (!base) return null;
    return Object.assign({}, base, {
      routePoint: false,
      final: false,
      liveSample: true,
      timestamp: Date.now(),
      heading: lastEffectiveHeading.value != null ? lastEffectiveHeading.value : base.heading,
      headingSource: lastEffectiveHeading.source || base.headingSource || 'hold',
      headingMode: lastEffectiveHeading.mode || base.headingMode || 'stationary',
      driveModeActive: !!driveModeActive
    });
  }

  function isGpsMqttPayload(payload) {
    if (!payload || payload.source !== 'mobile_app') return false;
    const hasGpsPoint = payload.lat != null && payload.lon != null && payload.timestamp != null;
    const hasGpsFlags = payload.routePoint === true || payload.final === true || payload.liveSample === true;
    return hasGpsPoint && hasGpsFlags;
  }

  function nativeGpsMqttWriterActive() {
    const plugin = nativeUploadPlugin();
    return !!(plugin && (trackingActive || serverUploadEnabled || nativeUploadStarted || nativeUploadStartInFlight || persistentUploadActive));
  }

  function shouldSuppressJsGpsMqttPublish(payload) {
    return isGpsMqttPayload(payload) && nativeGpsMqttWriterActive();
  }

  async function publishMqttPayload(payload, kind) {
    if (!payload || !serverUploadEnabled) return false;
    if (shouldSuppressJsGpsMqttPublish(payload)) return false;
    if (!serverConnectAllowed()) return false;
    const client = await ensureMqttClient();
    if (!client || !client.connected) return false;
    const topic = payload._mqttTopic || mqttTopicForDevice();
    const wirePayload = attachUploadHeadingMetadata(Object.assign({}, payload), payload);
    delete wirePayload._mqttTopic;
    wirePayload.localTracking = !!trackingActive;
    wirePayload._publisher = 'js';
    const ok = await new Promise(function (resolve) {
      client.publish(topic, JSON.stringify(wirePayload), { qos: 1, retain: false }, function (error) {
        resolve(!error);
      });
    });
    if (ok) {
      dispatchTransportState({ connected: true, connecting: false, serverConfigured: true });
      global.dispatchEvent(new CustomEvent(kind === 'route' ? 'capacitor-points-uploaded' : 'capacitor-live-sent', {
        detail: {
          deviceKey: deviceKey,
          count: 1,
          transport: 'mqtt',
          kind: kind || 'live',
          receivedAt: Date.now()
        }
      }));
    }
    return ok;
  }

  async function sendNextQueuedRoutePoint(force) {
    if (!serverUploadEnabled) return false;
    if (locationBlockedWithoutUsablePoint()) return false;
    const queue = readQueue();
    if (!queue.length) return false;
    if (!force && !isRouteSendDue()) return false;
    if (!(await isOnline())) return false;
    const uploadPayload = queue[0];
    const ok = await publishMqttPayload(uploadPayload, 'route');
    if (ok) {
      writeQueue(queue.slice(1));
      lastRouteSendMs = Date.now();
      lastSendMs = Date.now();
      lastLat = uploadPayload.lat;
      lastLon = uploadPayload.lon;
    }
    return ok;
  }

  async function flushUploadQueue(forceAll) {
    if (!serverUploadEnabled || !(await isOnline())) return false;
    let sentAny = false;
    while (readQueue().length) {
      const ok = await sendNextQueuedRoutePoint(forceAll || true);
      if (!ok) break;
      sentAny = true;
    }
    return sentAny;
  }

  async function tickServerUpload(force) {
    if (!serverUploadEnabled || sendInFlight) return false;
    if (locationBlockedWithoutUsablePoint()) return false;
    sendInFlight = true;
    try {
      if (!(await isOnline())) return false;
      const queue = readQueue();
      if (queue.length > 0) {
        return sendNextQueuedRoutePoint(force);
      }
      const base = lastFinalLocalPoint;
      if (!base) return false;
      if (!force && !isKeepaliveSendDue()) return false;
      return publishKeepaliveToServer(force);
    } finally {
      sendInFlight = false;
    }
  }

  function resetFilterStates() {
    displayFilterState.stablePoint = null;
    displayFilterState.stationaryExitCount = 0;
    lastFinalLocalPoint = null;
  }

  async function trySendPosition(position, withTracking) {
    const finalPoint = await ingestGpsUpdate(position, withTracking);
    if (!finalPoint || !serverUploadEnabled) return !!finalPoint;
    return tickServerUpload(false);
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

  function parseServerPort(value, fallback) {
    const n = Number(value);
    return Number.isFinite(n) && n >= 1 && n <= 65535 ? Math.round(n) : fallback;
  }

  function stripIpv6Brackets(host) {
    const text = String(host || '').trim();
    return text.charAt(0) === '[' && text.charAt(text.length - 1) === ']' ? text.slice(1, -1) : text;
  }

  function parseServerAddressInput(value) {
    let raw = String(value || '').trim();
    if (!raw) return { host: '', port: null, protocol: '' };
    try {
      const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw);
      const parsed = new URL(hasScheme ? raw : 'http://' + raw);
      return {
        host: stripIpv6Brackets(parsed.hostname || ''),
        port: parsed.port ? parseServerPort(parsed.port, null) : null,
        protocol: hasScheme ? (parsed.protocol || '') : ''
      };
    } catch (error) {
      const cleaned = raw
        .replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
        .split('/')[0]
        .split('?')[0]
        .split('#')[0]
        .trim();
      const hostPortMatch = cleaned.match(/^(.+):(\d+)$/);
      if (hostPortMatch && hostPortMatch[1].indexOf(':') === -1) {
        return {
          host: stripIpv6Brackets(hostPortMatch[1]),
          port: parseServerPort(hostPortMatch[2], null),
          protocol: ''
        };
      }
      return { host: stripIpv6Brackets(cleaned), port: null, protocol: '' };
    }
  }

  function defaultRestPortForProtocol(protocol, fallback) {
    const p = String(protocol || '').toLowerCase();
    if (p === 'https:' || p === 'wss:') return 443;
    if (p === 'http:' || p === 'ws:') return 80;
    return fallback;
  }

  function normalizeServerConfigInput(data, fallback) {
    data = data || {};
    fallback = fallback || {};
    const fallbackRestPort = parseServerPort(fallback.restPort, DEFAULT_REST_PORT);
    const fallbackMqttTcpPort = parseServerPort(fallback.mqttTcpPort, DEFAULT_MQTT_TCP_PORT);
    const usingMqttWebSocketOnly = data.serverHost == null && data.serverUrl == null && data.mqttWebSocketUrl != null;
    const rawHostInput = data.serverHost != null
      ? data.serverHost
      : (data.serverUrl != null ? data.serverUrl : (data.mqttWebSocketUrl != null ? data.mqttWebSocketUrl : fallback.host || ''));
    const parsedHost = parseServerAddressInput(rawHostInput);
    const host = parsedHost.host || stripIpv6Brackets(fallback.host || '');
    const rawRestPort = data.restPort != null ? data.restPort : data.restApiPort;
    let restPort = parseServerPort(rawRestPort, fallbackRestPort);
    const restPortCanFollowHost = !usingMqttWebSocketOnly &&
      (rawRestPort == null || String(rawRestPort).trim() === '' || restPort === DEFAULT_REST_PORT);
    if (parsedHost.port != null && restPortCanFollowHost) {
      restPort = parsedHost.port;
    } else if (parsedHost.port == null && parsedHost.protocol && restPortCanFollowHost) {
      restPort = defaultRestPortForProtocol(parsedHost.protocol, restPort);
    }
    const rawMqttTcpPort = data.mqttTcpPort != null ? data.mqttTcpPort : data.mqttPort;
    return {
      host: host,
      restPort: parseServerPort(restPort, DEFAULT_REST_PORT),
      mqttTcpPort: parseServerPort(rawMqttTcpPort, fallbackMqttTcpPort)
    };
  }

  function hasStoredServerConfigValue(value) {
    return value != null && String(value).trim() !== '';
  }

  function isStaleProjectDefaultHostInput(value) {
    if (!hasStoredServerConfigValue(value)) return false;
    const parsed = parseServerAddressInput(value);
    const host = String(parsed.host || '').toLowerCase();
    const protocol = String(parsed.protocol || '').toLowerCase();
    const port = parsed.port != null ? parseServerPort(parsed.port, null) : null;
    return host === STALE_PROJECT_DEFAULT_HOST &&
      (protocol === '' || protocol === 'https:' || protocol === 'wss:') &&
      (port == null || port === STALE_PROJECT_DEFAULT_REST_PORT);
  }

  function isStaleProjectDefaultLegacyUrl(value) {
    if (!hasStoredServerConfigValue(value)) return false;
    const raw = String(value || '').trim();
    try {
      const parsed = new URL(raw);
      const path = String(parsed.pathname || '');
      return parsed.protocol === 'https:' &&
        String(parsed.hostname || '').toLowerCase() === STALE_PROJECT_DEFAULT_HOST &&
        (!parsed.port || parseServerPort(parsed.port, null) === STALE_PROJECT_DEFAULT_REST_PORT) &&
        (path === '' || path === '/') &&
        !parsed.search &&
        !parsed.hash;
    } catch (error) {
      return raw.replace(/\/+$/, '').toLowerCase() === STALE_PROJECT_DEFAULT_LEGACY_URL;
    }
  }

  function shouldMigrateStaleProjectDefault(values) {
    values = values || {};
    const hasServerHost = hasStoredServerConfigValue(values.serverHost);
    const hasRestPort = hasStoredServerConfigValue(values.restPort);
    const staleHost = isStaleProjectDefaultHostInput(values.serverHost);
    const staleRestPort = hasRestPort && parseServerPort(values.restPort, null) === STALE_PROJECT_DEFAULT_REST_PORT;
    if (staleHost && staleRestPort) return true;
    if (!isStaleProjectDefaultLegacyUrl(values.legacyServerUrl)) return false;
    if (hasServerHost && !staleHost) return false;
    if (hasRestPort && !staleRestPort) return false;
    const legacyMqttHostSource = values.legacyMqttTcpHost || values.legacyMqttWebSocketUrl;
    if (hasStoredServerConfigValue(legacyMqttHostSource) && !isStaleProjectDefaultHostInput(legacyMqttHostSource)) return false;
    return true;
  }

  function currentProjectDefaultServerConfig() {
    return {
      host: CURRENT_PROJECT_DEFAULT_HOST,
      restPort: DEFAULT_REST_PORT,
      mqttTcpPort: DEFAULT_MQTT_TCP_PORT,
      staleDefaultMigrated: true
    };
  }

  function logStaleDefaultMigration() {
    if (staleDefaultMigrationLogEmitted) return;
    staleDefaultMigrationLogEmitted = true;
    try {
      console.info('ServerConfig action=staleDefaultMigrated old=' + STALE_PROJECT_DEFAULT_HOST +
        ' new=' + CURRENT_PROJECT_DEFAULT_HOST +
        ' rest=' + String(DEFAULT_REST_PORT) +
        ' mqttTcp=' + String(DEFAULT_MQTT_TCP_PORT));
    } catch (error) {}
  }

  function serverConfigFromStored(values) {
    values = values || {};
    if (shouldMigrateStaleProjectDefault(values)) return currentProjectDefaultServerConfig();
    const primaryServerSource = values.serverHost || values.legacyServerUrl;
    const legacyMqttHostSource = values.legacyMqttTcpHost || values.legacyMqttWebSocketUrl;
    const serverHostSource = primaryServerSource || legacyMqttHostSource || DEFAULT_SERVER_BASE_URL;
    const config = normalizeServerConfigInput({
      serverHost: serverHostSource,
      restPort: values.restPort,
      mqttTcpPort: values.mqttTcpPort || values.legacyMqttTcpPort
    }, {
      host: '',
      restPort: DEFAULT_REST_PORT,
      mqttTcpPort: DEFAULT_MQTT_TCP_PORT
    });
    if (!primaryServerSource && legacyMqttHostSource) {
      config.host = parseServerAddressInput(legacyMqttHostSource).host || config.host;
      config.restPort = parseServerPort(values.restPort, DEFAULT_REST_PORT);
    }
    return config;
  }

  async function migrateServerConfigPrefsIfNeeded(stored, config) {
    stored = stored || {};
    config = config || {};
    if (!config.host) return;
    const writes = [];
    if (config.staleDefaultMigrated) {
      writes.push([PREF_SERVER_HOST, config.host]);
      writes.push([PREF_REST_PORT, config.restPort]);
      writes.push([PREF_MQTT_TCP_PORT, config.mqttTcpPort]);
      writes.push([PREF_LEGACY_SERVER_URL, serverBaseUrlFromConfig(config)]);
    } else {
      if (!stored.serverHost) writes.push([PREF_SERVER_HOST, config.host]);
      if (!stored.restPort) writes.push([PREF_REST_PORT, config.restPort]);
      if (!stored.mqttTcpPort) writes.push([PREF_MQTT_TCP_PORT, config.mqttTcpPort]);
    }
    if (!writes.length) return;
    beginSettingsSaveBatch();
    try {
      for (let i = 0; i < writes.length; i += 1) {
        await prefSetIfChanged(writes[i][0], writes[i][1], { deferInvalidate: true });
      }
      if (config.staleDefaultMigrated) logStaleDefaultMigration();
    } finally {
      endSettingsSaveBatch();
    }
  }

  function activeServerConfig() {
    return {
      host: configuredServerHost,
      restPort: parseServerPort(configuredRestPort, DEFAULT_REST_PORT),
      mqttTcpPort: parseServerPort(configuredMqttTcpPort, DEFAULT_MQTT_TCP_PORT)
    };
  }

  function serverConfigIdentity(config) {
    config = config || activeServerConfig();
    return [config.host || '', String(parseServerPort(config.restPort, DEFAULT_REST_PORT)), String(parseServerPort(config.mqttTcpPort, DEFAULT_MQTT_TCP_PORT))].join('|');
  }

  function hostForUrl(host) {
    const clean = stripIpv6Brackets(host);
    return clean.indexOf(':') >= 0 ? '[' + clean + ']' : clean;
  }

  function serverBaseUrlFromConfig(config) {
    config = config || activeServerConfig();
    if (!config.host) return '';
    const restPort = parseServerPort(config.restPort, DEFAULT_REST_PORT);
    const protocol = restPort === 443 ? 'https:' : 'http:';
    const includePort = !((protocol === 'https:' && restPort === 443) || (protocol === 'http:' && restPort === 80));
    return protocol + '//' + hostForUrl(config.host) + (includePort ? ':' + restPort : '');
  }

  function mqttWebSocketUrlFromConfig(config) {
    config = config || activeServerConfig();
    if (!config.host) return '';
    const restPort = parseServerPort(config.restPort, DEFAULT_REST_PORT);
    if (restPort === 443) return 'wss://' + hostForUrl(config.host) + '/mqtt';
    return 'ws://' + hostForUrl(config.host) + ':' + DEFAULT_MQTT_WS_PORT + '/mqtt';
  }

  function logServerConfig(action, config) {
    config = config || activeServerConfig();
    const key = String(action || '') + '|' + serverConfigIdentity(config) + '|' + serverBaseUrlFromConfig(config) + '|' + mqttWebSocketUrlFromConfig(config);
    if (key === lastServerConfigLogKey) return;
    lastServerConfigLogKey = key;
    try {
      console.info('ServerConfig action=' + String(action || 'derived') +
        ' REST=' + serverBaseUrlFromConfig(config) +
        ' MQTT_TCP=' + String(config.host || '') + ':' + String(parseServerPort(config.mqttTcpPort, DEFAULT_MQTT_TCP_PORT)) +
        ' MQTT_WS=' + mqttWebSocketUrlFromConfig(config));
    } catch (error) {}
  }

  function mqttWebSocketUrl() {
    return mqttWebSocketUrlFromConfig(activeServerConfig());
  }

  function mqttHost() {
    return configuredServerHost;
  }

  function mqttPort() {
    return parseServerPort(configuredMqttTcpPort, DEFAULT_MQTT_TCP_PORT);
  }

  function hasConfiguredMqttTarget() {
    return !!configuredServerHost;
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
      gpsBearing: num(coords.heading != null ? coords.heading : coords.bearing),
      battery: null,
      timestamp: position.timestamp || position.time || Date.now()
    };
  }

  function attachEffectiveHeading(point, stablePoint) {
    const effective = resolveEffectiveHeading(stablePoint, point);
    applyEffectiveHeadingToPoint(point, effective);
    publishHeadingFilterDebugEvent();
    return point;
  }

  function stabilizeLocalPoint(point, cfg, filterState) {
    if (!point || !cfg || !filterState) return null;
    let stablePoint = filterState.stablePoint;
    let stationaryExitCount = filterState.stationaryExitCount || 0;
    if (!stablePoint) {
      if (point.accuracy != null && point.accuracy > cfg.maxAccuracyM) return null;
      stablePoint = Object.assign({}, point);
      attachEffectiveHeading(stablePoint, stablePoint);
      filterState.stablePoint = stablePoint;
      filterState.stationaryExitCount = 0;
      return Object.assign({}, point, {
        rawLat: point.lat,
        rawLon: point.lon,
        heading: stablePoint.heading,
        headingSource: stablePoint.headingSource,
        headingMode: stablePoint.headingMode,
        stationary: false
      });
    }
    const stationaryPoint = function () {
      attachEffectiveHeading(point, stablePoint);
      const liveHeading = point.heading != null ? point.heading : stablePoint.heading;
      if (point.heading != null) {
        stablePoint.heading = point.heading;
        stablePoint.headingSource = point.headingSource;
        stablePoint.headingMode = point.headingMode;
      }
      return Object.assign({}, point, {
        rawLat: point.lat,
        rawLon: point.lon,
        lat: stablePoint.lat,
        lon: stablePoint.lon,
        accuracy: stablePoint.accuracy,
        speed: point.speed != null && point.speed >= cfg.walkingSpeedKmh ? smoothSpeedKmh(point.speed, stablePoint.speed, cfg) : 0,
        heading: liveHeading,
        headingSource: point.headingSource || stablePoint.headingSource,
        headingMode: point.headingMode || stablePoint.headingMode,
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
    attachEffectiveHeading(point, stablePoint);
    stablePoint = Object.assign({}, point);
    filterState.stablePoint = stablePoint;
    filterState.stationaryExitCount = stationaryExitCount;
    return Object.assign({}, point, {
      rawLat: point.lat,
      rawLon: point.lon,
      heading: point.heading,
      headingSource: point.headingSource,
      headingMode: point.headingMode,
      stationary: false
    });
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
    attachEffectiveHeading(firstPoint, null);
    displayFilterState.stablePoint = firstPoint;
    displayFilterState.stationaryExitCount = 0;
    return Object.assign({}, point, {
      rawLat: point.lat,
      rawLon: point.lon,
      heading: firstPoint.heading,
      headingSource: firstPoint.headingSource,
      headingMode: firstPoint.headingMode,
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

  function getFreshWatchLocalPoint(maxAgeMs) {
    const ageLimit = Math.max(0, Number(maxAgeMs || LOCAL_GPS_WATCH_POLL_SKIP_MS) || 0);
    if (!lastLocalGpsWatchPoint || !lastLocalGpsWatchFixMs) return null;
    if (Date.now() - lastLocalGpsWatchFixMs > ageLimit) return null;
    return Object.assign({}, lastLocalGpsWatchPoint);
  }

  function validLocalPoint(point) {
    return !!(point &&
      num(point.lat) != null &&
      num(point.lon) != null);
  }

  function getUsableLocalPoint(maxAgeMs) {
    const watchPoint = getFreshWatchLocalPoint(maxAgeMs || LOCAL_GPS_WATCH_POLL_FALLBACK_MS);
    if (validLocalPoint(watchPoint) && pointAllowedAfterBlockedFinal(watchPoint)) return watchPoint;
    const point = getLastLocalPoint();
    if (!validLocalPoint(point)) return null;
    const timestamp = num(point.timestamp);
    const ageLimit = Math.max(0, Number(maxAgeMs || LOCATION_USABLE_CACHED_POINT_MS) || 0);
    if (!timestamp || Date.now() - timestamp > ageLimit) return null;
    if (!pointAllowedAfterBlockedFinal(point)) return null;
    return Object.assign({}, point);
  }

  function getAnyLocalPoint() {
    const watchPoint = getFreshWatchLocalPoint(LOCAL_GPS_WATCH_POLL_FALLBACK_MS);
    if (validLocalPoint(watchPoint) && pointAllowedAfterBlockedFinal(watchPoint)) return watchPoint;
    const point = getLastLocalPoint();
    return validLocalPoint(point) && pointAllowedAfterBlockedFinal(point) ? point : null;
  }

  function dispatchCachedLocalPoint(point) {
    if (!point) return null;
    const eventPoint = Object.assign({}, point);
    global.dispatchEvent(new CustomEvent('capacitor-gps-point', { detail: eventPoint }));
    return eventPoint;
  }

  async function waitForFreshWatchPoint(maxWaitMs) {
    const deadline = Date.now() + Math.max(0, Number(maxWaitMs || 0) || 0);
    let point = getFreshWatchLocalPoint(LOCAL_GPS_WATCH_POLL_FALLBACK_MS);
    while (!point && Date.now() < deadline) {
      await waitMs(Math.min(120, Math.max(20, deadline - Date.now())));
      point = getFreshWatchLocalPoint(LOCAL_GPS_WATCH_POLL_FALLBACK_MS);
    }
    return point;
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
      headingSource: point.headingSource,
      headingMode: point.headingMode,
      driveModeActive: point.driveModeActive === true,
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

  let tileDbPromise = null;
  function openTileDb() {
    if (tileDbPromise) return tileDbPromise;
    tileDbPromise = new Promise(function (resolve, reject) {
      const req = indexedDB.open(TILE_DB, TILE_DB_VERSION);
      req.onupgradeneeded = function () {
        const db = req.result;
        if (!db.objectStoreNames.contains(TILE_STORE)) db.createObjectStore(TILE_STORE);
        if (!db.objectStoreNames.contains(REGION_STORE)) db.createObjectStore(REGION_STORE, { keyPath: 'id' });
        if (!db.objectStoreNames.contains(RESOURCE_STORE)) db.createObjectStore(RESOURCE_STORE);
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () {
        tileDbPromise = null;
        reject(req.error);
      };
    });
    return tileDbPromise;
  }

  async function idbGet(storeName, key) {
    const db = await openTileDb();
    return new Promise(function (resolve, reject) {
      let req;
      try {
        const tx = db.transaction(storeName, 'readonly');
        req = tx.objectStore(storeName).get(key);
      } catch (error) {
        resolve(null);
        return;
      }
      req.onsuccess = function () { resolve(req.result == null ? null : req.result); };
      req.onerror = function () { reject(req.error); };
    });
  }

  async function idbPut(storeName, key, value) {
    const db = await openTileDb();
    return new Promise(function (resolve, reject) {
      let req;
      try {
        const tx = db.transaction(storeName, 'readwrite');
        const store = tx.objectStore(storeName);
        req = key == null ? store.put(value) : store.put(value, key);
      } catch (error) {
        reject(error);
        return;
      }
      req.onsuccess = function () { resolve(true); };
      req.onerror = function () { reject(req.error); };
    });
  }

  async function idbDelete(storeName, key) {
    const db = await openTileDb();
    return new Promise(function (resolve, reject) {
      let req;
      try {
        const tx = db.transaction(storeName, 'readwrite');
        req = tx.objectStore(storeName).delete(key);
      } catch (error) {
        reject(error);
        return;
      }
      req.onsuccess = function () { resolve(true); };
      req.onerror = function () { reject(req.error); };
    });
  }

  async function idbGetAll(storeName) {
    const db = await openTileDb();
    return new Promise(function (resolve, reject) {
      let req;
      try {
        const tx = db.transaction(storeName, 'readonly');
        req = tx.objectStore(storeName).getAll();
      } catch (error) {
        resolve([]);
        return;
      }
      req.onsuccess = function () { resolve(Array.isArray(req.result) ? req.result : []); };
      req.onerror = function () { reject(req.error); };
    });
  }

  async function tileGet(key) {
    return idbGet(TILE_STORE, key);
  }
  async function tilePut(key, blob) {
    return idbPut(TILE_STORE, key, blob);
  }

  function invalidateOnlineStatusCache() {
    onlineStatusCacheAt = 0;
    onlineStatusCache = null;
    onlineStatusCacheVersion += 1;
  }

  function onlineStatusCacheAgeMs(now) {
    return onlineStatusCacheAt ? Math.max(0, (now || Date.now()) - onlineStatusCacheAt) : -1;
  }

  function networkTraceReason(reason, skipPattern) {
    return String(reason || perfTraceStackLabel(skipPattern || /readOnlineStatus|isOnline/) || 'unknown');
  }

  async function readOnlineStatus(reason) {
    const Network = plugins().Network;
    const traceReason = networkTraceReason(reason, /readOnlineStatus|isOnline/);
    if (Network) {
      try {
        perfTraceLog('NetworkStatusNative', [
          'reason=' + traceReason,
          'cacheAgeMs=' + onlineStatusCacheAgeMs()
        ], 'network-status:native:' + traceReason, PERF_TRACE_THROTTLE_MS);
        const status = await Network.getStatus();
        return !!status.connected;
      } catch (error) {}
    }
    return navigator.onLine !== false;
  }

  async function isOnline(reasonOrOptions) {
    const options = typeof reasonOrOptions === 'object' && reasonOrOptions ? reasonOrOptions : {};
    const reason = networkTraceReason(typeof reasonOrOptions === 'string' ? reasonOrOptions : options.reason, /isOnline/);
    const force = options.force === true;
    const now = Date.now();
    if (!force && onlineStatusCache && now - onlineStatusCacheAt < NETWORK_STATUS_CACHE_TTL_MS) {
      perfTraceLog('NetworkStatus', [
        'source=cache',
        'reason=' + reason
      ], 'network-status:cache:' + reason, PERF_TRACE_THROTTLE_MS);
      return onlineStatusCache.connected;
    }
    if (!force && onlineStatusPromise) {
      perfTraceLog('NetworkStatus', [
        'source=inFlight',
        'reason=' + reason
      ], 'network-status:inflight:' + reason, PERF_TRACE_THROTTLE_MS);
      return onlineStatusPromise;
    }
    const version = onlineStatusCacheVersion;
    onlineStatusPromise = readOnlineStatus(reason).then(function (connected) {
      if (version === onlineStatusCacheVersion) {
        onlineStatusCache = { connected: connected };
        onlineStatusCacheAt = Date.now();
      }
      return connected;
    }).finally(function () {
      onlineStatusPromise = null;
    });
    return onlineStatusPromise;
  }

  function setupNetworkStatusHandlers() {
    const Network = plugins().Network;
    if (Network && typeof Network.addListener === 'function') {
      if (networkStatusListenerRegistered || networkStatusListenerPromise) {
        perfTraceLog('NetworkListener', [
          'action=reuse'
        ], 'network-listener:reuse', PERF_TRACE_THROTTLE_MS);
      } else {
        perfTraceLog('NetworkListener', [
          'action=register'
        ], 'network-listener:register', PERF_TRACE_THROTTLE_MS);
        networkStatusListenerRegistered = true;
        networkStatusListenerPromise = Promise.resolve(Network.addListener('networkStatusChange', function (status) {
          onlineStatusCache = { connected: !!(status && status.connected) };
          onlineStatusCacheAt = Date.now();
          onlineStatusCacheVersion += 1;
          refreshNetworkMode();
        })).catch(function () {
          networkStatusListenerRegistered = false;
        }).finally(function () {
          networkStatusListenerPromise = null;
        });
      }
    }
    if (browserNetworkListenersRegistered) return;
    browserNetworkListenersRegistered = true;
    global.addEventListener('online', function () {
      onlineStatusCache = { connected: true };
      onlineStatusCacheAt = Date.now();
      onlineStatusCacheVersion += 1;
      refreshNetworkMode();
    });
    global.addEventListener('offline', function () {
      onlineStatusCache = { connected: false };
      onlineStatusCacheAt = Date.now();
      onlineStatusCacheVersion += 1;
      refreshNetworkMode();
    });
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
    attachUploadHeadingMetadata(payload, point);
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

  function getBufferedRouteCached(reason, options) {
    const nativeUpload = nativeUploadPlugin();
    const caller = String(reason || perfTraceStackLabel(/getBufferedRouteCached|importNativeBufferedRoute/) || 'unknown');
    const force = options && options.force === true;
    const allowStale = options && options.allowStale === true;
    if (!nativeUpload || typeof nativeUpload.getBufferedRoute !== 'function') return Promise.resolve(null);
    const now = Date.now();
    if (!force && allowStale && bufferedRouteCache) {
      perfTraceLog('BufferedRoute', [
        'source=cache',
        'reason=' + caller
      ], 'buffered-route:stale-cache:' + caller, PERF_TRACE_THROTTLE_MS);
      return Promise.resolve(bufferedRouteCache);
    }
    if (!force && bufferedRouteCache && now - bufferedRouteCacheAt < BUFFERED_ROUTE_CACHE_TTL_MS) {
      perfTraceLog('BufferedRoute', [
        'source=cache',
        'reason=' + caller
      ], 'buffered-route:cache:' + caller, PERF_TRACE_THROTTLE_MS);
      return Promise.resolve(bufferedRouteCache);
    }
    if (!force && bufferedRoutePromise) {
      perfTraceLog('BufferedRoute', [
        'source=inFlight',
        'reason=' + caller
      ], 'buffered-route:inflight:' + caller, PERF_TRACE_THROTTLE_MS);
      return bufferedRoutePromise;
    }
    perfTraceLog('BufferedRoute', [
      'source=native',
      'reason=' + caller
    ], 'buffered-route:native:' + caller, PERF_TRACE_THROTTLE_MS);
    bufferedRoutePromise = Promise.resolve(nativeUpload.getBufferedRoute({})).then(function (result) {
      bufferedRouteCache = result || {};
      bufferedRouteCacheAt = Date.now();
      return bufferedRouteCache;
    }).finally(function () {
      bufferedRoutePromise = null;
    });
    return bufferedRoutePromise;
  }

  async function importNativeBufferedRoute(reason, options) {
    const nativeUpload = nativeUploadPlugin();
    if (!nativeUpload || typeof nativeUpload.getBufferedRoute !== 'function') return false;
    try {
      const result = await getBufferedRouteCached(reason || 'importNativeBufferedRoute', Object.assign({ allowStale: true }, options || {}));
      if (!result) return false;
      const nativeRoute = parseJsonArray(result && result.localRouteJson);
      const nativeQueue = parseJsonArray(result && result.queueJson);
      const blockedForImport = locationBlockedWithoutUsablePoint();
      const nativeTrackingActive = result && result.tracking != null
        ? (!blockedForImport && (!!result.tracking || trackingActive))
        : trackingActive;
      let changed = false;
      if (nativeRoute.length) {
        const mergedRoute = mergeRoutePoints(readLocalRoute(), nativeRoute, 2000);
        localStorage.setItem(LOCAL_ROUTE_STORAGE_KEY, JSON.stringify(mergedRoute));
        const importedRouteTail = mergedRoute.length ? mergedRoute[mergedRoute.length - 1] : null;
        routeReductionState.lastRoutePoint = importedRouteTail;
        if (nativeTrackingActive && importedRouteTail) {
          lastFinalLocalPoint = importedRouteTail;
        }
        changed = true;
      }
      if (nativeQueue.length) {
        writeQueue(mergeRoutePoints(readQueue(), nativeQueue, 500));
        changed = true;
      } else {
        dispatchQueueState(readQueue());
      }
      if (result && result.tracking != null) {
        trackingActive = nativeTrackingActive;
        localStorage.setItem(TRACKING_ACTIVE_STORAGE_KEY, trackingActive ? '1' : '0');
        if (!trackingActive && blockedForImport) {
          localStorage.setItem(TRACKING_STOPPED_AT_STORAGE_KEY, String(Date.now()));
          dispatchTrackingState('blocked-final');
        }
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
      invalidateBufferedRouteCache();
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
        // Stabile clientId + persistente Session (clean:false): der Broker puffert
        // QoS1-Kommandos (tracking_start/stop/reset), falls das Handy kurz offline ist,
        // und liefert sie beim naechsten Reconnect zuverlaessig nach.
        const clientId = 'mobile_app_' + sanitizePart(deviceKey, 'phone').replace(/[/.]/g, '_');
        const client = global.mqtt.connect(targetUrl, {
          clientId: clientId,
          clean: false,
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
    if (action === 'tracking_start' || action === 'tracking_stop' || action === 'tracking_reset') {
      // Server-Fernsteuerung: die Zustandsmaschine (inkl. Dialog) lebt in Maplogik.
      global.dispatchEvent(new CustomEvent('capacitor-tracking-command', { detail: command || {} }));
      return true;
    }
    if (action !== 'request_location_update' && action !== 'requestLocation') return true;
    const latestPoint = getLastLocalPoint();
    if (latestPoint) {
      global.dispatchEvent(new CustomEvent('capacitor-gps-point', { detail: latestPoint }));
      if (serverUploadEnabled) tickServerUpload(true).catch(function () {});
    }
    requestLocationNow({ tracking: trackingActive, commandResponse: true })
      .catch(function () {});
    return true;
  }

  async function publishMqttPoint(point) {
    const payload = queuedTrackPayload(point);
    if (!payload) return false;
    return publishMqttPayload(payload, 'route');
  }

  async function publishLivePointToServer(point, force) {
    if (!serverUploadEnabled) return false;
    const basePoint = point && point.headingSource === 'compass'
      ? point
      : buildKeepalivePoint(lastFinalLocalPoint || point);
    if (!basePoint) return false;
    if (!isLiveSendDue(basePoint, force)) return false;
    const payload = trackPayloadFromPoint(liveSamplePoint(basePoint), true);
    if (!payload || payload.routePoint === true) return false;
    payload._mqttTopic = mqttTopicForDevice();
    if (!(await isOnline())) return false;
    const ok = await publishMqttPayload(payload, 'live');
    if (ok) {
      lastLiveSendMs = Date.now();
      lastKeepaliveSendMs = Date.now();
      lastSendMs = Date.now();
    }
    return ok;
  }

  async function publishKeepaliveToServer(force) {
    return publishLivePointToServer(null, force);
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
    if (!serverConnectAllowed()) return;
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

  function publishTrackingStatus() {
    if (!serverUploadEnabled) return Promise.resolve(false);
    return tickServerUpload(true).catch(function () { return false; });
  }

  async function sendLastLocalPointIfAvailable() {
    if (!serverUploadEnabled) return false;
    return tickServerUpload(true);
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

  async function publishDisplayPoint(base, withTrackingFlag) {
    if (!base) return null;
    if (!pointAllowedAfterBlockedFinal(base)) return null;
    const point = await enrichPoint(base);
    point.deviceKey = deviceKey;
    point.source = 'mobile_app';
    point.filters = displayFilterSettingsPayload();
    markRoutePointIfNeeded(point, withTrackingFlag != null ? !!withTrackingFlag : trackingActive);
    lastFinalLocalPoint = Object.assign({}, point);
    lastLocalGpsSuccessfulFixMs = Date.now();
    clearLocationServicesBlocked();
    storeFinalLocalPoint(point, withTrackingFlag != null ? !!withTrackingFlag : trackingActive);
    global.dispatchEvent(new CustomEvent('capacitor-gps-point', { detail: point }));
    return point;
  }

  async function ingestGpsUpdate(position, withTrackingFlag) {
    const raw = pointFromNative(position);
    if (!raw) return null;
    const filtered = stabilizeDisplayPoint(raw, { firstFix: !getLastLocalPoint() });
    if (!filtered) return null;
    const point = await publishDisplayPoint(filtered, withTrackingFlag);
    if (point && serverUploadEnabled) tickServerUpload(false).catch(function () {});
    return point;
  }

  async function publishLocalPoint(position, withTrackingFlag) {
    return ingestGpsUpdate(position, withTrackingFlag);
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

  async function sendPointToServer(point, withTracking) {
    if (!point || !serverUploadEnabled) return false;
    queueTrackPoint(point);
    return sendNextQueuedRoutePoint(true);
  }

  async function sendPoint(position, withTracking) {
    const displayPoint = await ingestGpsUpdate(position, withTracking);
    if (!displayPoint) return false;
    if (!serverUploadEnabled) {
      lastLat = displayPoint.lat;
      lastLon = displayPoint.lon;
      setStatus('Nur lokale Anzeige — kein Server-Upload');
      return false;
    }
    return tickServerUpload(false);
  }

  function getCurrentPositionWithReason(reason, options, meta) {
    const Geolocation = plugins().Geolocation;
    if (!(meta && meta.allowWhileBlocked === true) &&
        shouldSkipLocationServicesNativeCall('getCurrentPosition:' + String(reason || 'unknown'))) {
      return Promise.resolve(null);
    }
    const watchFresh = !!(lastLocalGpsWatchFixMs && Date.now() - lastLocalGpsWatchFixMs < LOCAL_GPS_WATCH_POLL_FALLBACK_MS);
    perfTraceLog('GeoCurrentPosition', [
      'reason=' + String(reason || 'unknown'),
      'watchFresh=' + String(watchFresh),
      'requestInFlight=' + String(!!requestLocationInFlight),
      'burstInFlight=' + String(!!locationBurstInFlight),
      'caller=' + (perfTraceStackLabel(/getCurrentPositionWithReason/) || 'unknown')
    ], 'geo:' + String(reason || 'unknown'), 1000);
    const requestedAtMs = Date.now();
    return Geolocation.getCurrentPosition(options).then(function (position) {
      const raw = pointFromNative(position);
      if (raw && pointAllowedAfterBlockedFinal(raw)) clearLocationServicesBlocked();
      return position;
    }).catch(function (error) {
      if (locationLastAvailableAtMs && requestedAtMs < locationLastAvailableAtMs) {
        traceLocationServicesBlocked('skip', locationServicesBlockedReason || String(reason || 'stale'));
        return null;
      }
      if (locationBlockedFinalActive && locationBlockedFinalAtMs && requestedAtMs < locationBlockedFinalAtMs) {
        traceLocationServicesBlocked('skip', locationServicesBlockedReason || String(reason || 'stale'));
        return null;
      }
      markLocationServicesBlocked(error, null, {
        openSettings: !!(meta && meta.openSettings),
        promptReason: (meta && meta.promptReason) || String(reason || 'unknown'),
        logSkip: true,
        allowHidden: !!(meta && meta.allowHidden),
        explicitAction: !!(meta && meta.explicitAction),
        requiredAction: meta && meta.requiredAction
      });
      throw error;
    });
  }

  async function requestLocationNow(options) {
    if (requestLocationInFlight) return requestLocationInFlight;
    requestLocationInFlight = (async function () {
      options = options || {};
      const explicitFirstFix = !!(options && options.firstFix);
      const hardRefresh = !!(options && options.hardRefresh);
      const requiredAction = normalizeLocationRequiredAction(options.requiredAction || options.promptReason || (hardRefresh ? 'locateHardRefresh' : 'locateShort'));
      const promptReason = options.promptReason || requiredAction;
      const promptOptions = {
        prompt: options.promptLocationServices !== false && options.commandResponse !== true,
        logSkip: true,
        requiredAction: requiredAction,
        explicitAction: options.commandResponse !== true && requiredAction !== 'startup'
      };
      const blockedAtEntry = locationBlockedWithoutUsablePoint() || locationServiceState === 'prompting';
      if (!blockedAtEntry && !hardRefresh && !explicitFirstFix) {
        const watchPoint = getFreshWatchLocalPoint(LOCAL_GPS_WATCH_POLL_SKIP_MS);
        if (validLocalPoint(watchPoint)) {
          const localOnly = !!(options && options.localOnly);
          dispatchCachedLocalPoint(watchPoint);
          if (serverUploadEnabled && !localOnly) {
            tickServerUpload(true).catch(function () {});
          } else if (!serverUploadEnabled) {
            setStatus('Nur lokale Anzeige - kein Server-Upload');
          }
          return watchPoint;
        }
      }
      if (blockedAtEntry) {
        if (promptOptions.prompt) await promptLocationRequiredAction(requiredAction, promptOptions);
        const recoveredPoint = await waitForLocationRequiredOutcome(requiredAction);
        if (validLocalPoint(recoveredPoint)) {
          dispatchCachedLocalPoint(recoveredPoint);
          traceLocationRequired(requiredAction, 'ready');
          return recoveredPoint;
        }
      }
      if (shouldSkipLocationServicesNativeCall('requestLocationNow')) {
        if (!locationBlockedFinalActive && locationServiceState !== 'disabled') {
          traceLocationRequired(requiredAction, 'blocked');
        }
        setStatus('GPS sucht noch - bitte Standort aktivieren oder kurz warten');
        return null;
      }
      await ensureSettingsLoadedOnce();
      await ensureDeviceKey();
      const Geolocation = plugins().Geolocation;
      if (!Geolocation || !(await ensureLocalGpsPermission(promptReason, promptOptions))) {
        setStatus(locationBlockedWithoutUsablePoint() ? 'GPS sucht noch - bitte Standort aktivieren oder kurz warten' : 'Standortberechtigung fehlt');
        return null;
      }
      let position = null;
      try {
        position = await getCurrentPositionWithReason('requestLocationNow', {
          enableHighAccuracy: true,
          timeout: 15000,
          maximumAge: 0
        }, {
          openSettings: promptOptions.prompt,
          promptReason: promptReason,
          explicitAction: promptOptions.explicitAction,
          requiredAction: requiredAction
        });
      } catch (error) {
        if (isLocationServicesDisabledError(error) || locationBlockedWithoutUsablePoint()) {
          const recoveredPoint = await waitForLocationRequiredOutcome(requiredAction);
          if (validLocalPoint(recoveredPoint)) {
            dispatchCachedLocalPoint(recoveredPoint);
            traceLocationRequired(requiredAction, 'ready');
            return recoveredPoint;
          }
          if (locationServiceState === 'disabled' || locationBlockedFinalActive) {
            if (!locationBlockedFinalActive) await finalizeLocationRequiredBlocked(requiredAction, 'blocked-final');
            setStatus('GPS sucht noch - bitte Standort aktivieren oder kurz warten');
            return null;
          }
          traceLocationRequired(requiredAction, 'blocked');
          setStatus('GPS sucht noch - bitte Standort aktivieren oder kurz warten');
          return null;
        }
        throw error;
      }
      const raw = pointFromNative(position);
      if (!raw || !pointAllowedAfterBlockedFinal(raw)) return null;
      const displayPoint = stabilizeDisplayPoint(Object.assign({}, raw), {
        firstFix: explicitFirstFix || !getLastLocalPoint()
      });
      if (!displayPoint) {
        setStatus('GPS sucht noch - bitte Standort aktivieren oder kurz warten');
        return null;
      }
      const requestTracking = options && options.tracking != null ? !!options.tracking : trackingActive;
      const localOnly = !!(options && options.localOnly);
      const localPoint = await publishDisplayPoint(displayPoint, requestTracking);
      if (serverUploadEnabled && !localOnly) {
        tickServerUpload(true).catch(function () {});
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
      const requestTracking = options.tracking != null ? !!options.tracking : trackingActive;
      const localOnly = options.localOnly !== false;
      const requiredAction = normalizeLocationRequiredAction(options.requiredAction || options.promptReason || (options.hardRefresh === true ? 'locateHardRefresh' : 'locateShort'));
      const promptReason = options.promptReason || requiredAction;
      const promptOptions = {
        prompt: options.promptLocationServices !== false && options.commandResponse !== true,
        logSkip: true,
        requiredAction: requiredAction,
        explicitAction: options.commandResponse !== true && requiredAction !== 'startup'
      };
      const blockedAtEntry = locationBlockedWithoutUsablePoint() || locationServiceState === 'prompting';
      if (options.hardRefresh !== true) {
        const watchPoint = getFreshWatchLocalPoint(LOCAL_GPS_WATCH_POLL_SKIP_MS);
        if (!blockedAtEntry && validLocalPoint(watchPoint)) {
          dispatchCachedLocalPoint(watchPoint);
          if (serverUploadEnabled && !localOnly) {
            tickServerUpload(true).catch(function () {});
          }
          return watchPoint;
        }
        return requestLocationNow({
          tracking: requestTracking,
          localOnly: localOnly,
          firstFix: !!options.firstFix,
          hardRefresh: false,
          requiredAction: requiredAction,
          promptReason: promptReason,
          promptLocationServices: options.promptLocationServices,
          commandResponse: options.commandResponse
        });
      }
      if (blockedAtEntry) {
        if (promptOptions.prompt) await promptLocationRequiredAction(requiredAction, promptOptions);
        const recoveredPoint = await waitForLocationRequiredOutcome(requiredAction);
        if (validLocalPoint(recoveredPoint) && options.hardRefresh !== true) {
          dispatchCachedLocalPoint(recoveredPoint);
          traceLocationRequired(requiredAction, 'ready');
          return recoveredPoint;
        }
      }
      if (shouldSkipLocationServicesNativeCall('requestLocationBurst')) {
        const recoveredPoint = await waitForLocationRequiredOutcome(requiredAction, 1000);
        if (validLocalPoint(recoveredPoint) && options.hardRefresh !== true) {
          dispatchCachedLocalPoint(recoveredPoint);
          traceLocationRequired(requiredAction, 'ready');
          return recoveredPoint;
        }
        if (!locationBlockedFinalActive && locationServiceState !== 'disabled') {
          traceLocationRequired(requiredAction, 'blocked');
        }
        setStatus('GPS sucht noch - bitte Standort aktivieren oder kurz warten');
        return null;
      }
      await ensureSettingsLoadedOnce();
      await ensureDeviceKey();
      const Geolocation = plugins().Geolocation;
      if (!Geolocation || !(await ensureLocalGpsPermission(promptReason, promptOptions))) {
        setStatus(locationBlockedWithoutUsablePoint() ? 'GPS sucht noch - bitte Standort aktivieren oder kurz warten' : 'Standortberechtigung fehlt');
        return null;
      }
      // Sehr harter Refresh (Lang-Druck): Glaettungs-/Filterzustand zuruecksetzen,
      // damit ein gestoerter/gecachter Fix nicht den neuen Fix verzerrt -> frische
      // rohe, gefilterte GPS-Daten wie nach einem Neustart.
      resetFilterStates();
      const firstFix = !!options.firstFix || !getLastLocalPoint();
      if (!options.hardRefresh && !firstFix) {
        const watchPoint = getFreshWatchLocalPoint(LOCAL_GPS_WATCH_POLL_SKIP_MS);
        if (watchPoint) {
          dispatchCachedLocalPoint(watchPoint);
          if (serverUploadEnabled && !localOnly) {
            tickServerUpload(true).catch(function () {});
          }
          return watchPoint;
        }
      }
      const sampleCount = Math.max(3, Math.min(firstFix ? 20 : 15, Math.round(num(options.samples) || (firstFix ? 20 : 12))));
      const deadline = Date.now() + Math.max(1200, Math.min(firstFix ? 15000 : 6000, Math.round(num(options.maxMs) || (firstFix ? 14000 : 3600))));
      let bestPoint = null;
      for (let i = 0; i < sampleCount && Date.now() < deadline; i += 1) {
        if (shouldSkipLocationServicesNativeCall('requestLocationBurstSample')) break;
        try {
          const position = await getCurrentPositionWithReason('requestLocationBurst', {
            enableHighAccuracy: true,
            timeout: Math.min(5000, Math.max(1200, deadline - Date.now())),
            maximumAge: i === 0 ? 0 : 350
          }, {
            openSettings: promptOptions.prompt,
            promptReason: promptReason,
            explicitAction: promptOptions.explicitAction,
            requiredAction: requiredAction
          });
          const raw = pointFromNative(position);
          const finalPoint = raw && pointAllowedAfterBlockedFinal(raw)
            ? stabilizeDisplayPoint(Object.assign({}, raw), { firstFix: firstFix })
            : null;
          bestPoint = betterBurstPoint(finalPoint, bestPoint);
        } catch (error) {
          if (isLocationServicesDisabledError(error) || locationBlockedWithoutUsablePoint()) {
            if (!locationBlockedFinalActive && locationServiceState !== 'disabled') {
              traceLocationRequired(requiredAction, 'blocked');
            }
            break;
          }
        }
        if (i < sampleCount - 1 && Date.now() < deadline) await waitMs(180);
      }
      if (bestPoint) {
        bestPoint = await publishDisplayPoint(bestPoint, requestTracking);
        if (serverUploadEnabled && !localOnly) {
          tickServerUpload(true).catch(function () {});
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
    if (deviceKey) return deviceKey;
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

  async function ensureLocationPermissions(reason, options) {
    const Geolocation = plugins().Geolocation;
    if (!Geolocation) return false;
    if (locationBlockedWithoutUsablePoint()) {
      const prompted = await requestLocationServiceActivationOnce(reason || 'ensureLocationPermissions', options || { prompt: true, logSkip: true });
      if (!prompted) {
        shouldSkipLocationServicesNativeCall('ensureLocationPermissions');
        return false;
      }
      return !!localGpsPermissionReady;
    }
    return requestLocationServiceActivationOnce(reason || 'ensureLocationPermissions', options || { prompt: true });
  }

  function ensureLocalGpsPermission(reason, options) {
    options = options || { prompt: true };
    if (localGpsPermissionReady && !locationBlockedWithoutUsablePoint()) return Promise.resolve(true);
    if (locationBlockedWithoutUsablePoint() && options.prompt === false) {
      shouldSkipLocationServicesNativeCall('ensureLocalGpsPermission');
      return Promise.resolve(false);
    }
    if (localGpsPermissionPromise) return localGpsPermissionPromise;
    localGpsPermissionPromise = ensureLocationPermissions(reason || 'ensureLocalGpsPermission', options).finally(function () {
      localGpsPermissionPromise = null;
    });
    return localGpsPermissionPromise;
  }

  async function registerInitialPoint(options) {
    options = options || {};
    const allowPrompt = options.promptLocationServices !== false;
    await ensureDeviceKey();
    announceLocalDevice();
    let point = getAnyLocalPoint();
    if (validLocalPoint(point)) {
      dispatchCachedLocalPoint(point);
      setStatus('Geraet registriert - ' + deviceKey);
      return true;
    }
    if (shouldSkipLocationServicesNativeCall('registerInitialPoint')) {
      setStatus('GPS sucht noch - bitte Standort aktivieren oder kurz warten');
      return false;
    }
    const granted = await ensureLocalGpsPermission('startup', { prompt: allowPrompt, logSkip: true });
    if (!granted) {
      setStatus(locationBlockedWithoutUsablePoint() ? 'GPS sucht noch - bitte Standort aktivieren oder kurz warten' : 'Standortberechtigung fehlt');
      return false;
    }
    startLocalGpsWatch();
    point = await waitForFreshWatchPoint(1800);
    if (validLocalPoint(point)) {
      dispatchCachedLocalPoint(point);
      setStatus('Geraet registriert - ' + deviceKey);
      return true;
    }
    try {
      point = await requestLocationNow({
        tracking: false,
        localOnly: true,
        firstFix: true,
        promptReason: 'startup',
        promptLocationServices: allowPrompt
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

  async function setNativeUploadPaused(paused, reason) {
    if (usesNativePersistentUpload()) paused = false;
    const targetPaused = !!paused;
    const nativeUpload = nativeUploadPlugin();
    if (!nativeUpload || typeof nativeUpload.setPaused !== 'function') return;
    const traceReason = nativeUploadReason(reason, /setNativeUploadPaused|syncNativeUploadPauseForLifecycle/);
    if (nativeUploadStarted === false) {
      nativeUploadTrace('setPaused', 'skip', traceReason, ['paused=' + targetPaused]);
      return false;
    }
    if (nativeUploadPaused === targetPaused) {
      nativeUploadTrace('setPaused', 'skip', traceReason, ['paused=' + targetPaused]);
      return true;
    }
    if (nativeUploadPauseInFlight) {
      if (nativeUploadPauseInFlightValue === targetPaused) {
        nativeUploadTrace('setPaused', 'inFlight', traceReason, ['paused=' + targetPaused]);
        return nativeUploadPauseInFlight;
      }
      nativeUploadTrace('setPaused', 'inFlight', traceReason, ['paused=' + targetPaused, 'pending=' + nativeUploadPauseInFlightValue]);
      return nativeUploadPauseInFlight.catch(function () {
        return false;
      }).then(function () {
        return setNativeUploadPaused(targetPaused, traceReason);
      });
    }
    nativeUploadTrace('setPaused', 'native', traceReason, ['paused=' + targetPaused]);
    nativeUploadPauseInFlightValue = targetPaused;
    nativeUploadPauseInFlight = Promise.resolve(nativeUpload.setPaused({ paused: targetPaused })).then(function () {
      nativeUploadPaused = targetPaused;
      lastPauseValue = targetPaused;
      return true;
    }).catch(function () {
      return false;
    }).finally(function () {
      nativeUploadPauseInFlight = null;
      nativeUploadPauseInFlightValue = null;
    });
    return nativeUploadPauseInFlight;
  }

  function syncNativeUploadPauseForLifecycle() {
    if (!usesNativePersistentUpload()) return;
    return setNativeUploadPaused(false, 'lifecycle');
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
    localWatchStartGeneration += 1;
    localWatchStartPromise = null;
    localWatchStartedAtMs = 0;
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
    if (shouldSkipLocationServicesNativeCall('pollLocalGpsOnce')) return;
    const Geolocation = plugins().Geolocation;
    if (!Geolocation) return;
    if (localGpsPollInFlight) return;
    if (requestLocationInFlight || locationBurstInFlight) return;
    const now = Date.now();
    if (lastLocalGpsSuccessfulFixMs && now - lastLocalGpsSuccessfulFixMs < LOCAL_GPS_POLL_SUCCESS_SUPPRESS_MS) return;
    const watchActiveOrStarting = localWatchId != null || !!localWatchStartPromise;
    if (watchActiveOrStarting) {
      const lastWatchOrStartMs = lastLocalGpsSuccessfulFixMs || lastLocalGpsWatchFixMs || localWatchStartedAtMs;
      if (lastWatchOrStartMs && now - lastWatchOrStartMs < LOCAL_GPS_POLL_SUCCESS_SUPPRESS_MS) return;
    }
    localGpsPollInFlight = true;
    getCurrentPositionWithReason('pollLocalGpsOnce', {
      enableHighAccuracy: true,
      timeout: LOCAL_GPS_POLL_TIMEOUT_MS,
      maximumAge: LOCAL_GPS_POLL_MAX_AGE_MS
    }).then(function (position) {
      return publishLocalPoint(position);
    }).catch(function () {}).finally(function () {
      localGpsPollInFlight = false;
    });
  }

  function startLocalGpsPoll() {
    if (document.hidden) return;
    if (shouldSkipLocationServicesNativeCall('startLocalGpsPoll')) {
      stopLocalGpsPoll();
      return;
    }
    stopLocalGpsPoll();
    if (localWatchId == null && !localWatchStartPromise) pollLocalGpsOnce();
    localPollTimer = setInterval(pollLocalGpsOnce, LOCAL_GPS_POLL_INTERVAL_MS);
  }

  function startLocalGpsWatch() {
    if (document.hidden) return;
    if (shouldSkipLocationServicesNativeCall('startLocalGpsWatch')) return;
    if (localWatchId != null) return;
    if (localWatchStartPromise) return localWatchStartPromise;
    const Geolocation = plugins().Geolocation;
    if (!Geolocation || typeof Geolocation.watchPosition !== 'function') return;
    const startGeneration = localWatchStartGeneration;
    const watchStartedAtMs = Date.now();
    localWatchStartedAtMs = watchStartedAtMs;
    localWatchStartPromise = Promise.resolve(Geolocation.watchPosition({
      enableHighAccuracy: true,
      timeout: 8000,
      maximumAge: LOCAL_GPS_POLL_MAX_AGE_MS,
      minimumUpdateInterval: LOCAL_GPS_POLL_INTERVAL_MS
    }, function (position, error) {
      if (startGeneration !== localWatchStartGeneration) return;
      if (error) {
        if (locationLastAvailableAtMs && watchStartedAtMs < locationLastAvailableAtMs) return;
        if (locationBlockedFinalActive && locationBlockedFinalAtMs && watchStartedAtMs < locationBlockedFinalAtMs) return;
        markLocationServicesBlocked(error);
        return;
      }
      if (!position) return;
      const raw = pointFromNative(position);
      if (!raw || !pointAllowedAfterBlockedFinal(raw)) return;
      clearLocationServicesBlocked();
      lastLocalGpsWatchFixMs = Date.now();
      publishLocalPoint(position).then(function (point) {
        if (point) lastLocalGpsWatchPoint = Object.assign({}, point);
      }).catch(function () {});
    })).then(function (watchId) {
      if (startGeneration !== localWatchStartGeneration || document.hidden) {
        if (Geolocation && watchId != null && typeof Geolocation.clearWatch === 'function') {
          Promise.resolve(Geolocation.clearWatch({ id: watchId })).catch(function () {});
        }
        return null;
      }
      localWatchId = watchId;
      localWatchStartedAtMs = localWatchStartedAtMs || Date.now();
      return watchId;
    }).catch(function (error) {
      markLocationServicesBlocked(error);
    }).finally(function () {
      if (startGeneration === localWatchStartGeneration) localWatchStartPromise = null;
    });
    return localWatchStartPromise;
  }

  function startLocalGpsMonitoring() {
    if (document.hidden) return;
    if (shouldSkipLocationServicesNativeCall('startLocalGpsMonitoring')) return;
    startCompassHeadingWatch();
    ensureLocalGpsPermission('startLocalGpsMonitoring', { prompt: false }).then(function (granted) {
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

  function handleLocationRequiredResume() {
    syncPointLoopWithVisibility();
    if (!document.hidden && locationRequiredActionPending) {
      scheduleLocationRequiredRecheck(locationRequiredActionPending);
    }
  }

  function setupAppLifecycleHandlers() {
    if (appLifecycleHandlersBound) return;
    appLifecycleHandlersBound = true;
    document.addEventListener('pause', syncPointLoopWithVisibility);
    document.addEventListener('resume', handleLocationRequiredResume);
  }

  function setupAppVisibilityHandlers() {
    if (visibilityHandlersBound) return;
    visibilityHandlersBound = true;
    document.addEventListener('visibilitychange', handleLocationRequiredResume);
    setupAppLifecycleHandlers();
    syncPointLoopWithVisibility();
  }

  function startServerPointLoop() {
    stopPointLoop();
    if (!serverConnectAllowed()) return;
    if (!serverUploadEnabled || !hasConfiguredMqttTarget() || document.hidden || (persistentUploadActive && backgroundUploadEnabled)) return;
    pointLoopTimer = setInterval(function () {
      if (sendInFlight || !serverUploadEnabled) return;
      sendInFlight = true;
      tickServerUpload(false).catch(function () {}).finally(function () {
        sendInFlight = false;
      });
    }, Math.max(200, Math.min(LOOP_TICK_MS, uploadSettings.movingSec * 500)));
  }

  function startPointLoop() {
    startServerPointLoop();
  }

  function serverConnectAllowed() {
    return !global.MOBILE_LOCAL_ASSETS || global.__mobileServerAvailable === true;
  }

  function connectServerTransportsIfAvailable() {
    if (!serverUploadEnabled || !serverConnectAllowed()) return;
    if (!document.hidden) startServerPointLoop();
    ensureMqttClient().then(function (client) {
      if (client && client.connected) {
        sendLastLocalPointIfAvailable().catch(function () {});
        flushQueue().catch(function () {});
      }
    }).catch(function () {});
  }

  function serverBaseUrl() {
    const configured = serverBaseUrlFromConfig(activeServerConfig());
    if (configured) return configured;
    const fallback = serverConfigFromStored({ legacyServerUrl: DEFAULT_SERVER_BASE_URL });
    const fallbackUrl = serverBaseUrlFromConfig(fallback);
    if (fallbackUrl) return fallbackUrl;
    const origin = global.location && /^https?:$/.test(global.location.protocol || '') && global.location.origin
      ? String(global.location.origin)
      : '';
    return origin.replace(/\/$/, '');
  }

  function nativeUploadPlugin() {
    return plugins().NativeGpsUpload || null;
  }

  async function checkServerAvailability() {
    if (serverAvailabilityCheckInFlight) return false;
    const baseUrl = serverBaseUrl();
    function publishAvailability(available, detail) {
      global.__mobileServerAvailable = !!available;
      try {
        global.dispatchEvent(new CustomEvent('mobile-server-availability', {
          detail: { available: !!available, serverBaseUrl: baseUrl || '', message: detail || '' }
        }));
      } catch (error) {}
    }
    if (!baseUrl) {
      publishAvailability(false, 'no serverBaseUrl');
      mobileStartupLog('server unavailable', 'no serverBaseUrl');
      return false;
    }
    if (!(await isOnline().catch(function () { return false; }))) {
      publishAvailability(false, 'offline');
      mobileStartupLog('server unavailable', 'offline');
      return false;
    }
    serverAvailabilityCheckInFlight = true;
    let timeoutId = null;
    try {
      const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
      if (controller) {
        timeoutId = setTimeout(function () {
          try { controller.abort(); } catch (error) {}
        }, 6000);
      }
      const response = await global.fetch(baseUrl + '/mobile/api/bootstrap?deviceKey=' + encodeURIComponent(deviceKey || ''), {
        cache: 'no-store',
        signal: controller ? controller.signal : undefined
      });
      if (response && response.ok) {
        publishAvailability(true, 'connected');
        mobileStartupLog('server connected', baseUrl);
        return true;
      }
      publishAvailability(false, 'HTTP ' + (response ? response.status : 0));
      mobileStartupLog('server unavailable', baseUrl + ' HTTP ' + (response ? response.status : 0));
      serverFallbackLog('server unavailable', baseUrl);
      return false;
    } catch (error) {
      publishAvailability(false, error && error.message ? error.message : 'unknown');
      mobileStartupLog('server unavailable', baseUrl);
      serverFallbackLog('server unavailable', error && error.message ? error.message : String(error || 'unknown'));
      return false;
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
      serverAvailabilityCheckInFlight = false;
    }
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
      driveEnterSpeedKmh: displaySettings.driveEnterSpeedKmh,
      driveExitSpeedKmh: displaySettings.driveExitSpeedKmh,
      driveConfirmFixes: displaySettings.driveConfirmFixes,
      driveExitHoldMs: displaySettings.driveExitHoldMs,
      driveMinMoveM: displaySettings.driveMinMoveM,
      paused: false,
      serverUploadEnabled: nativeServerUploadEnabled()
    };
  }

  function nativeUploadTrace(action, source, reason, fields) {
    const traceFields = [
      'action=' + String(action || ''),
      'source=' + String(source || ''),
      'reason=' + String(reason || 'unknown')
    ];
    if (Array.isArray(fields)) {
      for (let i = 0; i < fields.length; i += 1) {
        if (fields[i]) traceFields.push(fields[i]);
      }
    }
    perfTraceLog('NativeUpload', traceFields,
      'native-upload:' + String(action || '') + ':' + String(source || '') + ':' + String(reason || 'unknown'),
      PERF_TRACE_THROTTLE_MS);
  }

  function nativeUploadReason(reason, skipPattern) {
    return String(reason || perfTraceStackLabel(skipPattern || /nativeUpload|NativeUpload/) || 'unknown');
  }

  function nativeUploadConfigKey(payload) {
    try {
      const keys = Object.keys(payload || {}).sort();
      return JSON.stringify(payload || {}, keys);
    } catch (error) {
      return String(Date.now());
    }
  }

  async function startNativeUploadService(payload, reason) {
    const nativeUpload = nativeUploadPlugin();
    if (!nativeUpload) return false;
    const startMethod = typeof nativeUpload.start === 'function'
      ? 'start'
      : (typeof nativeUpload.updateConfig === 'function' ? 'updateConfig' : '');
    if (!startMethod) return false;
    const traceReason = nativeUploadReason(reason, /startNativeUploadService|syncNativePersistentUpload/);
    if (locationBlockedWithoutUsablePoint()) {
      nativeUploadTrace('start', 'skip', 'location-disabled');
      return false;
    }
    const configKey = nativeUploadConfigKey(payload);
    if (nativeUploadStarted === true && lastStartConfigKey === configKey) {
      nativeUploadTrace('start', 'skip', traceReason);
      return true;
    }
    if (nativeUploadStartInFlight) {
      if (nativeUploadStartInFlightKey === configKey) {
        nativeUploadTrace('start', 'inFlight', traceReason);
        return nativeUploadStartInFlight;
      }
      nativeUploadTrace('start', 'inFlight', traceReason, ['config=changed']);
      return nativeUploadStartInFlight.catch(function () {
        return false;
      }).then(function () {
        return startNativeUploadService(payload, traceReason);
      });
    }
    nativeUploadTrace('start', 'native', traceReason);
    nativeUploadStartInFlightKey = configKey;
    nativeUploadStartInFlight = Promise.resolve(nativeUpload[startMethod](payload)).then(function () {
      nativeUploadStarted = true;
      lastStartConfigKey = configKey;
      nativeUploadPaused = !!(payload && payload.paused);
      lastPauseValue = nativeUploadPaused;
      return true;
    }).catch(function () {
      return false;
    }).finally(function () {
      nativeUploadStartInFlight = null;
      nativeUploadStartInFlightKey = '';
    });
    return nativeUploadStartInFlight;
  }

  async function stopNativeUploadService(reason) {
    const nativeUpload = nativeUploadPlugin();
    if (!nativeUpload || typeof nativeUpload.stop !== 'function') return false;
    const traceReason = nativeUploadReason(reason, /stopNativeUploadService|stopNativePersistentUpload/);
    if (nativeUploadStopInFlight) {
      nativeUploadTrace('stop', 'inFlight', traceReason);
      return nativeUploadStopInFlight;
    }
    if (nativeUploadStarted === false && !nativeUploadStartInFlight) {
      nativeUploadTrace('stop', 'skip', traceReason);
      return false;
    }
    nativeUploadTrace('stop', 'native', traceReason);
    nativeUploadStopInFlight = Promise.resolve(nativeUploadStartInFlight).catch(function () {
      return false;
    }).then(function () {
      return nativeUpload.stop();
    }).then(function () {
      nativeUploadStarted = false;
      lastStartConfigKey = '';
      nativeUploadPaused = null;
      lastPauseValue = null;
      return true;
    }).catch(function () {
      return false;
    }).finally(function () {
      nativeUploadStopInFlight = null;
    });
    return nativeUploadStopInFlight;
  }

  async function syncNativeUploadPause() {
    return syncNativeUploadPauseForLifecycle();
  }

  async function syncNativePersistentUpload() {
    const payload = nativeUploadConfig();
    payload.enabled = true;
    return startNativeUploadService(payload, 'syncNativePersistentUpload');
  }

  async function stopNativePersistentUpload() {
    persistentUploadActive = false;
    await stopNativeUploadService('stopNativePersistentUpload');
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
    if ((trackingActive || nativeServerUploadEnabled()) && locationBlockedWithoutUsablePoint()) {
      await stopNativePersistentUpload();
      syncPointLoopWithVisibility();
      setStatus('GPS sucht noch - bitte Standort aktivieren oder kurz warten');
      return false;
    }
    const started = await startPersistentLocationUpload();
    await setNativeUploadPaused(false, 'applyBackgroundUploadMode');
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
      if (!validLocalPoint(getUsableLocalPoint(LOCATION_USABLE_CACHED_POINT_MS)) &&
          (locationBlockedWithoutUsablePoint() || locationServiceState === 'disabled' || !localGpsPermissionReady)) {
        await promptLocationRequiredAction('serverUpload', { prompt: true, logSkip: true, explicitAction: true });
        if (locationBlockedWithoutUsablePoint() || locationServiceState === 'disabled' || locationServiceState === 'prompting') {
          await disableServerUploadForLocationRequired('serverUpload');
          await applyBackgroundUploadMode();
          syncPointLoopWithVisibility();
          setStatus('GPS sucht noch - bitte Standort aktivieren oder kurz warten');
          traceLocationRequired('serverUpload', 'blocked');
          return false;
        }
      }
      if (!serverConnectAllowed()) {
        setStatus('Server wird im Hintergrund gesucht - Queue bleibt lokal');
        dispatchTransportState({ connected: false, connecting: true, serverConfigured: true });
        checkServerAvailability().then(function (available) {
          if (available) connectServerTransportsIfAvailable();
          else dispatchTransportState({ connected: false, connecting: false });
        }).catch(function () {
          dispatchTransportState({ connected: false, connecting: false });
        });
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
    if (!serverUploadEnabled && locationRequiredActionPending === 'serverUpload') {
      locationRequiredActionPending = '';
      cancelLocationRequiredRecheck();
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
          publishLocalPoint(location, trackingActive).then(function () {
            if (!serverUploadEnabled || !backgroundUploadEnabled) return null;
            return tickServerUpload(false);
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
    let trackingStartPreflightPosition = null;
    if (active && !wasTrackingActive && !validLocalPoint(getUsableLocalPoint(LOCATION_USABLE_CACHED_POINT_MS))) {
      const Geolocation = plugins().Geolocation;
      if (!Geolocation) {
        traceLocationRequired('trackingStart', 'blocked');
        setStatus('Standortberechtigung fehlt');
        return false;
      }
      if (locationBlockedWithoutUsablePoint() || locationServiceState === 'disabled' || locationServiceState === 'prompting') {
        await promptLocationRequiredAction('trackingStart', { prompt: true, logSkip: true, explicitAction: true });
        setStatus('GPS sucht noch - bitte Standort aktivieren oder kurz warten');
        return false;
      }
      try {
        trackingStartPreflightPosition = await getCurrentPositionWithReason('setTrackingActivePreflight', {
          enableHighAccuracy: true,
          timeout: 15000,
          maximumAge: 1000
        }, {
          openSettings: true,
          promptReason: 'trackingStart',
          explicitAction: true,
          requiredAction: 'trackingStart'
        });
        const preflightRaw = pointFromNative(trackingStartPreflightPosition);
        if (!preflightRaw || !pointAllowedAfterBlockedFinal(preflightRaw)) {
          traceLocationRequired('trackingStart', 'blocked');
          setStatus('GPS sucht noch - bitte Standort aktivieren oder kurz warten');
          return false;
        }
        traceLocationRequired('trackingStart', 'ready');
      } catch (error) {
        if (isLocationServicesDisabledError(error) || locationBlockedWithoutUsablePoint()) {
          await promptLocationRequiredAction('trackingStart', { prompt: true, logSkip: true, explicitAction: true });
        }
        setStatus('GPS sucht noch - bitte Standort aktivieren oder kurz warten');
        traceLocationRequired('trackingStart', 'blocked');
        return false;
      }
    }
    trackingActive = !!active;
    try {
      localStorage.setItem(TRACKING_ACTIVE_STORAGE_KEY, trackingActive ? '1' : '0');
      if (!trackingActive) localStorage.setItem(TRACKING_STOPPED_AT_STORAGE_KEY, String(Date.now()));
      else localStorage.removeItem(TRACKING_STOPPED_AT_STORAGE_KEY);
    } catch (error) {}
    dispatchTrackingState(trackingActive ? 'tracking-start' : 'tracking-stop');
    if (trackingActive && !wasTrackingActive) {
      invalidateBufferedRouteCache();
      ensureTrackId(true);
      beginNewRouteSegment();
    } else if (!trackingActive && wasTrackingActive) {
      invalidateBufferedRouteCache();
      setRouteBreakPending(true);
      await flushUploadQueue(true);
    }
    await applyBackgroundUploadMode();
    if (trackingActive) {
      setStatus('Tracking aktiv');
      let trackingStartHasUsableLocation = false;
      const watchPoint = getFreshWatchLocalPoint(LOCAL_GPS_WATCH_POLL_FALLBACK_MS);
      if (validLocalPoint(watchPoint) && pointAllowedAfterBlockedFinal(watchPoint)) {
        try {
          const point = await publishDisplayPoint(watchPoint, true);
          trackingStartHasUsableLocation = !!point;
          if (point && serverUploadEnabled) tickServerUpload(true).catch(function () {});
        } catch (error) {}
      } else if (trackingStartPreflightPosition) {
        try {
          const displayPoint = await ingestGpsUpdate(trackingStartPreflightPosition, true);
          trackingStartHasUsableLocation = !!displayPoint;
        } catch (error) {}
      } else {
        const Geolocation = plugins().Geolocation;
        if (Geolocation && (!localGpsPermissionReady || locationBlockedWithoutUsablePoint())) {
          await promptLocationRequiredAction('trackingStart', { prompt: true, logSkip: true, explicitAction: true });
        }
        if (Geolocation && !shouldSkipLocationServicesNativeCall('setTrackingActive')) {
          try {
            const pos = await getCurrentPositionWithReason('setTrackingActive', { enableHighAccuracy: true, timeout: 15000, maximumAge: 1000 }, {
              openSettings: true,
              promptReason: 'trackingStart',
              explicitAction: true,
              requiredAction: 'trackingStart'
            });
            const raw = pointFromNative(pos);
            if (raw && pointAllowedAfterBlockedFinal(raw)) {
              const displayPoint = await ingestGpsUpdate(pos, true);
              trackingStartHasUsableLocation = !!displayPoint;
              if (displayPoint && serverUploadEnabled) tickServerUpload(true).catch(function () {});
            }
          } catch (error) {
            markLocationServicesBlocked(error, null, { requiredAction: 'trackingStart' });
          }
        }
      }
      if (!wasTrackingActive && !trackingStartHasUsableLocation &&
          (locationBlockedWithoutUsablePoint() || locationServiceState === 'disabled')) {
        await finalizeLocationRequiredBlocked('trackingStart', 'blocked-final');
        return false;
      }
    } else {
      setStatus('Live-Punkte aktiv — Tracking aus');
    }
    publishTrackingStatus().catch(function () {});
    return true;
  }

  function lonLatToTile(lon, lat, zoom) {
    const n = Math.pow(2, zoom);
    const x = Math.floor((lon + 180) / 360 * n);
    const latRad = lat * Math.PI / 180;
    const y = Math.floor((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * n);
    return { x: x, y: y };
  }

  function clampTileCoord(value, zoom) {
    const max = Math.pow(2, zoom) - 1;
    if (value < 0) return 0;
    if (value > max) return max;
    return value;
  }

  function tileBoundsForCoord(tile) {
    const n = Math.pow(2, tile.z);
    const west = tile.x / n * 360 - 180;
    const east = (tile.x + 1) / n * 360 - 180;
    const northRad = Math.atan(Math.sinh(Math.PI * (1 - 2 * tile.y / n)));
    const southRad = Math.atan(Math.sinh(Math.PI * (1 - 2 * (tile.y + 1) / n)));
    return {
      north: northRad * 180 / Math.PI,
      south: southRad * 180 / Math.PI,
      east: east,
      west: west
    };
  }

  function tileCenterForCoord(tile) {
    const b = tileBoundsForCoord(tile);
    return { lat: (b.north + b.south) / 2, lon: (b.east + b.west) / 2, bounds: b };
  }

  function routeCorridorBounds(routeCoords, corridorMeters) {
    const coords = normalizeRouteCoords(routeCoords);
    if (!coords.length) return null;
    let north = -90, south = 90, east = -180, west = 180;
    for (let i = 0; i < coords.length; i += 1) {
      north = Math.max(north, coords[i].lat);
      south = Math.min(south, coords[i].lat);
      east = Math.max(east, coords[i].lon);
      west = Math.min(west, coords[i].lon);
    }
    const midLat = (north + south) / 2;
    const latPad = Math.max(0.002, (Math.max(0, corridorMeters || 0) / 111320));
    const lonPad = Math.max(0.002, latPad / Math.max(0.2, Math.cos(midLat * Math.PI / 180)));
    return { north: Math.min(85, north + latPad), south: Math.max(-85, south - latPad), east: Math.min(180, east + lonPad), west: Math.max(-180, west - lonPad) };
  }

  function normalizeRouteCoords(routeCoords) {
    return (Array.isArray(routeCoords) ? routeCoords : []).map(function (coord) {
      if (Array.isArray(coord) && coord.length >= 2) return { lat: Number(coord[0]), lon: Number(coord[1]) };
      if (coord && typeof coord === 'object') return { lat: Number(coord.lat), lon: Number(coord.lon != null ? coord.lon : coord.lng) };
      return null;
    }).filter(function (coord) {
      return coord && Number.isFinite(coord.lat) && Number.isFinite(coord.lon);
    });
  }

  function pointSegmentDistanceMeters(point, a, b) {
    const latRef = point.lat * Math.PI / 180;
    const metersPerDegLat = 111320;
    const metersPerDegLon = Math.max(1, 111320 * Math.cos(latRef));
    const px = point.lon * metersPerDegLon;
    const py = point.lat * metersPerDegLat;
    const ax = a.lon * metersPerDegLon;
    const ay = a.lat * metersPerDegLat;
    const bx = b.lon * metersPerDegLon;
    const by = b.lat * metersPerDegLat;
    const dx = bx - ax;
    const dy = by - ay;
    const lengthSq = dx * dx + dy * dy;
    let t = lengthSq > 0 ? (((px - ax) * dx + (py - ay) * dy) / lengthSq) : 0;
    t = Math.max(0, Math.min(1, t));
    const qx = ax + t * dx;
    const qy = ay + t * dy;
    const ex = px - qx;
    const ey = py - qy;
    return Math.sqrt(ex * ex + ey * ey);
  }

  function buildRouteCorridorTileFilter(routeCoords, corridorMeters) {
    const coords = normalizeRouteCoords(routeCoords);
    const buffer = Math.max(250, Number(corridorMeters) || 2000);
    if (coords.length < 2) return null;
    return function (tile) {
      const center = tileCenterForCoord(tile);
      const b = center.bounds;
      const latSpanMeters = Math.abs(b.north - b.south) * 111320;
      const lonSpanMeters = Math.abs(b.east - b.west) * 111320 * Math.max(0.2, Math.cos(center.lat * Math.PI / 180));
      const tileRadiusMeters = Math.sqrt(latSpanMeters * latSpanMeters + lonSpanMeters * lonSpanMeters) / 2;
      const threshold = buffer + tileRadiusMeters;
      for (let i = 0; i < coords.length - 1; i += 1) {
        if (pointSegmentDistanceMeters(center, coords[i], coords[i + 1]) <= threshold) return true;
      }
      return false;
    };
  }

  function enumerateTilesForBounds(bounds, zoomMin, zoomMax, tileFilter) {
    const tiles = [];
    for (let zoom = zoomMin; zoom <= zoomMax; zoom += 1) {
      const nw = lonLatToTile(bounds.west, bounds.north, zoom);
      const se = lonLatToTile(bounds.east, bounds.south, zoom);
      const xMin = clampTileCoord(Math.min(nw.x, se.x), zoom);
      const xMax = clampTileCoord(Math.max(nw.x, se.x), zoom);
      const yMin = clampTileCoord(Math.min(nw.y, se.y), zoom);
      const yMax = clampTileCoord(Math.max(nw.y, se.y), zoom);
      for (let x = xMin; x <= xMax; x += 1) {
        for (let y = yMin; y <= yMax; y += 1) {
          const tile = { z: zoom, x: x, y: y };
          if (!tileFilter || tileFilter(tile)) tiles.push(tile);
        }
      }
      if (tiles.length > OFFLINE_MAX_TILES_PER_REGION) break;
    }
    return tiles;
  }

  function estimateTileCount(bounds, zoomMin, zoomMax, tileFilter) {
    let count = 0;
    for (let zoom = zoomMin; zoom <= zoomMax; zoom += 1) {
      const nw = lonLatToTile(bounds.west, bounds.north, zoom);
      const se = lonLatToTile(bounds.east, bounds.south, zoom);
      const xMin = clampTileCoord(Math.min(nw.x, se.x), zoom);
      const xMax = clampTileCoord(Math.max(nw.x, se.x), zoom);
      const yMin = clampTileCoord(Math.min(nw.y, se.y), zoom);
      const yMax = clampTileCoord(Math.max(nw.y, se.y), zoom);
      if (!tileFilter) {
        count += Math.max(0, (xMax - xMin + 1)) * Math.max(0, (yMax - yMin + 1));
      } else {
        for (let x = xMin; x <= xMax; x += 1) {
          for (let y = yMin; y <= yMax; y += 1) {
            if (tileFilter({ z: zoom, x: x, y: y })) count += 1;
          }
        }
      }
      if (count > OFFLINE_MAX_TILES_PER_REGION) return count;
    }
    return count;
  }

  function fillTileTemplate(template, z, x, y) {
    return String(template)
      .replace('{z}', String(z))
      .replace('{x}', String(x))
      .replace('{y}', String(y))
      .replace('{ratio}', '');
  }

  function collectFontNamesFromStyle(style) {
    const found = new Set();
    const expressionOperators = {
      case: true,
      match: true,
      coalesce: true,
      get: true,
      has: true,
      literal: true,
      step: true,
      interpolate: true,
      concat: true,
      format: true,
      'to-string': true,
      'resolved-locale': true
    };
    const addFontStack = function (value) {
      const fonts = Array.isArray(value) ? value : [value];
      const cleaned = fonts
        .map(function (font) { return typeof font === 'string' ? font.trim() : ''; })
        .filter(Boolean);
      if (!cleaned.length) return;
      found.add(cleaned.join(','));
      for (let i = 0; i < cleaned.length; i += 1) found.add(cleaned[i]);
    };
    const visit = function (value) {
      if (typeof value === 'string') {
        addFontStack(value);
        return;
      }
      if (!value) return;
      if (Array.isArray(value)) {
        if (value.length >= 2 && value[0] === 'literal' && Array.isArray(value[1])) {
          addFontStack(value[1]);
          return;
        }
        const allStrings = value.length > 0 && value.every(function (item) { return typeof item === 'string'; });
        if (allStrings && !expressionOperators[String(value[0] || '')]) {
          addFontStack(value);
          return;
        }
        for (let i = 0; i < value.length; i += 1) {
          if (Array.isArray(value[i]) || value[i] && typeof value[i] === 'object') visit(value[i]);
        }
        return;
      }
      if (Array.isArray(value.stops)) {
        for (let i = 0; i < value.stops.length; i += 1) {
          const stop = value.stops[i];
          if (stop && Array.isArray(stop) && stop.length > 1) visit(stop[1]);
        }
      }
      if (value.default) visit(value.default);
    };
    const layers = style && Array.isArray(style.layers) ? style.layers : [];
    for (let i = 0; i < layers.length; i += 1) {
      const layout = layers[i] && layers[i].layout;
      const textFont = layout && layout['text-font'];
      visit(textFont);
    }
    return Array.from(found);
  }

  function collectUsedSourceInfoFromStyle(style) {
    const used = {};
    const hillshade = {};
    const layers = style && Array.isArray(style.layers) ? style.layers : [];
    for (let i = 0; i < layers.length; i += 1) {
      const layer = layers[i] || {};
      const sourceId = layer.source;
      if (!sourceId) continue;
      const layout = layer.layout || {};
      if (layout.visibility === 'none') continue;
      used[sourceId] = true;
      if (layer.type === 'hillshade') hillshade[sourceId] = true;
    }
    return { used: used, hillshade: hillshade };
  }

  function normalizeTileTemplateUrl(template, baseUrl) {
    if (typeof template !== 'string' || !template) return '';
    if (/^https?:\/\//i.test(template)) return template;
    try { return new URL(template, baseUrl).toString(); } catch (_) { return template; }
  }

  async function collectTileTemplatesFromStyle(style, styleUrl) {
    const sources = [];
    if (!style || typeof style.sources !== 'object' || !style.sources) return sources;
    const sourceInfo = collectUsedSourceInfoFromStyle(style);
    const sourceNames = Object.keys(style.sources);
    const hasUsedSourceFilter = Object.keys(sourceInfo.used).length > 0;
    for (let i = 0; i < sourceNames.length; i += 1) {
      const sourceId = sourceNames[i];
      const source = style.sources[sourceId];
      if (!source || source.type !== 'raster' && source.type !== 'vector' && source.type !== 'raster-dem') continue;
      if (hasUsedSourceFilter && !sourceInfo.used[sourceId]) continue;
      if (source.type === 'raster-dem' && !sourceInfo.hillshade[sourceId]) continue;

      let minzoom = Number.isFinite(Number(source.minzoom)) ? Number(source.minzoom) : 0;
      let maxzoom = Number.isFinite(Number(source.maxzoom)) ? Number(source.maxzoom) : 22;
      let templates = Array.isArray(source.tiles) ? source.tiles.slice() : [];
      const sourceTileJsonUrl = typeof source.url === 'string' ? normalizeTileTemplateUrl(source.url, styleUrl || '') : '';
      if (!templates.length && sourceTileJsonUrl) {
        try {
          const tileJsonResponse = await global.fetch(sourceTileJsonUrl);
          if (tileJsonResponse && tileJsonResponse.ok) {
            const tileJson = await tileJsonResponse.json();
            if (tileJson && Array.isArray(tileJson.tiles)) templates = tileJson.tiles.map(function (tileUrl) {
              return normalizeTileTemplateUrl(tileUrl, sourceTileJsonUrl);
            });
            if (tileJson && Number.isFinite(Number(tileJson.minzoom))) minzoom = Math.max(minzoom, Number(tileJson.minzoom));
            if (tileJson && Number.isFinite(Number(tileJson.maxzoom))) maxzoom = Math.min(maxzoom, Number(tileJson.maxzoom));
          }
        } catch (error) {}
      }
      templates = templates.map(function (template) { return normalizeTileTemplateUrl(template, sourceTileJsonUrl || styleUrl || ''); }).filter(Boolean);
      if (!templates.length) continue;
      sources.push({
        id: sourceId,
        type: source.type,
        tileJsonUrl: /^https?:\/\//i.test(sourceTileJsonUrl) ? sourceTileJsonUrl : '',
        templates: templates,
        minzoom: Math.max(0, Math.floor(minzoom)),
        maxzoom: Math.max(0, Math.floor(maxzoom))
      });
    }
    return sources;
  }

  async function runWithConcurrency(items, concurrency, worker) {
    const results = new Array(items.length);
    let cursor = 0;
    const workers = [];
    const workerCount = Math.max(1, Math.min(concurrency || 1, items.length));
    for (let i = 0; i < workerCount; i += 1) {
      workers.push((async function () {
        while (true) {
          const index = cursor;
          cursor += 1;
          if (index >= items.length) return;
          try { results[index] = await worker(items[index], index); }
          catch (error) { results[index] = error; }
        }
      })());
    }
    await Promise.all(workers);
    return results;
  }

  function generateRegionId() {
    return 'rgn_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
  }

  async function buildOfflineRegionDownloadPlan(opts, styleConfig, requestedBounds, zoomMin, zoomMax) {
    const styleUrl = resolveMapStyleUrl(styleConfig.mapId);
    const urlEntries = [];
    const seenCanonical = new Set();
    const pushUrl = function (rawUrl, kind, required, extra) {
      if (!rawUrl) return false;
      const canonical = offlineCanonicalUrl(rawUrl);
      if (seenCanonical.has(canonical)) return false;
      seenCanonical.add(canonical);
      urlEntries.push(Object.assign({ url: rawUrl, kind: kind || 'resource', required: !!required }, extra || {}));
      return true;
    };
    pushUrl(styleUrl, 'style', true);
    pushUrl(OFFLINE_RTL_TEXT_PLUGIN_URL, 'script', true);

    const styleResponse = await global.fetch(styleUrl);
    if (!styleResponse || !styleResponse.ok) throw new Error('Stil-Datei konnte nicht geladen werden (HTTP ' + (styleResponse && styleResponse.status) + ')');
    const styleJson = await styleResponse.json();

    const spriteBase = typeof styleJson.sprite === 'string' ? styleJson.sprite : null;
    if (spriteBase) {
      pushUrl(spriteBase + '.json', 'sprite', false);
      pushUrl(spriteBase + '.png', 'sprite', false);
      pushUrl(spriteBase + '@2x.json', 'sprite', false);
      pushUrl(spriteBase + '@2x.png', 'sprite', false);
    }
    const glyphTemplate = typeof styleJson.glyphs === 'string' ? styleJson.glyphs : null;
    const glyphFonts = glyphTemplate ? collectFontNamesFromStyle(styleJson) : [];
    if (glyphTemplate && glyphFonts.length) {
      for (let i = 0; i < glyphFonts.length; i += 1) {
        for (let j = 0; j < OFFLINE_GLYPH_RANGES.length; j += 1) {
          const start = OFFLINE_GLYPH_RANGES[j];
          const glyphUrl = glyphTemplate
            .replace('{fontstack}', offlineEncodeGlyphFontstack(glyphFonts[i]))
            .replace('{range}', start + '-' + (start + 255));
          const unsupportedGlyph = offlineIsUnsupportedGlyphRangeUrl(glyphUrl);
          pushUrl(glyphUrl, 'glyph', !unsupportedGlyph, unsupportedGlyph ? { unsupportedTolerant: true } : null);
        }
      }
    }
    const tileSources = await collectTileTemplatesFromStyle(styleJson, styleUrl);
    if (!tileSources.length) throw new Error('Keine Tile-URLs im Stil gefunden');
    const tileFilter = opts && opts.routeCoords ? buildRouteCorridorTileFilter(opts.routeCoords, opts.corridorMeters) : null;
    let tileTotal = 0;
    for (let i = 0; i < tileSources.length; i += 1) {
      const source = tileSources[i];
      if (source.tileJsonUrl) pushUrl(source.tileJsonUrl, 'tilejson', true);
      const sourceZoomMin = Math.max(zoomMin, source.minzoom);
      const sourceZoomMax = Math.min(zoomMax, source.maxzoom);
      if (sourceZoomMax < sourceZoomMin) continue;
      const tileCoords = enumerateTilesForBounds(requestedBounds, sourceZoomMin, sourceZoomMax, tileFilter);
      for (let t = 0; t < source.templates.length; t += 1) {
        for (let j = 0; j < tileCoords.length; j += 1) {
          const tile = fillTileTemplate(source.templates[t], tileCoords[j].z, tileCoords[j].x, tileCoords[j].y);
          if (pushUrl(tile, 'tile', false)) tileTotal += 1;
        }
      }
    }
    if (tileTotal <= 0) throw new Error('Keine Tiles im verfuegbaren Zoom-Bereich dieses Stils');
    return { urls: urlEntries, styleJson: styleJson, tileTotal: tileTotal };
  }

  function summarizeOfflineDownloadPlan(plan, zoomMin, zoomMax, styleConfig, requestedBounds, profile, downloadKind) {
    const urls = plan && Array.isArray(plan.urls) ? plan.urls : [];
    let tileTotal = plan && Number.isFinite(Number(plan.tileTotal)) ? Number(plan.tileTotal) : 0;
    let resourceTotal = 0;
    let styleTotal = 0;
    let spriteTotal = 0;
    let glyphTotal = 0;
    for (let i = 0; i < urls.length; i += 1) {
      const kind = String(urls[i] && urls[i].kind || 'resource');
      if (kind === 'tile') continue;
      resourceTotal += 1;
      if (kind === 'style') styleTotal += 1;
      else if (kind === 'sprite') spriteTotal += 1;
      else if (kind === 'glyph') glyphTotal += 1;
    }
    if (!tileTotal) {
      for (let i = 0; i < urls.length; i += 1) {
        if (String(urls[i] && urls[i].kind || '') === 'tile') tileTotal += 1;
      }
    }
    const estimatedBytes = urls.length * OFFLINE_ESTIMATED_BYTES_PER_URL;
    return {
      tileTotal: tileTotal,
      totalUrls: urls.length,
      resourceTotal: resourceTotal,
      styleTotal: styleTotal,
      spriteTotal: spriteTotal,
      glyphTotal: glyphTotal,
      estimatedBytes: estimatedBytes,
      estimatedMissingBytes: estimatedBytes,
      zoomMin: zoomMin,
      zoomMax: zoomMax,
      styleId: styleConfig && styleConfig.id || '',
      styleLabel: styleConfig && (styleConfig.label || styleConfig.id) || '',
      bounds: requestedBounds,
      profile: profile,
      downloadKind: downloadKind,
      tooLarge: tileTotal > OFFLINE_MAX_TILES_PER_REGION
    };
  }

  function getNativeOfflineMapDownloadPlugin() {
    const p = plugins().OfflineMapDownload;
    if (!p || typeof p.startDownload !== 'function') return null;
    return p;
  }

  function normalizeOfflineProfile(profile) {
    const key = String(profile || 'standard').trim().toLowerCase();
    return OFFLINE_ZOOM_PROFILES[key] ? key : 'standard';
  }

  function resolveOfflineZoomRange(kind, profile, bounds, currentZoomValue) {
    const p = normalizeOfflineProfile(profile);
    const mode = String(kind || 'view');
    const zoom = Number.isFinite(Number(currentZoomValue)) ? Number(currentZoomValue) : 13;
    if (mode === 'route' || mode === 'corridor') {
      if (p === 'save') return { zoomMin: 8, zoomMax: 15 };
      if (p === 'detail') return { zoomMin: 10, zoomMax: 18 };
      return { zoomMin: 9, zoomMax: 17 };
    }
    if (mode === 'region' && bounds) {
      const latKm = Math.abs(Number(bounds.north) - Number(bounds.south)) * 111.32;
      const midLat = ((Number(bounds.north) + Number(bounds.south)) / 2) * Math.PI / 180;
      const lonKm = Math.abs(Number(bounds.east) - Number(bounds.west)) * 111.32 * Math.max(0.2, Math.cos(midLat));
      const large = Math.max(latKm, lonKm) > 80;
      const city = Math.max(latKm, lonKm) < 25;
      if (p === 'save') return large ? { zoomMin: 6, zoomMax: 13 } : { zoomMin: 8, zoomMax: city ? 15 : 14 };
      if (p === 'detail') return large ? { zoomMin: 7, zoomMax: 16 } : { zoomMin: 9, zoomMax: city ? 18 : 17 };
      return large ? { zoomMin: 7, zoomMax: 14 } : { zoomMin: 8, zoomMax: city ? 17 : 16 };
    }
    if (p === 'save') return { zoomMin: clampInt(Math.floor(zoom) - 2, 6, 16, 10), zoomMax: clampInt(Math.ceil(zoom) + 1, 10, 16, 15) };
    if (p === 'detail') return { zoomMin: clampInt(Math.floor(zoom) - 1, 8, 18, 11), zoomMax: 18 };
    return { zoomMin: clampInt(Math.floor(zoom) - 1, 7, 17, 10), zoomMax: clampInt(Math.ceil(zoom) + 2, 12, 17, 16) };
  }

  function resolveOfflineRegionPlanContext(regionOpts) {
    const opts = regionOpts || {};
    const styleConfig = opts.styleConfig || resolveCurrentMapStyleConfig();
    if (!styleConfig || !styleConfig.mapId) throw new Error('Kartenstil unbekannt');

    const corridorBounds = opts.routeCoords ? routeCorridorBounds(opts.routeCoords, opts.corridorMeters) : null;
    const requestedBounds = opts.bounds && Number.isFinite(opts.bounds.north) ? opts.bounds : (corridorBounds || resolveCurrentMapBounds());
    if (!requestedBounds) throw new Error('Sichtbarer Bereich konnte nicht ermittelt werden');

    const currentZoomValue = resolveCurrentMapZoom();
    const downloadKind = opts.downloadKind || opts.type || (opts.routeCoords ? 'corridor' : 'view');
    const profile = normalizeOfflineProfile(opts.profile);
    const autoZoom = resolveOfflineZoomRange(downloadKind, profile, requestedBounds, currentZoomValue);
    const zoomMin = clampInt(opts.zoomMin != null ? opts.zoomMin : autoZoom.zoomMin, 2, 18, 10);
    const zoomMax = clampInt(opts.zoomMax != null ? opts.zoomMax : autoZoom.zoomMax, zoomMin, 18, Math.max(zoomMin, 15));

    return {
      opts: opts,
      styleConfig: styleConfig,
      requestedBounds: requestedBounds,
      downloadKind: downloadKind,
      profile: profile,
      zoomMin: zoomMin,
      zoomMax: zoomMax
    };
  }

  async function estimateOfflineRegionDownloadPlan(regionOpts) {
    const ctx = resolveOfflineRegionPlanContext(regionOpts || {});
    const plan = await buildOfflineRegionDownloadPlan(ctx.opts, ctx.styleConfig, ctx.requestedBounds, ctx.zoomMin, ctx.zoomMax);
    return summarizeOfflineDownloadPlan(plan, ctx.zoomMin, ctx.zoomMax, ctx.styleConfig, ctx.requestedBounds, ctx.profile, ctx.downloadKind);
  }

  async function buildSingleRegionPayload(regionOpts) {
    const ctx = resolveOfflineRegionPlanContext(regionOpts || {});
    const plan = await buildOfflineRegionDownloadPlan(ctx.opts, ctx.styleConfig, ctx.requestedBounds, ctx.zoomMin, ctx.zoomMax);
    if (plan.tileTotal > OFFLINE_MAX_TILES_PER_REGION) {
      throw new Error('Zu viele Kacheln in Region "' + (ctx.opts.name || 'unbenannt') + '" (~' + plan.tileTotal.toLocaleString('de-DE') + ')');
    }
    const startedAt = Date.now();
    const regionId = ctx.opts.id || generateRegionId();
    const regionName = String(ctx.opts.name || '').trim() || ('Region ' + new Date(startedAt).toLocaleString('de-DE'));
    const estimate = summarizeOfflineDownloadPlan(plan, ctx.zoomMin, ctx.zoomMax, ctx.styleConfig, ctx.requestedBounds, ctx.profile, ctx.downloadKind);
    const regionRecord = {
      id: regionId,
      name: regionName,
      styleId: ctx.styleConfig.id,
      styleLabel: ctx.styleConfig.label || ctx.styleConfig.id,
      styleMapId: ctx.styleConfig.mapId,
      type: ctx.downloadKind === 'corridor' || ctx.downloadKind === 'route' ? 'corridor' : 'region',
      downloadKind: ctx.downloadKind,
      profile: ctx.profile,
      bounds: ctx.requestedBounds,
      zoomMin: ctx.zoomMin,
      zoomMax: ctx.zoomMax,
      tileTotal: plan.tileTotal,
      urlTotal: estimate.totalUrls,
      resourceTotal: estimate.resourceTotal,
      estimatedBytes: estimate.estimatedBytes,
      estimatedMissingBytes: estimate.estimatedMissingBytes,
      createdAt: startedAt
    };
    if (ctx.opts.corridorMeters) regionRecord.corridorMeters = Number(ctx.opts.corridorMeters) || null;
    if (ctx.opts.routeCacheKey) regionRecord.routeCacheKey = String(ctx.opts.routeCacheKey);
    if (ctx.opts.routeMeta) regionRecord.routeMeta = ctx.opts.routeMeta;
    if (ctx.opts.route) regionRecord.route = ctx.opts.route;
    return {
      regionId: regionId,
      regionName: regionName,
      styleLabel: regionRecord.styleLabel,
      regionRecord: regionRecord,
      urls: plan.urls,
      tileTotal: plan.tileTotal
    };
  }

  async function cacheMapRegionsQueueNative(regions, opts, NativeOfflineMapDownload) {
    const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : null;
    const onRegionComplete = typeof opts.onRegionComplete === 'function' ? opts.onRegionComplete : null;
    const externalSignal = opts.signal || null;
    if (externalSignal && externalSignal.aborted) throw new Error('Abgebrochen');

    setStatus('Offline-Karten: Pläne werden vorbereitet (' + regions.length + ')…');
    const payloadRegions = [];
    for (let i = 0; i < regions.length; i += 1) {
      if (externalSignal && externalSignal.aborted) throw new Error('Abgebrochen');
      const regionPayload = await buildSingleRegionPayload(regions[i]);
      payloadRegions.push(regionPayload);
    }

    return await new Promise(function (resolve, reject) {
      const completedRecords = [];
      const listenerHandles = [];
      let settled = false;
      const rememberRegionRecord = function (record) {
        if (!record) return;
        const id = String(record.id || record.regionId || '');
        if (id) {
          for (let i = 0; i < completedRecords.length; i += 1) {
            const existingId = String(completedRecords[i] && (completedRecords[i].id || completedRecords[i].regionId) || '');
            if (existingId === id) {
              completedRecords[i] = record;
              return;
            }
          }
        }
        completedRecords.push(record);
      };
      const cleanup = function () {
        for (let i = 0; i < listenerHandles.length; i += 1) {
          try { if (listenerHandles[i] && listenerHandles[i].remove) listenerHandles[i].remove(); } catch (_) {}
        }
        if (externalSignal) {
          try { externalSignal.removeEventListener('abort', onAbortRequested); } catch (_) {}
        }
      };
      const onAbortRequested = function () {
        invalidateOfflineRegionsCache();
        try { NativeOfflineMapDownload.cancelDownload({}); } catch (_) {}
      };
      if (externalSignal) externalSignal.addEventListener('abort', onAbortRequested);

      const wireListener = function (eventName, handler) {
        try {
          const result = NativeOfflineMapDownload.addListener(eventName, handler);
          if (result && typeof result.then === 'function') return result;
          return Promise.resolve(result);
        } catch (e) {
          return Promise.resolve(null);
        }
      };

      Promise.all([
        wireListener('progress', function (event) {
          if (!event) return;
          const total = Math.max(0, event.total | 0);
          const downloaded = Math.max(0, event.downloaded | 0);
          const qi = Math.max(0, event.queueIndex | 0);
          const qt = Math.max(1, event.queueTotal | 0);
          setStatus('Offline-Karte (' + (qi + 1) + '/' + qt + '): ' + downloaded + ' / ' + total + ' Kacheln…');
          if (onProgress) {
            onProgress({
              phase: event.phase || 'tiles',
              downloaded: downloaded,
              total: total,
              failed: event.failed | 0,
              processed: event.processed | 0,
              missing: event.missing | 0,
              workers: event.workers | 0,
              queueIndex: qi,
              queueTotal: qt,
              regionId: event.regionId || '',
              regionName: event.regionName || ''
            });
          }
        }),
        wireListener('region-start', function (event) {
          if (!event) return;
          invalidateOfflineRegionsCache();
          const qi = Math.max(0, event.queueIndex | 0);
          const qt = Math.max(1, event.queueTotal | 0);
          setStatus('Region ' + (qi + 1) + '/' + qt + ': ' + (event.regionName || ''));
          if (onProgress) {
            onProgress({
              phase: 'region-start',
              downloaded: 0, total: 0, failed: 0,
              queueIndex: qi, queueTotal: qt,
              regionId: event.regionId || '', regionName: event.regionName || ''
            });
          }
        }),
        wireListener('region-complete', function (event) {
          if (!event) return;
          invalidateOfflineRegionsCache();
          if (event.regionRecord) rememberRegionRecord(event.regionRecord);
          if (onRegionComplete) {
            try { onRegionComplete(event.regionRecord || null, event); } catch (_) {}
          }
        }),
        wireListener('region-incomplete', function (event) {
          if (!event) return;
          invalidateOfflineRegionsCache();
          if (event.regionRecord) rememberRegionRecord(event.regionRecord);
        }),
        wireListener('queue-complete', function (event) {
          if (settled) return;
          invalidateOfflineRegionsCache();
          settled = true;
          cleanup();
          const completedCount = event ? Math.max(0, event.downloaded | 0) : completedRecords.length;
          const totalCount = event ? Math.max(0, event.total | 0) : regions.length;
          const failedCount = event ? Math.max(0, event.failed | 0) : 0;
          setStatus('Offline-Karten bereit: ' + completedCount + ' / ' + totalCount + (failedCount ? ' (' + failedCount + ' Fehler)' : ''));
          resolve({
            completed: completedCount,
            total: totalCount,
            failed: failedCount,
            regions: completedRecords
          });
        }),
        wireListener('cancel', function () {
          if (settled) return;
          invalidateOfflineRegionsCache();
          settled = true;
          cleanup();
          setStatus('Offline-Karten: Abgebrochen');
          const err = new Error('Abgebrochen');
          err.code = 'CANCELLED';
          err.completed = completedRecords.slice();
          reject(err);
        }),
        wireListener('error', function (event) {
          if (settled) return;
          invalidateOfflineRegionsCache();
          settled = true;
          cleanup();
          const msg = (event && event.message) ? event.message : 'Unbekannter Fehler beim Download';
          setStatus('Offline-Karten: Fehler (' + msg + ')');
          const err = new Error(msg);
          err.completed = completedRecords.slice();
          reject(err);
        })
      ]).then(function (handles) {
        for (let i = 0; i < handles.length; i += 1) listenerHandles.push(handles[i]);
        try {
          invalidateOfflineRegionsCache();
          const startPromise = NativeOfflineMapDownload.startDownload({ regions: payloadRegions });
          if (startPromise && typeof startPromise.catch === 'function') {
            startPromise.catch(function (err) {
              if (settled) return;
              settled = true;
              cleanup();
              reject(err instanceof Error ? err : new Error(String(err && err.message || err)));
            });
          }
        } catch (startError) {
          if (!settled) {
            settled = true;
            cleanup();
            reject(startError);
          }
        }
      });
    });
  }

  async function cacheMapRegionsQueue(regions, opts) {
    const list = Array.isArray(regions) ? regions : [];
    if (!list.length) throw new Error('Keine Regionen ausgewählt');
    const NativeOfflineMapDownload = getNativeOfflineMapDownloadPlugin();
    if (NativeOfflineMapDownload) {
      return await cacheMapRegionsQueueNative(list, opts || {}, NativeOfflineMapDownload);
    }
    const results = [];
    let failed = 0;
    for (let i = 0; i < list.length; i += 1) {
      try {
        const record = await cacheMapRegion(Object.assign({}, list[i], {
          onProgress: opts && opts.onProgress ? function (progress) {
            opts.onProgress(Object.assign({}, progress, { queueIndex: i, queueTotal: list.length, regionName: list[i].name || '' }));
          } : null,
          signal: opts && opts.signal ? opts.signal : null
        }));
        results.push(record);
        if (opts && typeof opts.onRegionComplete === 'function') opts.onRegionComplete(record, null);
      } catch (error) {
        if (error && error.code === 'CANCELLED') throw error;
        failed += 1;
      }
    }
    return { completed: results.length, total: list.length, failed: failed, regions: results };
  }

  async function cacheMapRegion(options) {
    const opts = options || {};
    const NativeOfflineMapDownload = getNativeOfflineMapDownloadPlugin();
    if (NativeOfflineMapDownload) {
      const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : null;
      const result = await cacheMapRegionsQueueNative([opts], {
        onProgress: onProgress ? function (p) {
          onProgress({ phase: p.phase, downloaded: p.downloaded, total: p.total, failed: p.failed, processed: p.processed, missing: p.missing, workers: p.workers });
        } : null,
        signal: opts.signal
      }, NativeOfflineMapDownload);
      if (result && Array.isArray(result.regions) && result.regions.length) return result.regions[0];
      throw new Error('Download abgeschlossen, aber kein Region-Status vom Gerät erhalten');
    }
    const nativeMap = resolveActiveNativeMapLibreMap();
    if (!nativeMap) throw new Error('Karte nicht bereit');

    const styleConfig = opts.styleConfig || resolveCurrentMapStyleConfig();
    if (!styleConfig || !styleConfig.mapId) throw new Error('Kartenstil unbekannt');

    const requestedBounds = opts.bounds && Number.isFinite(opts.bounds.north) ? opts.bounds : resolveCurrentMapBounds();
    if (!requestedBounds) throw new Error('Sichtbarer Bereich konnte nicht ermittelt werden');

    const currentZoomValue = resolveCurrentMapZoom();
    const zoomMin = clampInt(opts.zoomMin != null ? opts.zoomMin : Math.max(2, Math.floor((currentZoomValue || 12) - 1)), 2, 18, 10);
    const zoomMax = clampInt(opts.zoomMax != null ? opts.zoomMax : Math.min(18, Math.ceil((currentZoomValue || 14) + 2)), zoomMin, 18, Math.max(zoomMin, 15));

    const estimatedTiles = estimateTileCount(requestedBounds, zoomMin, zoomMax);
    if (estimatedTiles > OFFLINE_MAX_TILES_PER_REGION) {
      throw new Error('Zu viele Kacheln (~' + estimatedTiles.toLocaleString('de-DE') + '). Reduzieren Sie Zoom-Bereich oder Region.');
    }

    const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : null;
    const externalSignal = opts.signal || null;
    if (externalSignal && externalSignal.aborted) throw new Error('Abgebrochen');

    const internalAbortController = ('AbortController' in global) ? new AbortController() : null;
    const propagateAbort = function () {
      if (internalAbortController && !internalAbortController.signal.aborted) internalAbortController.abort();
    };
    if (externalSignal) {
      if (externalSignal.aborted) propagateAbort();
      else externalSignal.addEventListener('abort', propagateAbort);
    }
    const signal = internalAbortController ? internalAbortController.signal : externalSignal;

    const state = global.__offlineMapState || (global.__offlineMapState = { captureActive: false, captureTotalBytes: 0, captureSession: null });
    const previousCaptureActive = state.captureActive;
    const previousSession = state.captureSession;
    const captureBytesBefore = state.captureTotalBytes;
    state.captureActive = true;
    const ownSession = { tileUrls: new Set(), resourceUrls: new Set() };
    state.captureSession = ownSession;

    let regionRecord = null;
    let aborted = false;
    let failureMessage = null;

    try {
      const startedAt = Date.now();
      setStatus('Offline-Karte: Stil wird geladen…');
      if (onProgress) onProgress({ phase: 'style', downloaded: 0, total: 1 });

      let styleJson;
      const styleUrl = resolveMapStyleUrl(styleConfig.mapId);
      const styleResponse = await global.fetch(styleUrl);
      if (!styleResponse || !styleResponse.ok) throw new Error('Stil-Datei konnte nicht geladen werden (HTTP ' + (styleResponse && styleResponse.status) + ')');
      styleJson = await styleResponse.json();

      if (signal && signal.aborted) throw new Error('Abgebrochen');

      const spriteBase = typeof styleJson.sprite === 'string' ? styleJson.sprite : null;
      if (spriteBase) {
        const spriteUrls = [
          spriteBase + '.json',
          spriteBase + '.png',
          spriteBase + '@2x.json',
          spriteBase + '@2x.png'
        ];
        for (let i = 0; i < spriteUrls.length; i += 1) {
          try { await global.fetch(spriteUrls[i]); } catch (error) {}
          if (signal && signal.aborted) throw new Error('Abgebrochen');
        }
      }

      const glyphTemplate = typeof styleJson.glyphs === 'string' ? styleJson.glyphs : null;
      const glyphFonts = glyphTemplate ? collectFontNamesFromStyle(styleJson) : [];
      if (glyphTemplate && glyphFonts.length) {
        for (let i = 0; i < glyphFonts.length; i += 1) {
          for (let j = 0; j < OFFLINE_GLYPH_RANGES.length; j += 1) {
            const start = OFFLINE_GLYPH_RANGES[j];
            const glyphUrl = glyphTemplate
              .replace('{fontstack}', offlineEncodeGlyphFontstack(glyphFonts[i]))
              .replace('{range}', start + '-' + (start + 255));
            if (offlineIsUnsupportedGlyphRangeUrl(glyphUrl)) continue;
            try { await global.fetch(glyphUrl); } catch (error) {}
            if (signal && signal.aborted) throw new Error('Abgebrochen');
          }
        }
      }

      const tileSources = await collectTileTemplatesFromStyle(styleJson, styleUrl);
      if (!tileSources.length) throw new Error('Keine Tile-URLs im Stil gefunden');

      let downloaded = 0;
      let failed = 0;
      const tasks = [];
      for (let i = 0; i < tileSources.length; i += 1) {
        const source = tileSources[i];
        const sourceZoomMin = Math.max(zoomMin, source.minzoom);
        const sourceZoomMax = Math.min(zoomMax, source.maxzoom);
        if (sourceZoomMax < sourceZoomMin) continue;
        const tileCoords = enumerateTilesForBounds(requestedBounds, sourceZoomMin, sourceZoomMax);
        for (let t = 0; t < source.templates.length; t += 1) {
          for (let j = 0; j < tileCoords.length; j += 1) {
            tasks.push({ template: source.templates[t], coord: tileCoords[j] });
          }
        }
      }
      const totalTileRequests = tasks.length;
      if (!totalTileRequests) throw new Error('Keine Tiles im verfuegbaren Zoom-Bereich dieses Stils');

      setStatus('Offline-Karte: 0 / ' + totalTileRequests + ' Kacheln…');
      if (onProgress) onProgress({ phase: 'tiles', downloaded: 0, total: totalTileRequests });

      await runWithConcurrency(tasks, OFFLINE_TILE_FETCH_CONCURRENCY, async function (task) {
        if (signal && signal.aborted) throw new Error('Abgebrochen');
        const tileUrlForTask = fillTileTemplate(task.template, task.coord.z, task.coord.x, task.coord.y);
        try {
          const response = await global.fetch(tileUrlForTask);
          if (!response || !response.ok) failed += 1;
        } catch (error) { failed += 1; }
        downloaded += 1;
        if (onProgress && (downloaded % 10 === 0 || downloaded === totalTileRequests)) {
          onProgress({ phase: 'tiles', downloaded: downloaded, total: totalTileRequests, failed: failed });
        }
      });

      if (signal && signal.aborted) throw new Error('Abgebrochen');

      const finalBytes = Math.max(0, state.captureTotalBytes - captureBytesBefore);
      regionRecord = {
        id: opts.id || generateRegionId(),
        name: String(opts.name || '').trim() || ('Region ' + new Date(startedAt).toLocaleString('de-DE')),
        styleId: styleConfig.id,
        styleLabel: styleConfig.label || styleConfig.id,
        styleMapId: styleConfig.mapId,
        bounds: requestedBounds,
        zoomMin: zoomMin,
        zoomMax: zoomMax,
        tileCount: downloaded - failed,
        tileTotal: totalTileRequests,
        failed: failed,
        sizeBytes: finalBytes,
        createdAt: startedAt,
        durationMs: Date.now() - startedAt
      };
      try { await idbPut(REGION_STORE, null, regionRecord); invalidateOfflineRegionsCache(); }
      catch (regionError) { console.warn('Region-Metadaten konnten nicht gespeichert werden:', regionError); regionRecord = null; throw regionError; }

      setStatus('Offline-Karte bereit (' + (downloaded - failed) + ' Kacheln, ' + Math.round(finalBytes / 1024 / 1024) + ' MB)');
      return regionRecord;
    } catch (error) {
      const message = error && error.message ? String(error.message) : String(error);
      failureMessage = message;
      if (message === 'Abgebrochen' || (signal && signal.aborted)) aborted = true;
      throw error;
    } finally {
      state.captureActive = previousCaptureActive;
      state.captureSession = previousSession;
      if (externalSignal) {
        try { externalSignal.removeEventListener('abort', propagateAbort); } catch (removeError) {}
      }
      if (aborted || !regionRecord) {
        setStatus(aborted ? 'Offline-Karte: Abbruch wird aufgeräumt…' : 'Offline-Karte: Fehler — Cache wird bereinigt…');
        const rollbackSummary = await rollbackOfflineMapSession(ownSession).catch(function () { return { rolledBackTiles: 0, rolledBackResources: 0 }; });
        if (aborted) {
          setStatus('Offline-Karte: Abgebrochen, ' + (rollbackSummary.rolledBackTiles || 0) + ' Kacheln entfernt');
        } else {
          setStatus('Offline-Karte: Fehler' + (failureMessage ? ' (' + failureMessage + ')' : '') + ' — ' + (rollbackSummary.rolledBackTiles || 0) + ' Kacheln entfernt');
        }
      }
    }
  }

  function invalidateOfflineRegionsCache() {
    offlineRegionsCache = null;
    offlineRegionsCacheAt = 0;
    offlineRegionsCacheVersion += 1;
  }

  async function listOfflineRegionsFresh(reason) {
    const caller = String(reason || perfTraceStackLabel(/listOfflineRegions|listOfflineRegionsFresh/) || 'unknown');
    const NativeOfflineMapDownload = getNativeOfflineMapDownloadPlugin();
    if (NativeOfflineMapDownload && typeof NativeOfflineMapDownload.listRegions === 'function') {
      try {
        perfTraceLog('OfflineRegions', [
          'source=native',
          'caller=' + caller
        ], 'offline:native:' + caller, PERF_TRACE_THROTTLE_MS);
        const result = await NativeOfflineMapDownload.listRegions();
        const records = (result && Array.isArray(result.regions)) ? result.regions : [];
        records.sort(function (a, b) { return (b.createdAt || 0) - (a.createdAt || 0); });
        return records;
      } catch (error) { return []; }
    }
    try {
      perfTraceLog('OfflineRegions', [
        'source=idb',
        'caller=' + caller
      ], 'offline:idb:' + caller, PERF_TRACE_THROTTLE_MS);
      const records = await idbGetAll(REGION_STORE);
      records.sort(function (a, b) { return (b.createdAt || 0) - (a.createdAt || 0); });
      return records;
    } catch (error) {
      return [];
    }
  }

  async function listOfflineRegions(reason) {
    const caller = String(reason || perfTraceStackLabel(/listOfflineRegions/) || 'unknown');
    const now = Date.now();
    if (offlineRegionsCache && now - offlineRegionsCacheAt < OFFLINE_REGIONS_CACHE_TTL_MS) {
      perfTraceLog('OfflineRegions', [
        'source=cache',
        'caller=' + caller
      ], 'offline:cache:' + caller, PERF_TRACE_THROTTLE_MS);
      return offlineRegionsCache.slice();
    }
    if (!offlineRegionsPromise) {
      const version = offlineRegionsCacheVersion;
      offlineRegionsPromise = listOfflineRegionsFresh(caller).then(function (records) {
        const list = Array.isArray(records) ? records : [];
        if (version === offlineRegionsCacheVersion) {
          offlineRegionsCache = list.slice();
          offlineRegionsCacheAt = Date.now();
        }
        return list;
      }).finally(function () {
        offlineRegionsPromise = null;
      });
    } else {
      perfTraceLog('OfflineRegions', [
        'source=inFlight',
        'caller=' + caller
      ], 'offline:inflight:' + caller, PERF_TRACE_THROTTLE_MS);
    }
    return offlineRegionsPromise.then(function (records) {
      return (Array.isArray(records) ? records : []).slice();
    });
  }

  async function deleteOfflineRegion(regionId) {
    if (!regionId) throw new Error('Region-ID fehlt');
    const NativeOfflineMapDownload = getNativeOfflineMapDownloadPlugin();
    if (NativeOfflineMapDownload && typeof NativeOfflineMapDownload.deleteRegion === 'function') {
      try {
        const result = await NativeOfflineMapDownload.deleteRegion({ regionId: regionId });
        if (result && result.removed) invalidateOfflineRegionsCache();
        return { removed: !!(result && result.removed), removedTiles: (result && result.urls) || 0 };
      } catch (error) { return { removed: false }; }
    }
    const allRegions = await idbGetAll(REGION_STORE);
    const target = allRegions.find(function (r) { return r && r.id === regionId; });
    if (!target) return { removed: false };
    const remaining = allRegions.filter(function (r) { return r && r.id !== regionId; });
    const protectedUrls = new Set();
    for (let i = 0; i < remaining.length; i += 1) {
      const region = remaining[i];
      if (!region || !region.bounds) continue;
      const tiles = enumerateTilesForBounds(region.bounds, region.zoomMin || 2, region.zoomMax || 16);
      const styleUrl = resolveMapStyleUrl(region.styleMapId || region.styleId || '');
      protectedUrls.add(offlineCanonicalUrl(styleUrl));
      for (let j = 0; j < tiles.length; j += 1) {
        protectedUrls.add('TILE_' + tiles[j].z + '_' + tiles[j].x + '_' + tiles[j].y);
      }
    }
    const db = await openTileDb();
    let removedTiles = 0;
    await new Promise(function (resolve, reject) {
      const tx = db.transaction(TILE_STORE, 'readwrite');
      const store = tx.objectStore(TILE_STORE);
      const req = store.openCursor();
      req.onsuccess = function () {
        const cursor = req.result;
        if (!cursor) { resolve(); return; }
        const urlKey = String(cursor.key);
        const tileCoordMatch = urlKey.match(/\/(\d+)\/(\d+)\/(\d+)\.(?:png|webp|jpe?g|pbf)(?:\?|$)/i);
        let keepTile = false;
        if (tileCoordMatch) {
          const tileToken = 'TILE_' + tileCoordMatch[1] + '_' + tileCoordMatch[2] + '_' + tileCoordMatch[3];
          keepTile = protectedUrls.has(tileToken);
        }
        if (!keepTile) { cursor.delete(); removedTiles += 1; }
        cursor.continue();
      };
      req.onerror = function () { reject(req.error); };
    });
    await idbDelete(REGION_STORE, regionId);
    invalidateOfflineRegionsCache();
    return { removed: true, removedTiles: removedTiles };
  }

  async function getOfflineStorageInfo() {
    const NativeOfflineMapDownload = getNativeOfflineMapDownloadPlugin();
    if (NativeOfflineMapDownload && typeof NativeOfflineMapDownload.getStorageInfo === 'function') {
      try {
        const native = await NativeOfflineMapDownload.getStorageInfo();
        const regions = await listOfflineRegions();
        let totalTiles = 0;
        for (let i = 0; i < regions.length; i += 1) totalTiles += Number(regions[i].tileCount || 0);
        return {
          regionCount: native.regions || regions.length,
          totalBytes: Number(native.totalBytes || 0),
          totalTiles: totalTiles,
          quotaBytes: null,
          usedBytes: Number(native.totalBytes || 0)
        };
      } catch (error) {}
    }
    const regions = await listOfflineRegions();
    let totalBytes = 0;
    let totalTiles = 0;
    for (let i = 0; i < regions.length; i += 1) {
      totalBytes += Number(regions[i].sizeBytes || 0);
      totalTiles += Number(regions[i].tileCount || 0);
    }
    let estimateQuota = null;
    if (typeof navigator !== 'undefined' && navigator.storage && typeof navigator.storage.estimate === 'function') {
      try { estimateQuota = await navigator.storage.estimate(); } catch (error) {}
    }
    return {
      regionCount: regions.length,
      totalBytes: totalBytes,
      totalTiles: totalTiles,
      quotaBytes: estimateQuota && estimateQuota.quota ? estimateQuota.quota : null,
      usedBytes: estimateQuota && estimateQuota.usage ? estimateQuota.usage : null
    };
  }

  async function clearAllOfflineRegions() {
    const NativeOfflineMapDownload = getNativeOfflineMapDownloadPlugin();
    if (NativeOfflineMapDownload && typeof NativeOfflineMapDownload.clearAllRegions === 'function') {
      try {
        await NativeOfflineMapDownload.clearAllRegions();
        invalidateOfflineRegionsCache();
        return { cleared: true };
      } catch (error) {}
    }
    const db = await openTileDb();
    await Promise.all([
      new Promise(function (resolve) { const tx = db.transaction(TILE_STORE, 'readwrite'); const req = tx.objectStore(TILE_STORE).clear(); req.onsuccess = resolve; req.onerror = resolve; }),
      new Promise(function (resolve) { const tx = db.transaction(REGION_STORE, 'readwrite'); const req = tx.objectStore(REGION_STORE).clear(); req.onsuccess = resolve; req.onerror = resolve; }),
      new Promise(function (resolve) { const tx = db.transaction(RESOURCE_STORE, 'readwrite'); const req = tx.objectStore(RESOURCE_STORE).clear(); req.onsuccess = resolve; req.onerror = resolve; })
    ]);
    invalidateOfflineRegionsCache();
    return { cleared: true };
  }

  function getOfflineMapDownloadActiveStatus() {
    const NativeOfflineMapDownload = getNativeOfflineMapDownloadPlugin();
    if (!NativeOfflineMapDownload || typeof NativeOfflineMapDownload.getDownloadStatus !== 'function') {
      return Promise.resolve({ active: false });
    }
    return NativeOfflineMapDownload.getDownloadStatus().catch(function () { return { active: false }; });
  }

  function addOfflineMapDownloadListener(eventName, handler) {
    const NativeOfflineMapDownload = getNativeOfflineMapDownloadPlugin();
    if (!NativeOfflineMapDownload || typeof NativeOfflineMapDownload.addListener !== 'function') return null;
    try { return NativeOfflineMapDownload.addListener(eventName, handler); } catch (e) { return null; }
  }

  function cancelActiveOfflineMapDownload() {
    const NativeOfflineMapDownload = getNativeOfflineMapDownloadPlugin();
    if (!NativeOfflineMapDownload || typeof NativeOfflineMapDownload.cancelDownload !== 'function') return Promise.resolve({ cancelled: false });
    try {
      return Promise.resolve(NativeOfflineMapDownload.cancelDownload({})).then(function (result) {
        invalidateOfflineRegionsCache();
        return result;
      });
    } catch (e) { return Promise.resolve({ cancelled: false }); }
  }

  function dismissOfflineMapDownloadNotifications() {
    const NativeOfflineMapDownload = getNativeOfflineMapDownloadPlugin();
    if (!NativeOfflineMapDownload || typeof NativeOfflineMapDownload.dismissCompletionNotification !== 'function') return Promise.resolve();
    try { return NativeOfflineMapDownload.dismissCompletionNotification(); } catch (e) { return Promise.resolve(); }
  }

  function getOfflineRegionDetails(regionId) {
    const NativeOfflineMapDownload = getNativeOfflineMapDownloadPlugin();
    if (!NativeOfflineMapDownload || typeof NativeOfflineMapDownload.getRegionDetails !== 'function') return Promise.resolve(null);
    return NativeOfflineMapDownload.getRegionDetails({ regionId: regionId });
  }

  function resumeOfflineRegion(regionId) {
    const NativeOfflineMapDownload = getNativeOfflineMapDownloadPlugin();
    if (!NativeOfflineMapDownload || typeof NativeOfflineMapDownload.resumeRegion !== 'function') return Promise.reject(new Error('Fortsetzen ist nur in der Mobile-App verfuegbar'));
    return NativeOfflineMapDownload.resumeRegion({ regionId: regionId }).then(function (result) {
      invalidateOfflineRegionsCache();
      return result;
    });
  }

  function repairOfflineRegion(regionId) {
    const NativeOfflineMapDownload = getNativeOfflineMapDownloadPlugin();
    if (!NativeOfflineMapDownload || typeof NativeOfflineMapDownload.repairRegion !== 'function') return Promise.reject(new Error('Reparatur ist nur in der Mobile-App verfuegbar'));
    return NativeOfflineMapDownload.repairRegion({ regionId: regionId }).then(function (result) {
      invalidateOfflineRegionsCache();
      return result;
    });
  }

  function offlineRecoverTrace(source, reason) {
    perfTraceLog('OfflineRecover', [
      'source=' + String(source || 'unknown'),
      'reason=' + String(reason || 'unknown').replace(/[^a-zA-Z0-9_.:-]/g, '-')
    ], 'offline-recover:' + String(source || 'unknown') + ':' + String(reason || 'unknown'), PERF_TRACE_THROTTLE_MS);
  }

  function offlineRecoverResultChanged(result) {
    if (!result) return false;
    return (Number(result.recoveredJobs || 0) > 0) ||
      (Number(result.recoveredRegions || 0) > 0) ||
      (Number(result.resetTasks || 0) > 0);
  }

  function recoverOfflineState() {
    const reason = String(perfTraceStackLabel(/recoverOfflineState/) || 'unknown');
    const now = Date.now();
    if (offlineRecoverPromise) {
      offlineRecoverTrace('inFlight', reason);
      return offlineRecoverPromise;
    }
    if (offlineRecoverCache && offlineRecoverCacheAtMs && now - offlineRecoverCacheAtMs < OFFLINE_RECOVER_CACHE_TTL_MS) {
      offlineRecoverTrace('cache', reason);
      return Promise.resolve(Object.assign({}, offlineRecoverCache));
    }
    const NativeOfflineMapDownload = getNativeOfflineMapDownloadPlugin();
    if (!NativeOfflineMapDownload || typeof NativeOfflineMapDownload.recoverOfflineState !== 'function') {
      return Promise.resolve({ recoveredJobs: 0, recoveredRegions: 0, resetTasks: 0 });
    }
    offlineRecoverTrace('native', reason);
    offlineRecoverPromise = NativeOfflineMapDownload.recoverOfflineState({}).then(function (result) {
      const normalized = result || { recoveredJobs: 0, recoveredRegions: 0, resetTasks: 0 };
      offlineRecoverCache = Object.assign({}, normalized);
      offlineRecoverCacheAtMs = Date.now();
      if (offlineRecoverResultChanged(normalized)) invalidateOfflineRegionsCache();
      return normalized;
    }).catch(function () {
      return { recoveredJobs: 0, recoveredRegions: 0, resetTasks: 0 };
    }).finally(function () {
      offlineRecoverPromise = null;
    });
    return offlineRecoverPromise;
  }

  async function getOfflineDebugInfo() {
    const NativeOfflineMapDownload = getNativeOfflineMapDownloadPlugin();
    if (NativeOfflineMapDownload && typeof NativeOfflineMapDownload.getDebugInfo === 'function') {
      try { return await NativeOfflineMapDownload.getDebugInfo({}); } catch (error) {}
    }
    const regions = await listOfflineRegions();
    const storage = await getOfflineStorageInfo();
    const counters = global.__offlineMapDebugCounters || {};
    let corridors = 0;
    for (let i = 0; i < regions.length; i += 1) {
      if (regions[i] && regions[i].type === 'corridor') corridors += 1;
    }
    return {
      regionsTotal: regions.length,
      corridorsTotal: corridors,
      downloadJobs: 0,
      queueStatus: { queueLength: 0, queueFiles: 0, urlsFiles: 0 },
      tilesTotal: Number(storage.totalTiles || 0),
      tilesPresent: Number(storage.totalTiles || 0),
      tilesMissing: 0,
      missingTiles: 0,
      missingGlyphs: 0,
      plannedGlyphsMissing: 0,
      unsupportedGlyphRangeCount: 0,
      unsupportedGlyphRanges: [],
      runtimeGlyphMisses: Number(counters.glyphRuntimeMisses || 0),
      glyphFallbackServed: Number(counters.glyphFallbackServed || 0),
      glyphRuntimeMissSuppressed: Number(counters.glyphRuntimeMissSuppressed || 0),
      blockedOfflineNetworkRequests: Number(counters.blockedOfflineNetworkRequests || 0),
      topRuntimeGlyphMisses: offlineRuntimeGlyphMissList(),
      missingSprites: 0,
      missingGlyphRanges: [],
      cacheSizeBytes: Number(storage.totalBytes || 0),
      cacheHits: Number(counters.cacheHits || 0),
      cacheMisses: Number(counters.cacheMisses || 0),
      glyphCacheHits: Number(counters.glyphCacheHits || 0),
      glyphCacheMisses: Number(counters.glyphCacheMisses || 0),
      httpDownloads: Number(counters.httpDownloads || 0),
      httpErrors: Number(counters.httpErrors || 0),
      skippedAlreadyPresent: Number(counters.skippedAlreadyPresent || 0),
      currentWorkerCount: 0,
      rateLimitedUntil: 0,
      errorDiagnostics: {
        byType: {
          'HTTP 429': 0,
          'HTTP 403': 0,
          'HTTP 404': 0,
          timeout: 0,
          'connection reset': 0,
          'storage error': 0,
          'tile too large': 0,
          'empty response': 0,
          unknown: 0
        },
        topLastErrors: []
      },
      timings: {},
      verifyStatus: regions.length ? 'not_started' : 'not_started',
      lastVerifyAt: 0,
      serviceActive: false
    };
  }

  function verifyOfflineIntegrity(regionId) {
    const NativeOfflineMapDownload = getNativeOfflineMapDownloadPlugin();
    if (!NativeOfflineMapDownload || typeof NativeOfflineMapDownload.verifyOfflineIntegrity !== 'function') {
      return getOfflineDebugInfo();
    }
    return NativeOfflineMapDownload.verifyOfflineIntegrity(regionId ? { regionId: regionId } : {});
  }

  function repairStaleOfflineJobs() {
    const NativeOfflineMapDownload = getNativeOfflineMapDownloadPlugin();
    if (!NativeOfflineMapDownload || typeof NativeOfflineMapDownload.repairStaleJobs !== 'function') {
      return recoverOfflineState();
    }
    return NativeOfflineMapDownload.repairStaleJobs({}).then(function (result) {
      invalidateOfflineRegionsCache();
      return result;
    });
  }

  async function cacheRouteCorridor(options) {
    const opts = options || {};
    const routeCoords = normalizeRouteCoords(opts.routeCoords);
    if (routeCoords.length < 2) throw new Error('Keine aktive Route fuer den Offline-Korridor');
    const profile = normalizeOfflineProfile(opts.profile);
    const corridorMeters = Number(opts.corridorMeters) || OFFLINE_ROUTE_CORRIDOR_METERS[profile] || 2000;
    const bounds = opts.bounds && Number.isFinite(opts.bounds.north) ? opts.bounds : routeCorridorBounds(routeCoords, corridorMeters);
    if (!bounds) throw new Error('Route-Korridor konnte nicht berechnet werden');
    const name = String(opts.name || '').trim() || 'Route offline';
    const payload = {
      id: opts.id || generateRegionId(),
      name: name,
      bounds: bounds,
      type: 'corridor',
      downloadKind: 'corridor',
      profile: profile,
      corridorMeters: corridorMeters,
      routeCoords: routeCoords,
      routeCacheKey: opts.routeCacheKey || '',
      routeMeta: opts.routeMeta || null,
      route: opts.route || null,
      styleConfig: opts.styleConfig || resolveCurrentMapStyleConfig()
    };
    return cacheMapRegionsQueue([payload], opts);
  }

  function estimateRouteCorridorTileCount(routeCoords, profile) {
    const p = normalizeOfflineProfile(profile);
    const corridorMeters = OFFLINE_ROUTE_CORRIDOR_METERS[p] || 2000;
    const bounds = routeCorridorBounds(routeCoords, corridorMeters);
    if (!bounds) return 0;
    const range = resolveOfflineZoomRange('corridor', p, bounds, resolveCurrentMapZoom());
    const filter = buildRouteCorridorTileFilter(routeCoords, corridorMeters);
    return estimateTileCount(bounds, range.zoomMin, range.zoomMax, filter);
  }

  async function refreshNetworkMode() {
    const online = await isOnline();
    offlineModeActive = !online;
    if (online && serverUploadEnabled && serverConnectAllowed()) {
      connectServerTransportsIfAvailable();
    }
    if (online && global.MOBILE_LOCAL_ASSETS && global.__mobileServerAvailable !== true) {
      checkServerAvailability().then(function (available) {
        if (available) connectServerTransportsIfAvailable();
      }).catch(function () {});
    }
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
      headingFilterMapBearingDeadbandDeg: cfg.headingFilterMapBearingDeadbandDeg,
      driveEnterSpeedKmh: cfg.driveEnterSpeedKmh,
      driveExitSpeedKmh: cfg.driveExitSpeedKmh,
      driveConfirmFixes: cfg.driveConfirmFixes,
      driveExitHoldMs: cfg.driveExitHoldMs,
      driveMinMoveM: cfg.driveMinMoveM
    };
  }

  function profileFilterPayload(cfg, uploadMode) {
    if (uploadMode) {
      return {
        idleSec: cfg.idleSec,
        movingSec: cfg.movingSec,
        intervalMin: cfg.intervalMin
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
    if (data.driveEnterSpeedKmh != null) cfg.driveEnterSpeedKmh = clamp(data.driveEnterSpeedKmh, 5, 40, cfg.driveEnterSpeedKmh);
    if (data.driveExitSpeedKmh != null) cfg.driveExitSpeedKmh = clamp(data.driveExitSpeedKmh, 3, 30, cfg.driveExitSpeedKmh);
    if (data.driveConfirmFixes != null) cfg.driveConfirmFixes = clampInt(data.driveConfirmFixes, 2, 6, cfg.driveConfirmFixes);
    if (data.driveExitHoldMs != null) cfg.driveExitHoldMs = clampInt(data.driveExitHoldMs, 1000, 15000, cfg.driveExitHoldMs);
    if (data.driveMinMoveM != null) cfg.driveMinMoveM = clamp(data.driveMinMoveM, 0.2, 20, cfg.driveMinMoveM);
  }

  function buildProfileSettingsPayload(user, deviceName, oldDeviceKey) {
    const parts = String(deviceKey || '').split('/');
    const display = profileFilterPayload(displaySettings, false);
    const upload = profileFilterPayload(uploadSettings, true);
    const payload = Object.assign({
      user: user,
      deviceName: deviceName || (parts.length > 1 ? parts.slice(1).join('/') : ''),
      deviceKey: deviceKey,
      display: display,
      upload: upload,
      serverHost: configuredServerHost,
      restPort: configuredRestPort,
      mqttTcpPort: configuredMqttTcpPort,
      serverUrl: serverBaseUrl(),
      mqttWebSocketUrl: mqttWebSocketUrl(),
      backgroundUploadEnabled: backgroundUploadEnabled,
      serverUploadEnabled: serverUploadEnabled
    }, display, upload);
    if (oldDeviceKey !== undefined) payload.oldDeviceKey = oldDeviceKey;
    return payload;
  }

  async function getProfileSettings() {
    await ensureSettingsLoadedOnce();
    const parts = String(deviceKey || '').split('/');
    const user = parts[0] || await prefGet(PREF_USER, 'mobile');
    const deviceName = parts.length > 1 ? parts.slice(1).join('/') : await prefGet(PREF_DEVICE_NAME, '');
    return buildProfileSettingsPayload(user, deviceName);
  }

  async function saveProfileSettings(data) {
    data = data || {};
    const oldDeviceKey = deviceKey;
    const oldParts = String(oldDeviceKey || '').split('/');
    const oldUser = oldParts[0] || 'mobile';
    const oldDeviceName = oldParts.slice(1).join('/') || '';
    const oldServerConfig = activeServerConfig();
    const oldServerConfigIdentity = serverConfigIdentity(oldServerConfig);
    const currentPrefValues = {};
    function rememberPref(key, value) {
      currentPrefValues[key] = String(value);
    }
    rememberPref(PREF_USER, oldUser);
    rememberPref(PREF_DEVICE_NAME, oldDeviceName);
    rememberPref(PREF_MIN_MOVE_M, displaySettings.minMoveM);
    rememberPref(PREF_MAX_ACCURACY_M, displaySettings.maxAccuracyM);
    rememberPref(PREF_WALKING_SPEED_KMH, displaySettings.walkingSpeedKmh);
    rememberPref(PREF_MOVING_SPEED_KMH, displaySettings.movingSpeedKmh);
    rememberPref(PREF_STATIONARY_RADIUS_M, displaySettings.stationaryRadiusM);
    rememberPref(PREF_STATIONARY_MAX_RADIUS_M, displaySettings.stationaryMaxRadiusM);
    rememberPref(PREF_CONFIRM_POINTS, displaySettings.confirmPoints);
    rememberPref(PREF_SPEED_JUMP_KMH, displaySettings.speedJumpKmh);
    rememberPref(PREF_HEADING_FILTER_PRESET, displaySettings.headingFilterPreset);
    rememberPref(PREF_HEADING_FILTER_MAX_JUMP_DEG, displaySettings.headingFilterMaxJumpDeg);
    rememberPref(PREF_HEADING_FILTER_DEADBAND_DEG, displaySettings.headingFilterDeadbandDeg);
    rememberPref(PREF_HEADING_FILTER_SMOOTH_LEVEL, displaySettings.headingFilterSmoothLevel);
    rememberPref(PREF_HEADING_FILTER_SAMPLE_MAX, displaySettings.headingFilterSampleMax);
    rememberPref(PREF_HEADING_FILTER_TURN_CONFIRM, displaySettings.headingFilterTurnConfirmSamples);
    rememberPref(PREF_HEADING_FILTER_MAP_SPIKE_DEG, displaySettings.headingFilterMapSpikeRejectDeg);
    rememberPref(PREF_HEADING_FILTER_MAP_BEARING_DEG, displaySettings.headingFilterMapBearingDeadbandDeg);
    rememberPref(PREF_DRIVE_ENTER_SPEED_KMH, displaySettings.driveEnterSpeedKmh);
    rememberPref(PREF_DRIVE_EXIT_SPEED_KMH, displaySettings.driveExitSpeedKmh);
    rememberPref(PREF_DRIVE_CONFIRM_FIXES, displaySettings.driveConfirmFixes);
    rememberPref(PREF_DRIVE_EXIT_HOLD_MS, displaySettings.driveExitHoldMs);
    rememberPref(PREF_DRIVE_MIN_MOVE_M, displaySettings.driveMinMoveM);
    rememberPref(PREF_UPLOAD_IDLE_SEC, uploadSettings.idleSec);
    rememberPref(PREF_UPLOAD_MOVING_SEC, uploadSettings.movingSec);
    rememberPref(PREF_UPLOAD_INTERVAL_MIN, uploadSettings.intervalMin);
    rememberPref(PREF_BACKGROUND_UPLOAD, backgroundUploadEnabled ? '1' : '0');
    rememberPref(PREF_SERVER_UPLOAD, serverUploadEnabled ? '1' : '0');
    rememberPref(PREF_SERVER_HOST, configuredServerHost);
    rememberPref(PREF_REST_PORT, configuredRestPort);
    rememberPref(PREF_MQTT_TCP_PORT, configuredMqttTcpPort);
    rememberPref(PREF_LEGACY_SERVER_URL, serverBaseUrl());
    rememberPref(PREF_LEGACY_MQTT_WS_URL, mqttWebSocketUrl());
    rememberPref(PREF_LEGACY_MQTT_TCP_HOST, configuredServerHost);
    rememberPref(PREF_LEGACY_MQTT_TCP_PORT, configuredMqttTcpPort);
    rememberPref(PREF_DEVICE_KEY, oldDeviceKey);
    const user = sanitizePart(data.user, 'mobile');
    const deviceName = sanitizePart(data.deviceName, oldDeviceName || 'phone');
    const displayData = data.display || data;
    const uploadData = data.upload || data;
    applyPositionFilterFromData(displayData, displaySettings, false);
    applyPositionFilterFromData(uploadData, uploadSettings, true);
    applyHeadingFilterSettingsFromData(displayData);
    if (data.backgroundUploadEnabled != null) {
      backgroundUploadEnabled = !!data.backgroundUploadEnabled;
    }
    const nextServerConfig = normalizeServerConfigInput(data, oldServerConfig);
    configuredServerHost = nextServerConfig.host;
    configuredRestPort = nextServerConfig.restPort;
    configuredMqttTcpPort = nextServerConfig.mqttTcpPort;
    const serverTargetChanged = serverConfigIdentity(nextServerConfig) !== oldServerConfigIdentity;
    if (serverTargetChanged) logServerConfig('serverChanged', nextServerConfig);
    logServerConfig('derived', nextServerConfig);
    try {
      localStorage.setItem(PREF_SERVER_HOST, configuredServerHost);
      localStorage.setItem(PREF_REST_PORT, String(configuredRestPort));
      localStorage.setItem(PREF_MQTT_TCP_PORT, String(configuredMqttTcpPort));
      localStorage.setItem(PREF_LEGACY_SERVER_URL, serverBaseUrl());
      localStorage.setItem(PREF_LEGACY_MQTT_WS_URL, mqttWebSocketUrl());
      localStorage.setItem(PREF_LEGACY_MQTT_TCP_HOST, configuredServerHost);
      localStorage.setItem(PREF_LEGACY_MQTT_TCP_PORT, String(configuredMqttTcpPort));
    } catch (error) {}
    let serverUploadInputProvided = false;
    if (data.serverUploadEnabled != null) {
      serverUploadInputProvided = true;
      serverUploadEnabled = !!data.serverUploadEnabled;
      if (serverUploadEnabled &&
          locationServiceState === 'disabled' &&
          !validLocalPoint(getUsableLocalPoint(LOCATION_USABLE_CACHED_POINT_MS))) {
        serverUploadEnabled = false;
        traceLocationRequired('serverUpload', 'blocked-final');
      }
    }
    const newKey = buildDeviceKey(user, deviceName);
    const writes = [];
    function addWrite(key, value) {
      writes.push({ key: key, value: value, currentValue: currentPrefValues[key] });
    }
    addWrite(PREF_USER, user);
    addWrite(PREF_DEVICE_NAME, deviceName);
    addWrite(PREF_MIN_MOVE_M, displaySettings.minMoveM);
    addWrite(PREF_MAX_ACCURACY_M, displaySettings.maxAccuracyM);
    addWrite(PREF_WALKING_SPEED_KMH, displaySettings.walkingSpeedKmh);
    addWrite(PREF_MOVING_SPEED_KMH, displaySettings.movingSpeedKmh);
    addWrite(PREF_STATIONARY_RADIUS_M, displaySettings.stationaryRadiusM);
    addWrite(PREF_STATIONARY_MAX_RADIUS_M, displaySettings.stationaryMaxRadiusM);
    addWrite(PREF_CONFIRM_POINTS, displaySettings.confirmPoints);
    addWrite(PREF_SPEED_JUMP_KMH, displaySettings.speedJumpKmh);
    addWrite(PREF_HEADING_FILTER_PRESET, displaySettings.headingFilterPreset);
    addWrite(PREF_HEADING_FILTER_MAX_JUMP_DEG, displaySettings.headingFilterMaxJumpDeg);
    addWrite(PREF_HEADING_FILTER_DEADBAND_DEG, displaySettings.headingFilterDeadbandDeg);
    addWrite(PREF_HEADING_FILTER_SMOOTH_LEVEL, displaySettings.headingFilterSmoothLevel);
    addWrite(PREF_HEADING_FILTER_SAMPLE_MAX, displaySettings.headingFilterSampleMax);
    addWrite(PREF_HEADING_FILTER_TURN_CONFIRM, displaySettings.headingFilterTurnConfirmSamples);
    addWrite(PREF_HEADING_FILTER_MAP_SPIKE_DEG, displaySettings.headingFilterMapSpikeRejectDeg);
    addWrite(PREF_HEADING_FILTER_MAP_BEARING_DEG, displaySettings.headingFilterMapBearingDeadbandDeg);
    addWrite(PREF_DRIVE_ENTER_SPEED_KMH, displaySettings.driveEnterSpeedKmh);
    addWrite(PREF_DRIVE_EXIT_SPEED_KMH, displaySettings.driveExitSpeedKmh);
    addWrite(PREF_DRIVE_CONFIRM_FIXES, displaySettings.driveConfirmFixes);
    addWrite(PREF_DRIVE_EXIT_HOLD_MS, displaySettings.driveExitHoldMs);
    addWrite(PREF_DRIVE_MIN_MOVE_M, displaySettings.driveMinMoveM);
    addWrite(PREF_UPLOAD_IDLE_SEC, uploadSettings.idleSec);
    addWrite(PREF_UPLOAD_MOVING_SEC, uploadSettings.movingSec);
    addWrite(PREF_UPLOAD_INTERVAL_MIN, uploadSettings.intervalMin);
    addWrite(PREF_BACKGROUND_UPLOAD, backgroundUploadEnabled ? '1' : '0');
    addWrite(PREF_SERVER_UPLOAD, serverUploadEnabled ? '1' : '0');
    addWrite(PREF_SERVER_HOST, configuredServerHost);
    addWrite(PREF_REST_PORT, configuredRestPort);
    addWrite(PREF_MQTT_TCP_PORT, configuredMqttTcpPort);
    addWrite(PREF_LEGACY_SERVER_URL, serverBaseUrl());
    addWrite(PREF_LEGACY_MQTT_WS_URL, mqttWebSocketUrl());
    addWrite(PREF_LEGACY_MQTT_TCP_HOST, configuredServerHost);
    addWrite(PREF_LEGACY_MQTT_TCP_PORT, configuredMqttTcpPort);
    addWrite(PREF_DEVICE_KEY, newKey);
    let changed = 0;
    let skipped = 0;
    beginSettingsSaveBatch();
    try {
      for (let i = 0; i < writes.length; i += 1) {
        const item = writes[i];
        const didWrite = await prefSetIfChanged(item.key, item.value, {
          currentValue: item.currentValue,
          deferInvalidate: true
        });
        if (didWrite) changed += 1;
        else skipped += 1;
        if (global.__CAPACITOR_SETTINGS_SAVE_TRACE) {
          perfTraceLog('SettingsSave', [
            'key=' + item.key,
            'action=' + (didWrite ? 'write' : 'skip')
          ], 'settings-save-key:' + item.key + ':' + (didWrite ? 'write' : 'skip'), PERF_TRACE_THROTTLE_MS);
        }
      }
    } finally {
      endSettingsSaveBatch();
    }
    markSettingsCacheFresh();
    perfTraceLog('SettingsSave', [
      'changed=' + changed,
      'skipped=' + skipped
    ], 'settings-save-summary:' + Date.now(), 0);
    deviceKey = newKey;
    const deviceKeyChanged = newKey !== oldDeviceKey;
    if ((serverTargetChanged || deviceKeyChanged) && mqttClient) {
      try { mqttClient.end(true); } catch (error) {}
      mqttClient = null;
    }
    if (serverUploadInputProvided) {
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
    if (changed > 0) {
      lastSendMs = 0;
      lastLat = null;
      lastLon = null;
      resetFilterStates();
      resetHeadingStabilizer();
      announceLocalDevice();
      registerInitialPoint({ promptLocationServices: false }).catch(function () {
        setStatus('Lokale Anzeige bereit - Standort folgt');
      });
      await applyBackgroundUploadMode();
      if (serverUploadEnabled) {
        if (serverConnectAllowed()) {
          connectServerTransportsIfAvailable();
        } else {
          checkServerAvailability().then(function (available) {
            if (available) connectServerTransportsIfAvailable();
          }).catch(function () {});
        }
      }
      setupAppVisibilityHandlers();
      if (typeof global.__capacitorSelectDevice === 'function') {
        global.__capacitorSelectDevice(deviceKey, { registerOnly: true });
      }
    }
    markSettingsCacheFresh();
    perfTraceLog('SettingsSaveApply', [
      'source=memory',
      'changed=' + changed
    ], 'settings-save-apply', PERF_TRACE_THROTTLE_MS);
    return buildProfileSettingsPayload(user, deviceName, oldDeviceKey);
  }

  async function refreshNow() {
    await ensureSettingsLoadedOnce();
    await importNativeBufferedRoute();
    await registerInitialPoint({ promptLocationServices: false });
    await refreshNetworkMode();
    if (serverUploadEnabled && serverConnectAllowed()) {
      connectServerTransportsIfAvailable();
    }
    return getProfileSettings();
  }

  async function init() {
    if (!isNative()) return false;
    if (bridgeReady) return true;
    if (global.MOBILE_LOCAL_ASSETS) mobileStartupLog('local assets loaded');
    await loadSettings('init');
    await ensureDeviceKey();
    await importNativeBufferedRoute();
    document.documentElement.classList.add('native-app');
    setStatus('Lokale App bereit - Standort folgt');
    await maybePromptLocationSettingsOnColdStart('appOpen').catch(function () { return false; });
    registerInitialPoint({ promptLocationServices: true }).catch(function () {
      setStatus('Lokale App bereit - Standort anfordern');
    });
    if (!(await applyBackgroundUploadMode()) && backgroundUploadEnabled && serverUploadEnabled && hasConfiguredMqttTarget()) {
      setStatus('Hintergrund-GPS nicht verfügbar — Vordergrund-Upload aktiv');
    }
    setupAppVisibilityHandlers();
    if (serverUploadEnabled && serverConnectAllowed()) {
      connectServerTransportsIfAvailable();
    }
    setupNetworkStatusHandlers();
    await refreshNetworkMode();
    if (offlineModeActive) mobileStartupLog('offline mode');
    checkServerAvailability().then(function (available) {
      if (available) connectServerTransportsIfAvailable();
    }).catch(function () {});
    await recoverOfflineState().catch(function () {});
    bridgeReady = true;
    return true;
  }

  global.CapacitorMobileBridge = {
    init: init,
    isNative: isNative,
    isOnline: isOnline,
    getServerBaseUrl: serverBaseUrl,
    getServerConfig: function () {
      const config = activeServerConfig();
      return {
        host: config.host,
        restPort: config.restPort,
        mqttTcpPort: config.mqttTcpPort,
        restUrl: serverBaseUrlFromConfig(config),
        mqttWebSocketUrl: mqttWebSocketUrlFromConfig(config)
      };
    },
    checkServerAvailability: checkServerAvailability,
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
        stoppedAt: stoppedAt,
        locationServiceState: locationServiceState
      };
    },
    getLocationServiceState: function () {
      return {
        state: locationServiceState,
        blocked: locationBlockedWithoutUsablePoint(),
        blockedUntilMs: locationServicesBlockedUntilMs || 0,
        reason: locationServicesBlockedReason || '',
        pendingAction: locationRequiredActionPending || ''
      };
    },
    setTrackingActive: setTrackingActive,
    publishTrackingStatus: publishTrackingStatus,
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
    cacheMapRegionsQueue: cacheMapRegionsQueue,
    listOfflineRegions: listOfflineRegions,
    deleteOfflineRegion: deleteOfflineRegion,
    getOfflineStorageInfo: getOfflineStorageInfo,
    clearAllOfflineRegions: clearAllOfflineRegions,
    getOfflineMapDownloadStatus: getOfflineMapDownloadActiveStatus,
    addOfflineMapDownloadListener: addOfflineMapDownloadListener,
    cancelActiveOfflineMapDownload: cancelActiveOfflineMapDownload,
    dismissOfflineMapDownloadNotifications: dismissOfflineMapDownloadNotifications,
    getOfflineRegionDetails: getOfflineRegionDetails,
    resumeOfflineRegion: resumeOfflineRegion,
    repairOfflineRegion: repairOfflineRegion,
    recoverOfflineState: recoverOfflineState,
    getOfflineDebugInfo: getOfflineDebugInfo,
    verifyOfflineIntegrity: verifyOfflineIntegrity,
    repairStaleOfflineJobs: repairStaleOfflineJobs,
    cacheRouteCorridor: cacheRouteCorridor,
    estimateOfflineRegionDownloadPlan: estimateOfflineRegionDownloadPlan,
    estimateOfflineRouteCorridorTileCount: estimateRouteCorridorTileCount,
    getOfflineZoomProfileRange: function (kind, profile, bounds) {
      return resolveOfflineZoomRange(kind, profile, bounds || resolveCurrentMapBounds(), resolveCurrentMapZoom());
    },
    estimateOfflineRegionTileCount: function (bounds, zoomMin, zoomMax) {
      if (!bounds || !Number.isFinite(bounds.north)) return 0;
      const zMin = clampInt(zoomMin, 2, 18, 10);
      const zMax = clampInt(zoomMax, zMin, 18, Math.max(zMin, 15));
      return estimateTileCount(bounds, zMin, zMax);
    },
    getCurrentMapBounds: resolveCurrentMapBounds,
    getCurrentMapZoom: resolveCurrentMapZoom,
    refreshNow: refreshNow,
    flushQueue: flushQueue
  };
})(window);
