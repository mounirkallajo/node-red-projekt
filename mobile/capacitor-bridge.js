(function (global) {
  'use strict';

  global.__CAPACITOR_BRIDGE_VERSION = '20260531-display-interval-upload-v1';
  let offlineMapUpstreamFetch = null;

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
    offlineMapUpstreamFetch = upstreamFetch;
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

  function offlineCanonicalUrlSorted(url) {
    try {
      const parsed = new URL(url, global.location && global.location.href);
      const base = parsed.origin + parsed.pathname;
      const rawQuery = parsed.search ? parsed.search.slice(1).split('&') : [];
      const kept = [];
      for (let i = 0; i < rawQuery.length; i += 1) {
        const pair = rawQuery[i];
        if (!pair) continue;
        const eq = pair.indexOf('=');
        const key = eq >= 0 ? pair.slice(0, eq) : pair;
        const lower = String(key || '').toLowerCase();
        if (lower === 'key' || lower === 'apikey' || lower === 'access_token') continue;
        kept.push(pair);
      }
      kept.sort();
      return offlineNormalizeGlyphUrl(base + (kept.length ? '?' + kept.join('&') : ''));
    } catch (error) {
      return offlineCanonicalUrl(url);
    }
  }

  function offlineStripQueryAndHash(url) {
    let output = String(url || '');
    const hashIndex = output.indexOf('#');
    if (hashIndex >= 0) output = output.slice(0, hashIndex);
    const queryIndex = output.indexOf('?');
    return queryIndex >= 0 ? output.slice(0, queryIndex) : output;
  }

  function offlineUniqueList(values) {
    const seen = {};
    const out = [];
    for (let i = 0; i < values.length; i += 1) {
      const value = String(values[i] || '');
      if (!value || seen[value]) continue;
      seen[value] = true;
      out.push(value);
    }
    return out;
  }

  function offlineCacheLookupCandidates(url) {
    return offlineUniqueList([
      offlineCanonicalUrl(url),
      offlineCanonicalUrlSorted(url),
      offlineCanonicalUrl(offlineStripQueryAndHash(url))
    ]);
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

  function offlineIsSpriteUrl(url) {
    return /\/sprite(?:@2x)?\.(?:json|png)(?:\?|$)/i.test(String(url || ''));
  }

  function offlineIsMapTilerCriticalRuntimeResourceUrl(url) {
    return offlineIsStyleUrl(url) || offlineIsTileJsonUrl(url) || offlineIsGlyphUrl(url) || offlineIsSpriteUrl(url);
  }

  function offlineNativeRuntimeResourceKind(url) {
    if (offlineIsStyleUrl(url)) return 'Style';
    if (offlineIsTileJsonUrl(url)) return 'TileJSON';
    if (offlineIsSpriteUrl(url)) return 'Sprite';
    if (offlineIsGlyphUrl(url)) return 'Glyph';
    return 'Resource';
  }

  function offlineNativeRuntimeMimeType(url, storedMimeType) {
    const stored = String(storedMimeType || '').trim();
    if (stored) return stored;
    const canonical = offlineCanonicalUrl(url);
    if (/\.png(?:\?|$)/i.test(canonical)) return 'image/png';
    if (/\.pbf(?:\?|$)/i.test(canonical)) return 'application/x-protobuf';
    if (/\.json(?:\?|$)/i.test(canonical)) return 'application/json';
    return 'application/octet-stream';
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

  function offlineResourceLogState() {
    return global.__offlineMapResourceLogByKey || (global.__offlineMapResourceLogByKey = {});
  }

  function offlineGlyphLabel(url) {
    const match = String(url || '').match(/\/fonts\/([^/?#]+)\/(\d+-\d+)\.pbf/i);
    if (!match) return 'font=? range=?';
    return 'font=' + offlineDecodePathComponentRepeated(match[1]) + ' range=' + match[2];
  }

  function offlineSpriteLabel(url) {
    const match = String(url || '').match(/\/([^/?#]*sprite(?:@2x)?\.(?:json|png))(?:\?|$)/i);
    return 'sprite=' + (match && match[1] ? match[1] : '?');
  }

  function offlineResourceLog(marker, url, detail) {
    const key = marker + '|' + offlineUrlForLog(url);
    const now = Date.now();
    const state = offlineResourceLogState();
    if (state[key] && now - state[key] <= 10000) return;
    state[key] = now;
    offlineLog(marker, String(detail || '').trim() + ' url=' + offlineUrlForLog(url));
  }

  function offlineLogResourceHit(url, matchedKey) {
    if (offlineIsTileJsonUrl(url)) {
      offlineLog('OfflineTileJsonHit', 'canonical=' + matchedKey + ' url=' + offlineUrlForLog(url));
    } else if (offlineIsGlyphUrl(url)) {
      offlineLog('OfflineGlyphHit', offlineGlyphLabel(url) + ' canonical=' + matchedKey + ' url=' + offlineUrlForLog(url));
    } else if (offlineIsSpriteUrl(url)) {
      offlineLog('OfflineSpriteHit', offlineSpriteLabel(url) + ' canonical=' + matchedKey + ' url=' + offlineUrlForLog(url));
    }
  }

  function offlineLogResourceMiss(url) {
    const canonical = offlineCanonicalUrl(url);
    if (offlineIsTileJsonUrl(url)) {
      offlineResourceLog('OfflineTileJsonMiss', url, 'canonical=' + canonical);
    } else if (offlineIsGlyphUrl(url)) {
      offlineResourceLog('OfflineGlyphMiss', url, offlineGlyphLabel(url) + ' canonical=' + canonical);
    } else if (offlineIsSpriteUrl(url)) {
      offlineResourceLog('OfflineSpriteMiss', url, offlineSpriteLabel(url) + ' canonical=' + canonical);
    }
  }

  function offlineLogResourceBlockedBeforeLookup(url, blockedBeforeLookup, reason) {
    let marker = '';
    let detail = 'blockedBeforeLookup=' + (blockedBeforeLookup ? 'true' : 'false') + ' reason=' + String(reason || '');
    if (offlineIsTileJsonUrl(url)) marker = 'OfflineTileJsonBlockedBeforeLookup';
    else if (offlineIsGlyphUrl(url)) {
      marker = 'OfflineGlyphBlockedBeforeLookup';
      detail += ' ' + offlineGlyphLabel(url);
    } else if (offlineIsSpriteUrl(url)) {
      marker = 'OfflineSpriteBlockedBeforeLookup';
      detail += ' ' + offlineSpriteLabel(url);
    }
    if (marker) offlineResourceLog(marker, url, detail + ' canonical=' + offlineCanonicalUrl(url));
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

  function serverCooldownLog(message) {
    try {
      if (!global.console || typeof global.console.info !== 'function') return;
      global.console.info(message);
    } catch (error) {}
  }

  function offlineUrlForLog(url) {
    try { return offlineCanonicalUrl(url); } catch (error) { return String(url || ''); }
  }

  function mapTilerCooldownState() {
    const state = global.__mapTilerCooldownState || (global.__mapTilerCooldownState = {});
    if (!state.blockLogByUrl) state.blockLogByUrl = {};
    state.unavailable = !!state.unavailable;
    state.cooldownUntil = Number(state.cooldownUntil || 0);
    state.probeInFlight = !!state.probeInFlight;
    return state;
  }

  function isMapTilerUrl(url) {
    try {
      return new URL(url, global.location && global.location.href).hostname === 'api.maptiler.com';
    } catch (error) {
      return String(url || '').indexOf('//api.maptiler.com/') >= 0;
    }
  }

  function mapTilerCooldownLog(message) {
    offlineLog(message);
  }

  function mapTilerCooldownActive() {
    const state = mapTilerCooldownState();
    return !!(state.unavailable || state.probeInFlight);
  }

  function mapTilerCooldownNotify(active) {
    const state = mapTilerCooldownState();
    try {
      global.dispatchEvent(new CustomEvent('maptiler-cooldown-change', {
        detail: {
          active: !!active,
          cooldownUntil: Number(state.cooldownUntil || 0),
          probeInFlight: !!state.probeInFlight,
          reason: state.lastReason || '',
          url: state.lastUrl || ''
        }
      }));
    } catch (error) {}
  }

  function mapTilerCooldownStart(reason, url) {
    const state = mapTilerCooldownState();
    state.unavailable = true;
    state.cooldownUntil = Date.now() + MAPTILER_COOLDOWN_MS;
    state.lastReason = String(reason || 'network');
    state.lastUrl = offlineUrlForLog(url);
    state.probeInFlight = false;
    global.__mapTilerCooldownActive = true;
    mapTilerCooldownLog('MapTilerCooldown start reason=' + state.lastReason + ' url=' + state.lastUrl);
    mapTilerCooldownNotify(true);
  }

  function noteMapTilerFailure(reason, url) {
    const normalizedReason = String(reason || '').trim() || 'network';
    if (!/^(?:401|403|429|timeout|refused|network)$/i.test(normalizedReason)) return false;
    mapTilerCooldownStart(normalizedReason.toLowerCase(), url || 'https://api.maptiler.com/');
    return true;
  }

  function mapTilerCooldownClear() {
    const state = mapTilerCooldownState();
    if (state.unavailable || state.probeInFlight) mapTilerCooldownLog('MapTilerCooldown clear');
    state.unavailable = false;
    state.cooldownUntil = 0;
    state.lastReason = '';
    state.lastUrl = '';
    state.probeInFlight = false;
    global.__mapTilerCooldownActive = false;
    mapTilerCooldownNotify(false);
  }

  function mapTilerCooldownBlock(url) {
    const state = mapTilerCooldownState();
    const key = offlineUrlForLog(url);
    const now = Date.now();
    if (!state.blockLogByUrl[key] || now - state.blockLogByUrl[key] > 5000) {
      state.blockLogByUrl[key] = now;
      mapTilerCooldownLog('MapTilerCooldown block url=' + key);
    }
  }

  function mapTilerCooldownBeforeRequest(url) {
    if (!isMapTilerUrl(url)) return { isMapTiler: false, blocked: false, probe: false };
    const state = mapTilerCooldownState();
    const now = Date.now();
    if (state.probeInFlight) {
      mapTilerCooldownBlock(url);
      return { isMapTiler: true, blocked: true, probe: false };
    }
    if (state.unavailable && now < state.cooldownUntil) {
      mapTilerCooldownBlock(url);
      return { isMapTiler: true, blocked: true, probe: false };
    }
    if (state.unavailable) {
      state.probeInFlight = true;
      mapTilerCooldownLog('MapTilerCooldown probe');
      mapTilerCooldownNotify(true);
      return { isMapTiler: true, blocked: false, probe: true };
    }
    return { isMapTiler: true, blocked: false, probe: false };
  }

  function mapTilerResponseCooldownReason(response, isProbe) {
    if (!response) return isProbe ? 'network' : '';
    const status = Number(response.status || 0);
    if (status === 401 || status === 403 || status === 429) return String(status);
    if (isProbe && !response.ok) return String(status || 'http');
    return '';
  }

  function mapTilerNetworkCooldownReason(error) {
    if (error && error.__mapTilerTimedOut) return 'timeout';
    const name = String(error && error.name || '').toLowerCase();
    const message = String(error && error.message || error || '').toLowerCase();
    if (name.indexOf('abort') >= 0) return 'timeout';
    if (message.indexOf('timeout') >= 0) return 'timeout';
    if (message.indexOf('refused') >= 0 || message.indexOf('err_connection_refused') >= 0) return 'refused';
    return 'network';
  }

  function mapTilerCooldownFallbackResponse(url) {
    const captureActive = !!(global.__offlineMapState && global.__offlineMapState.captureActive);
    const unavailable = function (marker) {
      return new Response('MapTiler cooldown active', {
        status: 503,
        headers: {
          'Content-Type': 'text/plain; charset=utf-8',
          'Cache-Control': 'no-store',
          'Access-Control-Allow-Origin': '*',
          'X-MapTiler-Cooldown': marker
        }
      });
    };
    if (captureActive) {
      return unavailable('download-block');
    }
    offlineLogResourceBlockedBeforeLookup(url, false, 'cooldown');
    if (offlineIsStyleUrl(url)) return unavailable('style-block');
    if (offlineIsTileJsonUrl(url)) return unavailable('tilejson-block');
    if (offlineIsGlyphUrl(url)) return unavailable('glyph-block');
    if (offlineIsSpriteUrl(url)) return unavailable('sprite-block');
    if (/\.json(?:\?|$)/i.test(String(url || ''))) return unavailable('json-block');
    return unavailable('resource-block');
  }

  async function mapTilerFetchWithTimeout(input, init, upstreamFetch) {
    if (typeof AbortController === 'undefined') return await upstreamFetch.call(global, input, init);
    const controller = new AbortController();
    const requestInit = Object.assign({}, init || {}, { signal: controller.signal });
    const externalSignal = init && init.signal ? init.signal : null;
    let timedOut = false;
    let timeoutId = null;
    const abortFromExternal = function () {
      try { controller.abort(); } catch (error) {}
    };
    if (externalSignal) {
      if (externalSignal.aborted) abortFromExternal();
      else {
        try { externalSignal.addEventListener('abort', abortFromExternal); } catch (error) {}
      }
    }
    timeoutId = setTimeout(function () {
      timedOut = true;
      try { controller.abort(); } catch (error) {}
    }, MAPTILER_REMOTE_TIMEOUT_MS);
    try {
      return await upstreamFetch.call(global, input, requestInit);
    } catch (error) {
      error.__mapTilerTimedOut = timedOut;
      throw error;
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
      if (externalSignal) {
        try { externalSignal.removeEventListener('abort', abortFromExternal); } catch (error) {}
      }
    }
  }

  function serverCooldownState() {
    const state = global.__serverCooldownState || (global.__serverCooldownState = {});
    if (!state.blockLogByPath) state.blockLogByPath = {};
    state.unavailable = !!state.unavailable;
    state.cooldownUntil = Number(state.cooldownUntil || 0);
    state.failureCount = Number(state.failureCount || 0);
    state.probeInFlight = !!state.probeInFlight;
    return state;
  }

  function serverCooldownDelayMs(state) {
    const failures = Math.max(1, Number(state && state.failureCount || 1));
    return Math.min(SERVER_COOLDOWN_MAX_MS, SERVER_COOLDOWN_INITIAL_MS * Math.pow(2, failures - 1));
  }

  function serverCooldownStart(reason, path) {
    const state = serverCooldownState();
    const alreadyCooling = state.unavailable && Date.now() < Number(state.cooldownUntil || 0);
    if (!alreadyCooling) {
      state.failureCount = Math.max(0, Number(state.failureCount || 0)) + 1;
      state.cooldownUntil = Date.now() + serverCooldownDelayMs(state);
    }
    state.unavailable = true;
    state.lastReason = String(reason || 'network');
    state.probeInFlight = false;
    global.__mobileServerAvailable = false;
    if (!alreadyCooling) serverCooldownLog('ServerCooldown start reason=' + state.lastReason + (path ? ' path=' + path : ''));
  }

  function serverCooldownClear() {
    const state = serverCooldownState();
    if (state.unavailable || state.probeInFlight || state.failureCount) serverCooldownLog('ServerCooldown clear');
    state.unavailable = false;
    state.cooldownUntil = 0;
    state.failureCount = 0;
    state.lastReason = '';
    state.probeInFlight = false;
    global.__mobileServerAvailable = true;
  }

  function serverCooldownRemainingMs() {
    const state = serverCooldownState();
    if (!state.unavailable) return 0;
    return Math.max(0, Number(state.cooldownUntil || 0) - Date.now());
  }

  function serverCooldownBlock(path) {
    const state = serverCooldownState();
    const key = String(path || '/server');
    const now = Date.now();
    if (!state.blockLogByPath[key] || now - state.blockLogByPath[key] > 5000) {
      state.blockLogByPath[key] = now;
      serverCooldownLog('ServerCooldown block path=' + key);
    }
  }

  function serverCooldownBlocks(path) {
    const state = serverCooldownState();
    if (state.probeInFlight) {
      serverCooldownBlock(path);
      return true;
    }
    if (state.unavailable && Date.now() < state.cooldownUntil) {
      serverCooldownBlock(path);
      return true;
    }
    return false;
  }

  function serverCooldownBeginProbe() {
    const state = serverCooldownState();
    if (!state.unavailable) return true;
    if (state.probeInFlight) return false;
    if (Date.now() < state.cooldownUntil) return false;
    state.probeInFlight = true;
    serverCooldownLog('ServerCooldown probe');
    return true;
  }

  function serverCooldownFinishProbe() {
    const state = serverCooldownState();
    state.probeInFlight = false;
  }

  function serverCooldownNetworkReason(error, timedOut) {
    if (timedOut) return 'timeout';
    const name = String(error && error.name || '').toLowerCase();
    const message = String(error && error.message || error || '').toLowerCase();
    if (name.indexOf('abort') >= 0) return 'aborted';
    if (message.indexOf('timeout') >= 0) return 'timeout';
    if (message.indexOf('refused') >= 0 || message.indexOf('err_connection_refused') >= 0) return 'refused';
    return 'network';
  }

  function offlineNetworkBlocked() {
    return !!offlineModeActive || (typeof navigator !== 'undefined' && navigator.onLine === false);
  }

  function offlineUnavailableResponse(marker) {
    return new Response('Offline cache miss', {
      status: 503,
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-store',
        'Access-Control-Allow-Origin': '*',
        'X-Offline-Cache': marker || 'miss'
      }
    });
  }

  function offlineTileJsonFallbackResponse(url) {
    offlineIncrementDebugCounter('blockedOfflineNetworkRequests', 1);
    offlineLog('blocked offline network request', offlineUrlForLog(url));
    return offlineUnavailableResponse('tilejson-miss');
  }

  function arrayBufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer || new ArrayBuffer(0));
    let binary = '';
    const chunkSize = 0x8000;
    for (let i = 0; i < bytes.length; i += chunkSize) {
      const chunk = bytes.subarray(i, Math.min(i + chunkSize, bytes.length));
      binary += String.fromCharCode.apply(null, Array.prototype.slice.call(chunk));
    }
    return global.btoa(binary);
  }

  function base64ToUint8Array(base64) {
    const binary = global.atob(String(base64 || ''));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  async function readNativeOfflineMapResource(url) {
    const NativeOfflineMapDownload = getNativeOfflineMapDownloadPlugin();
    if (!NativeOfflineMapDownload || typeof NativeOfflineMapDownload.readCachedResource !== 'function') {
      return { found: false };
    }
    try {
      const result = await NativeOfflineMapDownload.readCachedResource({ url: url });
      if (!result || !result.found || !result.base64) return { found: false };
      return {
        found: true,
        mimeType: offlineNativeRuntimeMimeType(url, result.mimeType),
        bytes: base64ToUint8Array(result.base64)
      };
    } catch (error) {
      return { found: false, error: String(error && error.message || error || '') };
    }
  }

  async function offlineNativeRuntimeResponseForUrl(url) {
    const nativeRead = await readNativeOfflineMapResource(url);
    if (!nativeRead.found) {
      offlineResourceLog('OfflineNativeRuntimeMiss', url, 'kind=' + offlineNativeRuntimeResourceKind(url));
      return null;
    }
    offlineLog('OfflineNativeRuntimeHit', 'kind=' + offlineNativeRuntimeResourceKind(url) + ' url=' + offlineUrlForLog(url));
    offlineLog('OfflineRuntimeServedFromNative', offlineUrlForLog(url));
    offlineIncrementDebugCounter('cacheHits', 1);
    if (offlineIsGlyphUrl(url)) offlineIncrementDebugCounter('glyphCacheHits', 1);
    offlineLogResourceHit(url, offlineCanonicalUrl(url));
    return new Response(nativeRead.bytes, {
      status: 200,
      headers: {
        'Content-Type': nativeRead.mimeType,
        'X-Offline-Cache': 'native-runtime'
      }
    });
  }

  async function offlineCachedResponseForCanonical(canonical, requestedUrl) {
    try {
      const cachedTile = await idbGet(TILE_STORE, canonical);
      if (cachedTile) {
        offlineIncrementDebugCounter('cacheHits', 1);
        if (offlineIsGlyphUrl(canonical)) offlineIncrementDebugCounter('glyphCacheHits', 1);
        offlineLogResourceHit(requestedUrl || canonical, canonical);
        if (offlineIsTileUrl(canonical)) offlineLog('OfflineLocalTileHit', offlineUrlForLog(canonical));
        else if (!offlineIsTileJsonUrl(canonical) && !offlineIsGlyphUrl(canonical) && !offlineIsSpriteUrl(canonical)) offlineLog('OfflineLocalHit', offlineUrlForLog(canonical));
        return new Response(cachedTile, {
          status: 200,
          headers: { 'Content-Type': cachedTile.type || 'application/octet-stream', 'X-Offline-Cache': 'tile' }
        });
      }
      const cachedResource = await idbGet(RESOURCE_STORE, canonical);
      if (cachedResource && cachedResource.blob) {
        offlineIncrementDebugCounter('cacheHits', 1);
        if (offlineIsGlyphUrl(canonical)) offlineIncrementDebugCounter('glyphCacheHits', 1);
        offlineLogResourceHit(requestedUrl || canonical, canonical);
        if (offlineIsStyleUrl(canonical)) offlineLog('OfflineLocalStyleHit', offlineUrlForLog(canonical));
        else if (!offlineIsTileJsonUrl(canonical) && !offlineIsGlyphUrl(canonical) && !offlineIsSpriteUrl(canonical)) offlineLog('OfflineLocalHit', offlineUrlForLog(canonical));
        return new Response(cachedResource.blob, {
          status: 200,
          headers: { 'Content-Type': cachedResource.contentType || cachedResource.blob.type || 'application/octet-stream', 'X-Offline-Cache': 'resource' }
        });
      }
    } catch (error) {}
    return null;
  }

  async function offlineCachedResponseForUrl(url) {
    const candidates = offlineCacheLookupCandidates(url);
    const requestedCanonical = offlineCanonicalUrl(url);
    for (let i = 0; i < candidates.length; i += 1) {
      const cachedResponse = await offlineCachedResponseForCanonical(candidates[i], url);
      if (!cachedResponse) continue;
      if (candidates[i] !== requestedCanonical) {
        offlineLog('OfflineCacheAliasHit', 'requested=' + requestedCanonical + ' matched=' + candidates[i]);
      }
      return cachedResponse;
    }
    return null;
  }

  async function offlineCachedFetch(requestUrl, input, init, upstreamFetch) {
    const targetUrl = offlineTargetUrlForRequest(requestUrl);
    const canonical = offlineCanonicalUrl(targetUrl);
    const cachedResponse = await offlineCachedResponseForUrl(targetUrl);
    if (cachedResponse) {
      if (offlineIsMapTilerCriticalRuntimeResourceUrl(canonical)) {
        offlineLog('OfflineRuntimeServedFromIndexedDB', offlineUrlForLog(canonical));
      }
      return cachedResponse;
    }
    if (offlineIsMapTilerCriticalRuntimeResourceUrl(canonical)) {
      const nativeResponse = await offlineNativeRuntimeResponseForUrl(targetUrl);
      if (nativeResponse) return nativeResponse;
    }
    if (offlineIsTileJsonUrl(canonical) || offlineIsGlyphUrl(canonical) || offlineIsSpriteUrl(canonical)) {
      offlineLogResourceMiss(canonical);
    }
    const mapTilerDecision = mapTilerCooldownBeforeRequest(canonical);
    if (mapTilerDecision.blocked) {
      offlineIncrementDebugCounter('blockedOfflineNetworkRequests', 1);
      return mapTilerCooldownFallbackResponse(canonical);
    }
    if (offlineIsGlyphUrl(canonical)) {
      const knownMiss = offlineKnownRuntimeGlyphMiss(canonical);
      if (offlineIsUnsupportedGlyphRangeUrl(canonical) || offlineModeActive || knownMiss || (typeof navigator !== 'undefined' && navigator.onLine === false)) {
        if (isMapTilerUrl(canonical)) return mapTilerCooldownFallbackResponse(canonical);
        return offlineRuntimeGlyphFallbackResponse(canonical, knownMiss);
      }
      offlineIncrementDebugCounter('cacheMisses', 1);
      offlineIncrementDebugCounter('glyphCacheMisses', 1);
    } else {
      offlineIncrementDebugCounter('cacheMisses', 1);
      if (offlineIsTileJsonUrl(canonical)) {
        offlineLog('offline tilejson miss', offlineUrlForLog(canonical));
        if (offlineNetworkBlocked()) {
          if (isMapTilerUrl(canonical)) return mapTilerCooldownFallbackResponse(canonical);
          return offlineTileJsonFallbackResponse(targetUrl);
        }
      } else if (offlineIsTileUrl(canonical)) {
        offlineLog('offline tile miss', offlineUrlForLog(canonical));
      }
    }
    let response;
    try {
      response = mapTilerDecision.isMapTiler
        ? await mapTilerFetchWithTimeout(input, init, upstreamFetch)
        : await upstreamFetch.call(global, input, init);
    } catch (networkError) {
      offlineIncrementDebugCounter('httpErrors', 1);
      if (mapTilerDecision.isMapTiler) {
        mapTilerCooldownStart(mapTilerNetworkCooldownReason(networkError), canonical);
        offlineLogResourceMiss(canonical);
        return mapTilerCooldownFallbackResponse(canonical);
      }
      if (offlineIsGlyphUrl(canonical)) return offlineRuntimeGlyphFallbackResponse(canonical, offlineKnownRuntimeGlyphMiss(canonical));
      throw networkError;
    }
    if (mapTilerDecision.isMapTiler) {
      const cooldownReason = mapTilerResponseCooldownReason(response, mapTilerDecision.probe);
      if (cooldownReason) {
        offlineIncrementDebugCounter('httpErrors', 1);
        mapTilerCooldownStart(cooldownReason, canonical);
        offlineLogResourceMiss(canonical);
        return mapTilerCooldownFallbackResponse(canonical);
      }
      if (mapTilerDecision.probe) mapTilerCooldownClear();
    }
    if (!response || !response.ok) offlineIncrementDebugCounter('httpErrors', 1);
    else offlineIncrementDebugCounter('httpDownloads', 1);
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

  function fetchOfflineMapResource(url, init) {
    const requestInit = Object.assign({}, init || {});
    const cacheOnly = !!requestInit.offlineCacheOnly;
    delete requestInit.offlineCacheOnly;
    if (!offlineMapUpstreamFetch) return global.fetch(url, requestInit);
    if (!cacheOnly) return offlineCachedFetch(url, url, requestInit, offlineMapUpstreamFetch);
    const targetUrl = offlineTargetUrlForRequest(url);
    const canonical = offlineCanonicalUrl(targetUrl);
    return (async function () {
      const cachedResponse = await offlineCachedResponseForUrl(targetUrl);
      if (cachedResponse) {
        if (offlineIsMapTilerCriticalRuntimeResourceUrl(canonical)) {
          offlineLog('OfflineRuntimeServedFromIndexedDB', offlineUrlForLog(canonical));
        }
        return cachedResponse;
      }
      if (offlineIsMapTilerCriticalRuntimeResourceUrl(canonical)) {
        const nativeResponse = await offlineNativeRuntimeResponseForUrl(targetUrl);
        if (nativeResponse) return nativeResponse;
      }
      if (offlineIsTileJsonUrl(canonical) || offlineIsGlyphUrl(canonical) || offlineIsSpriteUrl(canonical)) offlineLogResourceMiss(canonical);
      if (isMapTilerUrl(canonical)) return mapTilerCooldownFallbackResponse(canonical);
      if (offlineIsGlyphUrl(canonical)) return offlineRuntimeGlyphFallbackResponse(canonical, offlineKnownRuntimeGlyphMiss(canonical));
      if (offlineIsTileJsonUrl(canonical)) return offlineTileJsonFallbackResponse(targetUrl);
      return new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store', 'X-Offline-Cache': 'miss' } });
    })();
  }

  async function hasNativeOfflineMapResource(url) {
    const NativeOfflineMapDownload = getNativeOfflineMapDownloadPlugin();
    if (!NativeOfflineMapDownload || typeof NativeOfflineMapDownload.hasUrl !== 'function') {
      return { available: false, source: 'native-unavailable' };
    }
    try {
      const result = await NativeOfflineMapDownload.hasUrl({ url: url });
      return { available: !!(result && result.cached), source: result && result.cached ? 'native' : 'native-miss' };
    } catch (error) {
      return { available: false, source: 'native-error', error: String(error && error.message || error || '') };
    }
  }

  async function ensureOfflineMapResourceInNative(url, opts) {
    opts = opts || {};
    const nativeState = await hasNativeOfflineMapResource(url);
    if (nativeState.available) return nativeState;
    const NativeOfflineMapDownload = getNativeOfflineMapDownloadPlugin();
    if (!NativeOfflineMapDownload || typeof NativeOfflineMapDownload.storeResource !== 'function') {
      return nativeState;
    }
    let response = null;
    try {
      response = await fetchOfflineMapResource(url, { offlineCacheOnly: true });
    } catch (error) {
      return { available: false, source: nativeState.source, cacheStatus: 0, error: String(error && error.message || error || '') };
    }
    if (!response || !response.ok) {
      return { available: false, source: nativeState.source, cacheStatus: response ? response.status : 0 };
    }
    try {
      const buffer = await response.arrayBuffer();
      const contentType = response.headers && typeof response.headers.get === 'function'
        ? String(response.headers.get('content-type') || '')
        : '';
      const stored = await NativeOfflineMapDownload.storeResource({
        url: url,
        contentType: contentType || (opts && opts.contentType) || '',
        base64: arrayBufferToBase64(buffer)
      });
      if (stored && stored.cached) return { available: true, source: 'indexeddb-to-native', size: stored.size || 0 };
      const recheck = await hasNativeOfflineMapResource(url);
      if (recheck.available) return { available: true, source: 'indexeddb-to-native-recheck' };
      return { available: false, source: 'native-store-failed', cacheStatus: response.status };
    } catch (error) {
      return { available: false, source: 'native-store-error', cacheStatus: response.status, error: String(error && error.message || error || '') };
    }
  }

  function offlineEmptyGlyphResponse(url) {
    return offlineUnavailableResponse('glyph-miss');
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
  const PREF_DRIVE_ENTER_SPEED_KMH = 'gpsDriveEnterSpeedKmh';
  const PREF_DRIVE_EXIT_SPEED_KMH = 'gpsDriveExitSpeedKmh';
  const PREF_DRIVE_CONFIRM_FIXES = 'gpsDriveConfirmFixes';
  const PREF_DRIVE_EXIT_HOLD_MS = 'gpsDriveExitHoldMs';
  const PREF_DRIVE_MIN_MOVE_M = 'gpsDriveMinMoveM';
  const PREF_BACKGROUND_UPLOAD = 'gpsBackgroundUploadEnabled';
  const PREF_SERVER_UPLOAD = 'gpsServerUploadEnabled';
  const PREF_SERVER_URL = 'gpsTrackingServerUrl';
  const PREF_MQTT_WS_URL = 'gpsTrackingMqttUrl';
  const DEFAULT_SERVER_BASE_URL = String(global.MOBILE_DEFAULT_SERVER_BASE_URL || '').trim();
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
  const PREF_SERVER_LIVE_HEADING = 'gpsServerLiveHeadingEnabled';
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
  const MAPTILER_KEY_FALLBACK = 'R1pXZ5w6lmOR4jqxjESj';
  const MAPTILER_COOLDOWN_MS = 5 * 60 * 1000;
  const MAPTILER_REMOTE_TIMEOUT_MS = 8000;
  const SERVER_COOLDOWN_INITIAL_MS = 45000;
  const SERVER_COOLDOWN_MAX_MS = 5 * 60 * 1000;
  const OFFLINE_REGIONS_CACHE_TTL_MS = 8000;
  const DEFAULT_IDLE_SEC = 2;
  const DEFAULT_MOVING_SEC = 0.5;
  const LOOP_TICK_MS = 200;
  const LOCAL_GPS_POLL_INTERVAL_MS = 250;
  const LOCAL_GPS_POLL_MAX_AGE_MS = 120;
  const LOCAL_GPS_POLL_TIMEOUT_MS = 3500;

  let deviceKey = '';
  let trackingActive = false;
  let backgroundWatcherId = null;
  let pointLoopTimer = null;
  let localWatchId = null;
  let localWatchStartToken = 0;
  let localPollTimer = null;
  let localGpsPollInFlight = false;
  let localGpsPermissionReady = false;
  let localGpsPermissionPromise = null;
  let sendInFlight = false;
  let lastSendMs = 0;
  let lastLiveSendMs = 0;
  let lastRouteSendMs = 0;
  let lastKeepaliveSendMs = 0;
  let serverLiveHeadingEnabled = false;
  let lastLat = null;
  let lastLon = null;
  const displayFilterState = { stablePoint: null, stationaryExitCount: 0 };
  const routeReductionState = { lastRoutePoint: null };
  let lastFinalLocalPoint = null;
  let latestCompassHeading = null;
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
  let driveModeActive = false;
  let driveConfirmStreak = 0;
  let driveExitSinceMs = 0;
  let lastMovementHoldHeading = null;
  let lastEffectiveHeading = { value: null, source: 'hold', mode: 'stationary' };
  let lastHeadingBurstMs = 0;
  let lastHeadingBurstHeading = null;
  let headingBurstInFlight = false;
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
  let serverAvailabilityCheckInFlight = false;
  let offlineRegionsCacheRecords = null;
  let offlineRegionsCacheAt = 0;

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
    headingFilterMapBearingDeadbandDeg: 6,
    driveEnterSpeedKmh: 10,
    driveExitSpeedKmh: 6,
    driveConfirmFixes: 3,
    driveExitHoldMs: 4000,
    driveMinMoveM: 1
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
    displaySettings.driveEnterSpeedKmh = clamp(await prefGet(PREF_DRIVE_ENTER_SPEED_KMH, 10), 5, 40, 10);
    displaySettings.driveExitSpeedKmh = clamp(await prefGet(PREF_DRIVE_EXIT_SPEED_KMH, 6), 3, 30, 6);
    displaySettings.driveConfirmFixes = clampInt(await prefGet(PREF_DRIVE_CONFIRM_FIXES, 3), 2, 6, 3);
    displaySettings.driveExitHoldMs = clampInt(await prefGet(PREF_DRIVE_EXIT_HOLD_MS, 4000), 1000, 15000, 4000);
    displaySettings.driveMinMoveM = clamp(await prefGet(PREF_DRIVE_MIN_MOVE_M, 1), 0.2, 20, 1);

    uploadSettings.idleSec = clamp(await prefGetWithLegacy(PREF_UPLOAD_IDLE_SEC, PREF_IDLE_SEC, DEFAULT_IDLE_SEC), 1, 3600, DEFAULT_IDLE_SEC);
    uploadSettings.movingSec = clamp(await prefGetWithLegacy(PREF_UPLOAD_MOVING_SEC, PREF_MOVING_SEC, DEFAULT_MOVING_SEC), 0.2, 60, DEFAULT_MOVING_SEC);
    uploadSettings.intervalMin = clamp(await prefGetWithLegacy(PREF_UPLOAD_INTERVAL_MIN, PREF_INTERVAL_MIN, 0), 0, 1440, 0);
    uploadSettings.headingBurstDeg = clamp(await prefGetWithLegacy(PREF_UPLOAD_HEADING_BURST_DEG, PREF_HEADING_BURST_DEG, 10), 3, 90, 10);
    uploadSettings.headingBurstSec = clamp(await prefGetWithLegacy(PREF_UPLOAD_HEADING_BURST_SEC, PREF_HEADING_BURST_SEC, 0.35), 0.15, 5, 0.35);

    const rawBackgroundUpload = await prefGet(PREF_BACKGROUND_UPLOAD, '1');
    backgroundUploadEnabled = String(rawBackgroundUpload) !== '0' && String(rawBackgroundUpload).toLowerCase() !== 'false';
    const rawServerUpload = await prefGet(PREF_SERVER_UPLOAD, '1');
    serverUploadEnabled = String(rawServerUpload) !== '0' && String(rawServerUpload).toLowerCase() !== 'false';
    const rawServerLiveHeading = await prefGet(PREF_SERVER_LIVE_HEADING, '0');
    serverLiveHeadingEnabled = String(rawServerLiveHeading) === '1' || String(rawServerLiveHeading).toLowerCase() === 'true';
    configuredServerUrl = String(await prefGet(PREF_SERVER_URL, '') || '').trim();
    configuredMqttWebSocketUrl = String(await prefGet(PREF_MQTT_WS_URL, '') || '').trim();
    try {
      trackingActive = String(localStorage.getItem(TRACKING_ACTIVE_STORAGE_KEY) || '0') === '1';
    } catch (error) {}
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
    resetHeadingStabilizerState(compassStabilizer);
    resetHeadingStabilizerState(movementStabilizer);
    resetDriveModeState();
    latestCompassHeading = null;
    lastRawCompassHeading = null;
    lastHeadingBurstHeading = null;
    lastHeadingBurstMs = 0;
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

  function resolveServerSendMode() {
    if (serverLiveHeadingEnabled && !trackingActive) return 'liveHeading';
    return 'interval';
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

  async function publishMqttPayload(payload, kind) {
    if (!payload || !serverUploadEnabled) return false;
    if (serverCooldownBlocks('/mqtt')) return false;
    if (!serverConnectAllowed()) return false;
    const client = await ensureMqttClient();
    if (!client || !client.connected) return false;
    const topic = payload._mqttTopic || mqttTopicForDevice();
    const wirePayload = attachUploadHeadingMetadata(Object.assign({}, payload), payload);
    delete wirePayload._mqttTopic;
    wirePayload.localTracking = !!trackingActive;
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
    if (serverCooldownBlocks('/mqtt')) return false;
    if (resolveServerSendMode() === 'liveHeading') return false;
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

  async function disableServerLiveHeadingForTracking() {
    if (!serverLiveHeadingEnabled) return;
    serverLiveHeadingEnabled = false;
    await prefSet(PREF_SERVER_LIVE_HEADING, '0');
    global.dispatchEvent(new CustomEvent('capacitor-server-live-heading-changed', {
      detail: { enabled: false, reason: 'tracking' }
    }));
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
    return String(global.MOBILE_MQTT_WS_URL || configuredMqttWebSocketUrl || configuredServerUrl || DEFAULT_SERVER_BASE_URL || '').trim();
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

  async function importNativeBufferedRoute() {
    const nativeUpload = nativeUploadPlugin();
    if (!nativeUpload || typeof nativeUpload.getBufferedRoute !== 'function') return false;
    try {
      const result = await nativeUpload.getBufferedRoute({});
      const nativeRoute = parseJsonArray(result && result.localRouteJson);
      const nativeQueue = parseJsonArray(result && result.queueJson);
      const nativeTrackingActive = result && result.tracking != null
        ? (!!result.tracking || trackingActive)
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
    if (serverCooldownBlocks('/mqtt')) return null;
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
          serverCooldownStart('mqtt_error', '/mqtt');
          try { client.end(true); } catch (error) {}
          finish(null);
        });
        client.on('close', function () {
          if (mqttClient === client && !client.connected) mqttClient = null;
          if (serverUploadEnabled) {
            dispatchTransportState({ connected: false, connecting: false, serverConfigured: !!mqttWebSocketUrl() });
          }
        });
        setTimeout(function () {
          if (!client.connected) serverCooldownStart('timeout', '/mqtt');
          finish(client.connected ? client : null);
        }, 5500);
      });
    }).catch(function () {
      serverCooldownStart('mqtt_error', '/mqtt');
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
    if (serverCooldownBlocks('/mqtt')) return;
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

  function publishHeadingBurstIfNeeded() {
    const finalStable = lastFinalLocalPoint || displayFilterState.stablePoint;
    if (!finalStable || latestCompassHeading == null || document.hidden) return;
    if (!serverLiveHeadingEnabled || trackingActive) return;
    if (driveModeActive || lastEffectiveHeading.mode === 'drive') return;
    const now = Date.now();
    if (headingDelta(latestCompassHeading, lastHeadingBurstHeading) < uploadSettings.headingBurstDeg) return;
    if (now - lastHeadingBurstMs < uploadSettings.headingBurstSec * 1000) return;
    if (headingBurstInFlight || !serverUploadEnabled) return;
    lastHeadingBurstMs = now;
    lastHeadingBurstHeading = latestCompassHeading;
    const point = Object.assign({}, finalStable, {
      heading: latestCompassHeading,
      headingSource: 'compass',
      headingMode: lastEffectiveHeading.mode || 'stationary',
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
      return publishLivePointToServer(enriched, true);
    }).catch(function () {}).finally(function () {
      headingBurstInFlight = false;
    });
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
      await loadSettings();
      await ensureDeviceKey();
      const Geolocation = plugins().Geolocation;
      if (!Geolocation || !(await ensureLocalGpsPermission())) {
        setStatus('Standortberechtigung fehlt');
        return null;
      }
      const requestTracking = options.tracking != null ? !!options.tracking : trackingActive;
      const localOnly = options.localOnly !== false;
      if (options.hardRefresh) {
        // Sehr harter Refresh (Lang-Druck): Glaettungs-/Filterzustand zuruecksetzen,
        // damit ein gestoerter/gecachter Fix nicht den neuen Fix verzerrt -> frische
        // rohe, gefilterte GPS-Daten wie nach einem Neustart.
        resetFilterStates();
      }
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
    return serverUploadEnabled && backgroundUploadEnabled && !serverCooldownBlocks('/mqtt');
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

  function clearLocalGpsWatchId(watchId) {
    const Geolocation = plugins().Geolocation;
    if (Geolocation && watchId != null && typeof Geolocation.clearWatch === 'function') {
      Promise.resolve(Geolocation.clearWatch({ id: watchId })).catch(function () {});
    }
  }

  function stopLocalGpsWatch() {
    localWatchStartToken += 1;
    clearLocalGpsWatchId(localWatchId);
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
    if (localGpsPollInFlight) return;
    localGpsPollInFlight = true;
    Geolocation.getCurrentPosition({
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
    stopLocalGpsPoll();
    pollLocalGpsOnce();
    localPollTimer = setInterval(pollLocalGpsOnce, LOCAL_GPS_POLL_INTERVAL_MS);
  }

  function startLocalGpsWatch() {
    if (document.hidden) return;
    const Geolocation = plugins().Geolocation;
    if (!Geolocation || typeof Geolocation.watchPosition !== 'function') return;
    const startToken = localWatchStartToken + 1;
    localWatchStartToken = startToken;
    clearLocalGpsWatchId(localWatchId);
    localWatchId = null;
    Promise.resolve(Geolocation.watchPosition({
      enableHighAccuracy: true,
      timeout: 8000,
      maximumAge: LOCAL_GPS_POLL_MAX_AGE_MS,
      minimumUpdateInterval: LOCAL_GPS_POLL_INTERVAL_MS
    }, function (position, error) {
      if (startToken !== localWatchStartToken) return;
      if (error || !position) return;
      publishLocalPoint(position).catch(function () {});
    })).then(function (watchId) {
      if (startToken !== localWatchStartToken || document.hidden) {
        clearLocalGpsWatchId(watchId);
        return;
      }
      if (localWatchId != null && localWatchId !== watchId) clearLocalGpsWatchId(localWatchId);
      localWatchId = watchId;
    }).catch(function () {
    });
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
    if (serverCooldownBlocks('/mqtt')) return;
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
    if (serverCooldownBlocks('/server')) return false;
    return !global.MOBILE_LOCAL_ASSETS || global.__mobileServerAvailable === true;
  }

  function connectServerTransportsIfAvailable() {
    if (serverCooldownBlocks('/mqtt')) return;
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
    const raw = String(configuredServerUrl || '').trim();
    if (raw) {
      try {
        const parsed = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : 'https://' + raw);
        if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
          return parsed.origin.replace(/\/$/, '');
        }
      } catch (error) {}
    }
    if (DEFAULT_SERVER_BASE_URL) return DEFAULT_SERVER_BASE_URL.replace(/\/$/, '');
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
    const probePath = '/mobile/api/bootstrap';
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
    if (serverCooldownBlocks(probePath)) {
      publishAvailability(false, 'cooldown');
      return false;
    }
    const cooldownWasUnavailable = !!serverCooldownState().unavailable;
    if (!serverCooldownBeginProbe()) {
      serverCooldownBlock(probePath);
      publishAvailability(false, 'cooldown');
      return false;
    }
    if (!(await isOnline().catch(function () { return false; }))) {
      publishAvailability(false, 'offline');
      mobileStartupLog('server unavailable', 'offline');
      if (cooldownWasUnavailable) serverCooldownStart('offline', probePath);
      return false;
    }
    serverAvailabilityCheckInFlight = true;
    let timeoutId = null;
    let timedOut = false;
    try {
      const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
      if (controller) {
        timeoutId = setTimeout(function () {
          timedOut = true;
          try { controller.abort(); } catch (error) {}
        }, 6000);
      }
      const response = await global.fetch(baseUrl + '/mobile/api/bootstrap?deviceKey=' + encodeURIComponent(deviceKey || ''), {
        cache: 'no-store',
        signal: controller ? controller.signal : undefined
      });
      if (response && response.ok) {
        serverCooldownClear();
        publishAvailability(true, 'connected');
        mobileStartupLog('server connected', baseUrl);
        return true;
      }
      publishAvailability(false, 'HTTP ' + (response ? response.status : 0));
      mobileStartupLog('server unavailable', baseUrl + ' HTTP ' + (response ? response.status : 0));
      serverFallbackLog('server unavailable', baseUrl);
      serverCooldownStart(String(response && response.status || 'http'), probePath);
      return false;
    } catch (error) {
      publishAvailability(false, error && error.message ? error.message : 'unknown');
      mobileStartupLog('server unavailable', baseUrl);
      serverFallbackLog('server unavailable', error && error.message ? error.message : String(error || 'unknown'));
      serverCooldownStart(serverCooldownNetworkReason(error, timedOut), probePath);
      return false;
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
      serverCooldownFinishProbe();
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
      headingBurstDeg: uploadSettings.headingBurstDeg,
      headingBurstSec: uploadSettings.headingBurstSec,
      driveEnterSpeedKmh: displaySettings.driveEnterSpeedKmh,
      driveExitSpeedKmh: displaySettings.driveExitSpeedKmh,
      driveConfirmFixes: displaySettings.driveConfirmFixes,
      driveExitHoldMs: displaySettings.driveExitHoldMs,
      driveMinMoveM: displaySettings.driveMinMoveM,
      serverLiveHeadingEnabled: serverLiveHeadingEnabled,
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
    trackingActive = !!active;
    try {
      localStorage.setItem(TRACKING_ACTIVE_STORAGE_KEY, trackingActive ? '1' : '0');
      if (!trackingActive) localStorage.setItem(TRACKING_STOPPED_AT_STORAGE_KEY, String(Date.now()));
      else localStorage.removeItem(TRACKING_STOPPED_AT_STORAGE_KEY);
    } catch (error) {}
    if (trackingActive && !wasTrackingActive) {
      await disableServerLiveHeadingForTracking();
      ensureTrackId(true);
      beginNewRouteSegment();
    } else if (!trackingActive && wasTrackingActive) {
      setRouteBreakPending(true);
      await flushUploadQueue(true);
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
        invalidateOfflineRegionsCache();
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
          settled = true;
          invalidateOfflineRegionsCache();
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
          settled = true;
          invalidateOfflineRegionsCache();
          cleanup();
          setStatus('Offline-Karten: Abgebrochen');
          const err = new Error('Abgebrochen');
          err.code = 'CANCELLED';
          err.completed = completedRecords.slice();
          reject(err);
        }),
        wireListener('error', function (event) {
          if (settled) return;
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

  function cloneOfflineRegionRecords(records) {
    return (Array.isArray(records) ? records : []).map(function (record) {
      return record && typeof record === 'object' ? Object.assign({}, record) : record;
    });
  }

  function invalidateOfflineRegionsCache() {
    offlineRegionsCacheRecords = null;
    offlineRegionsCacheAt = 0;
  }

  async function listOfflineRegions() {
    const now = Date.now();
    if (offlineRegionsCacheRecords && now - offlineRegionsCacheAt < OFFLINE_REGIONS_CACHE_TTL_MS) {
      return cloneOfflineRegionRecords(offlineRegionsCacheRecords);
    }
    const NativeOfflineMapDownload = getNativeOfflineMapDownloadPlugin();
    if (NativeOfflineMapDownload && typeof NativeOfflineMapDownload.listRegions === 'function') {
      try {
        const result = await NativeOfflineMapDownload.listRegions();
        const records = (result && Array.isArray(result.regions)) ? result.regions : [];
        records.sort(function (a, b) { return (b.createdAt || 0) - (a.createdAt || 0); });
        offlineRegionsCacheRecords = cloneOfflineRegionRecords(records);
        offlineRegionsCacheAt = Date.now();
        return cloneOfflineRegionRecords(offlineRegionsCacheRecords);
      } catch (error) { return []; }
    }
    try {
      const records = await idbGetAll(REGION_STORE);
      records.sort(function (a, b) { return (b.createdAt || 0) - (a.createdAt || 0); });
      offlineRegionsCacheRecords = cloneOfflineRegionRecords(records);
      offlineRegionsCacheAt = Date.now();
      return cloneOfflineRegionRecords(offlineRegionsCacheRecords);
    } catch (error) {
      return [];
    }
  }

  async function deleteOfflineRegion(regionId) {
    if (!regionId) throw new Error('Region-ID fehlt');
    const NativeOfflineMapDownload = getNativeOfflineMapDownloadPlugin();
    if (NativeOfflineMapDownload && typeof NativeOfflineMapDownload.deleteRegion === 'function') {
      try {
        const result = await NativeOfflineMapDownload.deleteRegion({ regionId: regionId });
        invalidateOfflineRegionsCache();
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
    try { return NativeOfflineMapDownload.cancelDownload({}); } catch (e) { return Promise.resolve({ cancelled: false }); }
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
    invalidateOfflineRegionsCache();
    return NativeOfflineMapDownload.resumeRegion({ regionId: regionId }).finally(invalidateOfflineRegionsCache);
  }

  function repairOfflineRegion(regionId) {
    const NativeOfflineMapDownload = getNativeOfflineMapDownloadPlugin();
    if (!NativeOfflineMapDownload || typeof NativeOfflineMapDownload.repairRegion !== 'function') return Promise.reject(new Error('Reparatur ist nur in der Mobile-App verfuegbar'));
    invalidateOfflineRegionsCache();
    return NativeOfflineMapDownload.repairRegion({ regionId: regionId }).finally(invalidateOfflineRegionsCache);
  }

  function recoverOfflineState() {
    const NativeOfflineMapDownload = getNativeOfflineMapDownloadPlugin();
    if (!NativeOfflineMapDownload || typeof NativeOfflineMapDownload.recoverOfflineState !== 'function') {
      return Promise.resolve({ recoveredJobs: 0, recoveredRegions: 0, resetTasks: 0 });
    }
    invalidateOfflineRegionsCache();
    return NativeOfflineMapDownload.recoverOfflineState({}).finally(invalidateOfflineRegionsCache).catch(function () {
      return { recoveredJobs: 0, recoveredRegions: 0, resetTasks: 0 };
    });
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
    invalidateOfflineRegionsCache();
    return NativeOfflineMapDownload.verifyOfflineIntegrity(regionId ? { regionId: regionId } : {}).finally(invalidateOfflineRegionsCache);
  }

  function repairStaleOfflineJobs() {
    const NativeOfflineMapDownload = getNativeOfflineMapDownloadPlugin();
    if (!NativeOfflineMapDownload || typeof NativeOfflineMapDownload.repairStaleJobs !== 'function') {
      return recoverOfflineState();
    }
    invalidateOfflineRegionsCache();
    return NativeOfflineMapDownload.repairStaleJobs({}).finally(invalidateOfflineRegionsCache);
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
        intervalMin: cfg.intervalMin,
        headingBurstDeg: cfg.headingBurstDeg,
        headingBurstSec: cfg.headingBurstSec,
        serverLiveHeadingEnabled: !!serverLiveHeadingEnabled
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
      if (data.serverLiveHeadingEnabled != null) {
        serverLiveHeadingEnabled = !!data.serverLiveHeadingEnabled;
      }
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
      serverUploadEnabled: serverUploadEnabled,
      serverLiveHeadingEnabled: serverLiveHeadingEnabled
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
    if (uploadData.serverLiveHeadingEnabled != null) {
      serverLiveHeadingEnabled = !!uploadData.serverLiveHeadingEnabled;
      if (trackingActive && serverLiveHeadingEnabled) {
        serverLiveHeadingEnabled = false;
      }
      await prefSet(PREF_SERVER_LIVE_HEADING, serverLiveHeadingEnabled ? '1' : '0');
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
      prefSet(PREF_DRIVE_ENTER_SPEED_KMH, displaySettings.driveEnterSpeedKmh),
      prefSet(PREF_DRIVE_EXIT_SPEED_KMH, displaySettings.driveExitSpeedKmh),
      prefSet(PREF_DRIVE_CONFIRM_FIXES, displaySettings.driveConfirmFixes),
      prefSet(PREF_DRIVE_EXIT_HOLD_MS, displaySettings.driveExitHoldMs),
      prefSet(PREF_DRIVE_MIN_MOVE_M, displaySettings.driveMinMoveM),
      prefSet(PREF_UPLOAD_IDLE_SEC, uploadSettings.idleSec),
      prefSet(PREF_UPLOAD_MOVING_SEC, uploadSettings.movingSec),
      prefSet(PREF_UPLOAD_INTERVAL_MIN, uploadSettings.intervalMin),
      prefSet(PREF_UPLOAD_HEADING_BURST_DEG, uploadSettings.headingBurstDeg),
      prefSet(PREF_UPLOAD_HEADING_BURST_SEC, uploadSettings.headingBurstSec),
      prefSet(PREF_SERVER_LIVE_HEADING, serverLiveHeadingEnabled ? '1' : '0'),
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
    const profile = await getProfileSettings();
    profile.oldDeviceKey = oldDeviceKey;
    return profile;
  }

  async function refreshNow() {
    await loadSettings();
    await importNativeBufferedRoute();
    await registerInitialPoint();
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
    if (serverUploadEnabled && serverConnectAllowed()) {
      connectServerTransportsIfAvailable();
    }
    const Network = plugins().Network;
    if (Network) {
      Network.addListener('networkStatusChange', function () { refreshNetworkMode(); });
    }
    global.addEventListener('online', refreshNetworkMode);
    global.addEventListener('offline', refreshNetworkMode);
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
        stoppedAt: stoppedAt
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
    fetchOfflineMapResource: fetchOfflineMapResource,
    hasNativeOfflineMapResource: hasNativeOfflineMapResource,
    ensureOfflineMapResourceInNative: ensureOfflineMapResourceInNative,
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
    isMapTilerCooldownActive: mapTilerCooldownActive,
    noteMapTilerFailure: noteMapTilerFailure,
    isServerCooldownActive: function () { return !!serverCooldownState().unavailable || !!serverCooldownState().probeInFlight; },
    getServerCooldownRemainingMs: serverCooldownRemainingMs,
    checkServerAvailability: checkServerAvailability,
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
