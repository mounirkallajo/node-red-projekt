package de.tracking.mobile.offlinemap;

import android.content.Context;
import android.net.ConnectivityManager;
import android.net.NetworkCapabilities;
import android.net.Uri;
import android.os.Build;
import android.util.Log;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;

import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeWebViewClient;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

public class OfflineMapWebViewClient extends BridgeWebViewClient {

    private static final String TAG = "OfflineMapWebView";
    private static final String[] INTERCEPT_HOSTS = new String[] {
        "api.maptiler.com",
        "tiles.openfreemap.org",
        "unpkg.com"
    };
    private static final long MAPTILER_COOLDOWN_MS = 5L * 60L * 1000L;
    private static final long MAPTILER_REMOTE_ALLOWED_MS = 60L * 1000L;
    private static final int MAPTILER_REMOTE_TIMEOUT_MS = 8000;
    private static final Object MAPTILER_LOCK = new Object();
    private static final Map<String, Long> mapTilerBlockLogByUrl = new HashMap<>();
    private static final Map<String, Long> offlineMissingLogByUrl = new HashMap<>();
    private static long mapTilerCooldownUntil = 0L;
    private static long mapTilerRemoteAllowedUntil = 0L;
    private static boolean mapTilerProbeInFlight = false;
    private static final byte[] TRANSPARENT_PNG = new byte[] {
        (byte) 0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A,
        0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52,
        0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
        0x08, 0x06, 0x00, 0x00, 0x00, 0x1F, 0x15, (byte) 0xC4,
        (byte) 0x89, 0x00, 0x00, 0x00, 0x0A, 0x49, 0x44, 0x41,
        0x54, 0x78, (byte) 0x9C, 0x63, 0x00, 0x01, 0x00, 0x00,
        0x05, 0x00, 0x01, 0x0D, 0x0A, 0x2D, (byte) 0xB4, 0x00,
        0x00, 0x00, 0x00, 0x49, 0x45, 0x4E, 0x44, (byte) 0xAE,
        0x42, 0x60, (byte) 0x82
    };

    private final Context appContext;

    public OfflineMapWebViewClient(Bridge bridge) {
        super(bridge);
        this.appContext = bridge.getContext().getApplicationContext();
    }

    @Override
    public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
        if (request != null && request.getUrl() != null) {
            String originalUrl = request.getUrl().toString();
            String url = targetUrlForRequest(originalUrl);
            if (shouldHandleUrl(url)) {
                WebResourceResponse cached = serveFromCache(url);
                if (cached != null) return cached;
                OfflineMapCacheStore store = OfflineMapCacheStore.getInstance(appContext);
                boolean online = isNetworkAvailable();
                boolean tileJson = isTileJsonUrl(url);
                boolean glyph = isGlyphUrl(url);
                boolean unsupportedGlyph = glyph && OfflineMapCacheStore.isUnsupportedGlyphRange(url);
                boolean knownRuntimeGlyphMiss = glyph && store.hasRuntimeGlyphMiss(url);
                if (isMapTilerUrl(url)) {
                    WebResourceResponse mapTilerResponse = handleMapTilerCacheMiss(
                        view,
                        request,
                        url,
                        store,
                        online,
                        tileJson,
                        glyph,
                        unsupportedGlyph,
                        knownRuntimeGlyphMiss
                    );
                    if (mapTilerResponse != null) return mapTilerResponse;
                }
                if (glyph && (unsupportedGlyph || !online || knownRuntimeGlyphMiss)) {
                    logOfflineResourceMiss(url);
                    return offlinePlaceholder(url, knownRuntimeGlyphMiss);
                }
                store.incrementDebugCounter("cacheMisses", 1L);
                if (glyph) store.incrementDebugCounter("glyphCacheMisses", 1L);
                if (tileJson) {
                    logOfflineResourceMiss(url);
                    if (!online) return offlineTileJsonPlaceholder(url);
                } else if (isSpriteUrl(url)) {
                    logOfflineResourceMiss(url);
                }
                if (!online && isTileUrl(url)) {
                    Log.i(TAG, "offline tile miss: " + urlForLog(url));
                    Log.i(TAG, "blocked offline network request: " + urlForLog(url));
                    return offlinePlaceholder(url, false);
                }
            }
        }
        return super.shouldInterceptRequest(view, request);
    }

    private WebResourceResponse handleMapTilerCacheMiss(
        WebView view,
        WebResourceRequest request,
        String url,
        OfflineMapCacheStore store,
        boolean online,
        boolean tileJson,
        boolean glyph,
        boolean unsupportedGlyph,
        boolean knownRuntimeGlyphMiss
    ) {
        store.incrementDebugCounter("cacheMisses", 1L);
        if (glyph) store.incrementDebugCounter("glyphCacheMisses", 1L);
        if (isTileJsonUrl(url) || isGlyphUrl(url) || isSpriteUrl(url)) {
            logOfflineResourceMiss(url);
        }
        if (glyph && (unsupportedGlyph || knownRuntimeGlyphMiss)) {
            return mapTilerUnavailableResponse((unsupportedGlyph ? "unsupported-glyph" : "runtime-glyph-miss"));
        }
        if (tileJson) {
            Log.i(TAG, "offline tilejson miss: " + urlForLog(url));
        } else if (isTileUrl(url)) {
            Log.i(TAG, "offline tile miss: " + urlForLog(url));
        }

        if (!online) {
            Log.i(TAG, "blocked offline network request: " + urlForLog(url));
            return blockedMapTilerPlaceholder(store, url, "offline", knownRuntimeGlyphMiss);
        }

        MapTilerRequestDecision decision = beginMapTilerRequest(url);
        if (decision.blocked) {
            return blockedMapTilerPlaceholder(store, url, "cooldown", knownRuntimeGlyphMiss);
        }

        try {
            RemoteResource remote = fetchRemoteMapTiler(request, url);
            if (isMapTilerCooldownStatus(remote.statusCode)) {
                store.incrementDebugCounter("httpErrors", 1L);
                startMapTilerCooldown(String.valueOf(remote.statusCode), url, view);
                return blockedMapTilerPlaceholder(store, url, "status-" + remote.statusCode, knownRuntimeGlyphMiss);
            }
            if (remote.statusCode >= 400) store.incrementDebugCounter("httpErrors", 1L);
            else store.incrementDebugCounter("httpDownloads", 1L);
            finishMapTilerRemoteSuccess(decision.probe, view, url);
            return remote.toWebResourceResponse();
        } catch (Exception e) {
            store.incrementDebugCounter("httpErrors", 1L);
            startMapTilerCooldown(mapTilerNetworkReason(e), url, view);
            return blockedMapTilerPlaceholder(store, url, "network", knownRuntimeGlyphMiss);
        } finally {
            if (decision.probe) finishMapTilerProbeIfPending();
        }
    }

    private static MapTilerRequestDecision beginMapTilerRequest(String url) {
        long now = System.currentTimeMillis();
        synchronized (MAPTILER_LOCK) {
            if (mapTilerProbeInFlight) {
                mapTilerCooldownBlock(url);
                return new MapTilerRequestDecision(true, false);
            }
            if (mapTilerCooldownUntil > now) {
                mapTilerCooldownBlock(url);
                return new MapTilerRequestDecision(true, false);
            }
            if (mapTilerRemoteAllowedUntil > now) {
                return new MapTilerRequestDecision(false, false);
            }
            boolean fromCooldown = mapTilerCooldownUntil > 0L;
            mapTilerProbeInFlight = true;
            if (fromCooldown) Log.i(TAG, "MapTilerCooldown probe");
            return new MapTilerRequestDecision(false, true);
        }
    }

    private static void finishMapTilerProbeIfPending() {
        synchronized (MAPTILER_LOCK) {
            mapTilerProbeInFlight = false;
        }
    }

    private static void finishMapTilerRemoteSuccess(boolean probe, WebView view, String url) {
        boolean clearCooldown = false;
        synchronized (MAPTILER_LOCK) {
            clearCooldown = mapTilerCooldownUntil > 0L;
            mapTilerCooldownUntil = 0L;
            mapTilerRemoteAllowedUntil = System.currentTimeMillis() + MAPTILER_REMOTE_ALLOWED_MS;
            if (probe) mapTilerProbeInFlight = false;
        }
        if (clearCooldown) {
            Log.i(TAG, "MapTilerCooldown clear");
            notifyJavascriptCooldownClear(view, url);
        }
    }

    private static void startMapTilerCooldown(String reason, String url, WebView view) {
        String safeReason = sanitizeCooldownReason(reason);
        boolean shouldLog;
        synchronized (MAPTILER_LOCK) {
            long now = System.currentTimeMillis();
            shouldLog = mapTilerCooldownUntil <= now;
            mapTilerCooldownUntil = now + MAPTILER_COOLDOWN_MS;
            mapTilerRemoteAllowedUntil = 0L;
            mapTilerProbeInFlight = false;
        }
        if (shouldLog) {
            Log.i(TAG, "MapTilerCooldown start reason=" + safeReason + " url=" + urlForLog(url));
        }
        notifyJavascriptCooldownStart(view, safeReason, url);
    }

    private static void mapTilerCooldownBlock(String url) {
        String key = urlForLog(url);
        long now = System.currentTimeMillis();
        Long last = mapTilerBlockLogByUrl.get(key);
        if (last == null || now - last.longValue() > 5000L) {
            mapTilerBlockLogByUrl.put(key, now);
            Log.i(TAG, "MapTilerCooldown block url=" + key);
        }
    }

    private WebResourceResponse blockedMapTilerPlaceholder(
        OfflineMapCacheStore store,
        String url,
        String marker,
        boolean knownRuntimeGlyphMiss
    ) {
        store.incrementDebugCounter("blockedOfflineNetworkRequests", 1L);
        logOfflineResourceBlockedBeforeLookup(url, false, marker);
        if (isStyleUrl(url)) return mapTilerUnavailableResponse(marker + "-style");
        if (isTileJsonUrl(url)) return mapTilerUnavailableResponse(marker + "-tilejson");
        if (isGlyphUrl(url)) {
            logOfflineResourceMiss(url);
            return mapTilerUnavailableResponse(marker + (knownRuntimeGlyphMiss ? "-runtime-glyph-miss" : "-glyph"));
        }
        if (isSpriteUrl(url)) {
            logOfflineResourceMiss(url);
            return mapTilerUnavailableResponse(marker + "-sprite");
        }
        if (isJsonUrl(url)) return mapTilerUnavailableResponse(marker + "-json");
        return mapTilerUnavailableResponse(marker + "-resource");
    }

    private WebResourceResponse mapTilerUnavailableResponse(String marker) {
        Map<String, String> headers = new HashMap<>();
        headers.put("Content-Type", "text/plain; charset=utf-8");
        headers.put("Cache-Control", "no-store");
        headers.put("Access-Control-Allow-Origin", "*");
        headers.put("X-MapTiler-Cooldown", marker);
        return new WebResourceResponse(
            "text/plain",
            "UTF-8",
            503,
            "Service Unavailable",
            headers,
            new ByteArrayInputStream("MapTiler cooldown active".getBytes(StandardCharsets.UTF_8))
        );
    }

    private static RemoteResource fetchRemoteMapTiler(WebResourceRequest request, String url) throws Exception {
        HttpURLConnection connection = null;
        try {
            connection = (HttpURLConnection) new URL(url).openConnection();
            connection.setConnectTimeout(MAPTILER_REMOTE_TIMEOUT_MS);
            connection.setReadTimeout(MAPTILER_REMOTE_TIMEOUT_MS);
            connection.setUseCaches(false);
            connection.setInstanceFollowRedirects(true);
            String method = request != null ? request.getMethod() : "GET";
            if (!"HEAD".equalsIgnoreCase(method)) method = "GET";
            connection.setRequestMethod(method);
            if (request != null && request.getRequestHeaders() != null) {
                for (Map.Entry<String, String> entry : request.getRequestHeaders().entrySet()) {
                    String name = entry.getKey();
                    String value = entry.getValue();
                    if (!shouldForwardRequestHeader(name, value)) continue;
                    connection.setRequestProperty(name, value);
                }
            }
            int statusCode = connection.getResponseCode();
            InputStream stream = statusCode >= 400 ? connection.getErrorStream() : connection.getInputStream();
            byte[] body = stream != null ? readStream(stream) : new byte[0];
            RemoteResource remote = new RemoteResource();
            remote.statusCode = statusCode;
            remote.reasonPhrase = connection.getResponseMessage();
            remote.contentType = connection.getContentType();
            remote.headers = responseHeaders(connection);
            remote.body = body;
            remote.fallbackContentType = guessContentTypeFromUrl(url);
            return remote;
        } finally {
            if (connection != null) connection.disconnect();
        }
    }

    private static boolean shouldForwardRequestHeader(String name, String value) {
        if (name == null || name.isEmpty() || value == null) return false;
        String lower = name.toLowerCase();
        return !lower.equals("host")
            && !lower.equals("connection")
            && !lower.equals("content-length")
            && !lower.equals("accept-encoding");
    }

    private static Map<String, String> responseHeaders(HttpURLConnection connection) {
        Map<String, String> headers = new HashMap<>();
        try {
            Map<String, List<String>> fields = connection.getHeaderFields();
            if (fields != null) {
                for (Map.Entry<String, List<String>> entry : fields.entrySet()) {
                    String name = entry.getKey();
                    List<String> values = entry.getValue();
                    if (name == null || values == null || values.isEmpty()) continue;
                    StringBuilder joined = new StringBuilder();
                    for (int i = 0; i < values.size(); i += 1) {
                        String value = values.get(i);
                        if (value == null || value.isEmpty()) continue;
                        if (joined.length() > 0) joined.append(", ");
                        joined.append(value);
                    }
                    if (joined.length() > 0) headers.put(name, joined.toString());
                }
            }
        } catch (Exception e) {}
        headers.put("Access-Control-Allow-Origin", "*");
        return headers;
    }

    private static byte[] readStream(InputStream stream) throws Exception {
        try {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buffer = new byte[8192];
            int read;
            while ((read = stream.read(buffer)) > 0) out.write(buffer, 0, read);
            return out.toByteArray();
        } finally {
            try { stream.close(); } catch (Exception ignored) {}
        }
    }

    private static boolean isMapTilerCooldownStatus(int statusCode) {
        return statusCode == 401 || statusCode == 403 || statusCode == 429;
    }

    private static String mapTilerNetworkReason(Exception error) {
        if (error instanceof java.net.SocketTimeoutException) return "timeout";
        String message = String.valueOf(error == null ? "" : error.getMessage()).toLowerCase();
        if (message.contains("timeout") || message.contains("timed out")) return "timeout";
        if (message.contains("refused") || message.contains("connection refused")) return "refused";
        return "network";
    }

    private static String sanitizeCooldownReason(String reason) {
        String raw = reason == null ? "" : reason.trim().toLowerCase();
        if (raw.equals("401") || raw.equals("403") || raw.equals("429") ||
            raw.equals("timeout") || raw.equals("refused") || raw.equals("network") ||
            raw.startsWith("status-")) {
            return raw;
        }
        return "network";
    }

    private static void notifyJavascriptCooldownStart(WebView view, String reason, String url) {
        if (view == null) return;
        final String js = "try{var b=window.CapacitorMobileBridge;"
            + "if(b&&typeof b.noteMapTilerFailure==='function'){b.noteMapTilerFailure("
            + jsString(reason) + "," + jsString(url)
            + ");}else{window.__mapTilerCooldownActive=true;}}catch(e){}";
        view.post(new Runnable() {
            @Override public void run() {
                try { view.evaluateJavascript(js, null); } catch (Exception ignored) {}
            }
        });
    }

    private static void notifyJavascriptCooldownClear(WebView view, String url) {
        if (view == null) return;
        final String js = "try{window.__mapTilerCooldownActive=false;"
            + "var s=window.__mapTilerCooldownState;if(s){s.unavailable=false;s.probeInFlight=false;"
            + "s.cooldownUntil=0;s.lastReason='';s.lastUrl='';}"
            + "window.dispatchEvent(new CustomEvent('maptiler-cooldown-change',{detail:{active:false,"
            + "cooldownUntil:0,probeInFlight:false,reason:'native-clear',url:" + jsString(url) + "}}));"
            + "}catch(e){}";
        view.post(new Runnable() {
            @Override public void run() {
                try { view.evaluateJavascript(js, null); } catch (Exception ignored) {}
            }
        });
    }

    private static String jsString(String value) {
        String raw = value == null ? "" : value;
        StringBuilder out = new StringBuilder(raw.length() + 2);
        out.append('"');
        for (int i = 0; i < raw.length(); i += 1) {
            char ch = raw.charAt(i);
            if (ch == '\\' || ch == '"') {
                out.append('\\').append(ch);
            } else if (ch == '\n') {
                out.append("\\n");
            } else if (ch == '\r') {
                out.append("\\r");
            } else if (ch == '\t') {
                out.append("\\t");
            } else if (ch < 32) {
                String hex = Integer.toHexString(ch);
                out.append("\\u");
                for (int pad = hex.length(); pad < 4; pad += 1) out.append('0');
                out.append(hex);
            } else {
                out.append(ch);
            }
        }
        out.append('"');
        return out.toString();
    }

    private static class MapTilerRequestDecision {
        final boolean blocked;
        final boolean probe;
        MapTilerRequestDecision(boolean blocked, boolean probe) {
            this.blocked = blocked;
            this.probe = probe;
        }
    }

    private static class RemoteResource {
        int statusCode;
        String reasonPhrase;
        String contentType;
        String fallbackContentType;
        Map<String, String> headers = new HashMap<>();
        byte[] body = new byte[0];

        WebResourceResponse toWebResourceResponse() {
            String mimeType = mimeTypeFromContentType(contentType);
            if (mimeType == null || mimeType.isEmpty()) mimeType = fallbackContentType;
            if (mimeType == null || mimeType.isEmpty()) mimeType = "application/octet-stream";
            String encoding = charsetFromContentType(contentType);
            if (encoding == null && isTextType(mimeType)) encoding = "UTF-8";
            String reason = reasonPhrase == null || reasonPhrase.isEmpty() ? defaultReasonPhrase(statusCode) : reasonPhrase;
            return new WebResourceResponse(
                mimeType,
                encoding,
                statusCode,
                reason,
                headers,
                new ByteArrayInputStream(body == null ? new byte[0] : body)
            );
        }
    }

    private String targetUrlForRequest(String url) {
        if (url == null) return "";
        try {
            Uri uri = Uri.parse(url);
            String path = uri.getPath();
            if (path != null && path.contains("_capacitor_http_interceptor_")) {
                String target = uri.getQueryParameter("u");
                if (target != null && !target.isEmpty()) return target;
                target = rawQueryParameter(uri.getEncodedQuery(), "u");
                if (target != null && !target.isEmpty()) return decodeRepeated(target);
            }
        } catch (Exception e) {}
        return url;
    }

    private static String rawQueryParameter(String query, String name) {
        if (query == null || query.isEmpty() || name == null || name.isEmpty()) return "";
        String[] parts = query.split("&");
        for (int i = 0; i < parts.length; i += 1) {
            String part = parts[i];
            int eq = part.indexOf('=');
            String key = eq >= 0 ? part.substring(0, eq) : part;
            if (name.equals(key)) return eq >= 0 ? part.substring(eq + 1) : "";
        }
        return "";
    }

    private boolean shouldHandleUrl(String url) {
        if (url == null) return false;
        for (int i = 0; i < INTERCEPT_HOSTS.length; i += 1) {
            if (url.contains("://" + INTERCEPT_HOSTS[i] + "/")) return true;
        }
        return false;
    }

    private WebResourceResponse serveFromCache(String url) {
        OfflineMapCacheStore store = OfflineMapCacheStore.getInstance(appContext);
        CacheHit hit = readCacheHit(store, url);
        if (hit == null) return null;
        store.incrementDebugCounter("cacheHits", 1L);
        if (isGlyphUrl(url)) store.incrementDebugCounter("glyphCacheHits", 1L);
        logOfflineResourceHit(url, hit.lookupUrl);
        if (isStyleUrl(url)) Log.i(TAG, "OfflineLocalStyleHit: " + urlForLog(url));
        else if (isTileUrl(url)) Log.i(TAG, "OfflineLocalTileHit: " + urlForLog(url));
        else if (!isTileJsonUrl(url) && !isGlyphUrl(url) && !isSpriteUrl(url)) Log.i(TAG, "OfflineLocalHit: " + urlForLog(url));
        if (!sameUrlForLog(url, hit.lookupUrl)) {
            Log.i(TAG, "OfflineCacheAliasHit requested=" + urlForLog(url)
                + " matched=" + urlForLog(hit.lookupUrl)
                + " requestedCanonical=" + canonicalForLog(url)
                + " matchedCanonical=" + canonicalForLog(hit.lookupUrl));
        }
        byte[] bytes = hit.bytes;
        String contentType = hit.contentType;
        if (contentType == null || contentType.isEmpty()) {
            contentType = guessContentTypeFromUrl(url);
        }
        String encoding = isTextType(contentType) ? "UTF-8" : null;
        Map<String, String> headers = new HashMap<>();
        headers.put("Cache-Control", "public, max-age=31536000");
        headers.put("Access-Control-Allow-Origin", "*");
        headers.put("X-Offline-Cache", "native-hit");
        WebResourceResponse response = new WebResourceResponse(
            contentType,
            encoding,
            200,
            "OK",
            headers,
            new ByteArrayInputStream(bytes)
        );
        return response;
    }

    private CacheHit readCacheHit(OfflineMapCacheStore store, String url) {
        CacheHit hit = readCacheCandidate(store, url);
        if (hit != null) return hit;
        String stripped = stripQueryAndFragment(url);
        if (!stripped.equals(url)) {
            hit = readCacheCandidate(store, stripped);
            if (hit != null) return hit;
        }
        if (isTileJsonUrl(url) || isGlyphUrl(url) || isSpriteUrl(url) || isStyleUrl(url)) {
            String alias = "";
            try { alias = store.findCachedUrlByCanonicalBase(url); } catch (Exception ignored) {}
            if (!alias.isEmpty() && !alias.equals(url) && !alias.equals(stripped)) {
                return readCacheCandidate(store, alias);
            }
        }
        return null;
    }

    private CacheHit readCacheCandidate(OfflineMapCacheStore store, String candidate) {
        if (candidate == null || candidate.isEmpty()) return null;
        if (!store.hasUrl(candidate)) return null;
        byte[] bytes = store.readBytes(candidate);
        if (bytes == null) return null;
        String contentType = store.readContentType(candidate);
        return new CacheHit(candidate, bytes, contentType);
    }

    private static class CacheHit {
        final String lookupUrl;
        final byte[] bytes;
        final String contentType;

        CacheHit(String lookupUrl, byte[] bytes, String contentType) {
            this.lookupUrl = lookupUrl;
            this.bytes = bytes;
            this.contentType = contentType;
        }
    }

    private WebResourceResponse offlineTileJsonPlaceholder(String url) {
        Log.i(TAG, "blocked offline network request: " + urlForLog(url));
        OfflineMapCacheStore.getInstance(appContext).incrementDebugCounter("blockedOfflineNetworkRequests", 1L);
        return offlineUnavailableResponse("tilejson-miss");
    }

    private WebResourceResponse offlineUnavailableResponse(String marker) {
        Map<String, String> headers = new HashMap<>();
        headers.put("Content-Type", "text/plain; charset=utf-8");
        headers.put("Cache-Control", "no-store");
        headers.put("Access-Control-Allow-Origin", "*");
        headers.put("X-Offline-Cache", marker);
        return new WebResourceResponse(
            "text/plain",
            "UTF-8",
            503,
            "Service Unavailable",
            headers,
            new ByteArrayInputStream("Offline cache miss".getBytes(StandardCharsets.UTF_8))
        );
    }

    private WebResourceResponse offlinePlaceholder(String url, boolean knownRuntimeGlyphMiss) {
        String contentType = guessContentTypeFromUrl(url);
        boolean glyph = isGlyphUrl(url);
        if (glyph) {
            logOfflineMissingGlyph(url);
            OfflineMapCacheStore.getInstance(appContext).recordRuntimeGlyphFallback(url, knownRuntimeGlyphMiss);
            return offlineUnavailableResponse("glyph-miss");
        } else if (isSpriteUrl(url)) {
            logOfflineMissingSprite(url);
            return offlineUnavailableResponse("sprite-miss");
        }
        byte[] body = contentType.equals("application/x-protobuf") ? new byte[0] : TRANSPARENT_PNG;
        if (body.length > 0 && !contentType.startsWith("image/")) contentType = "image/png";
        Map<String, String> headers = new HashMap<>();
        headers.put("Cache-Control", "no-store");
        headers.put("Access-Control-Allow-Origin", "*");
        headers.put("X-Offline-Cache", "native-placeholder");
        return new WebResourceResponse(
            contentType,
            null,
            200,
            "OK",
            headers,
            new ByteArrayInputStream(body)
        );
    }

    private boolean isNetworkAvailable() {
        try {
            ConnectivityManager manager = (ConnectivityManager) appContext.getSystemService(Context.CONNECTIVITY_SERVICE);
            if (manager == null) return false;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                NetworkCapabilities capabilities = manager.getNetworkCapabilities(manager.getActiveNetwork());
                return capabilities != null
                    && capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
                    && capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)
                    && (
                    capabilities.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) ||
                    capabilities.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) ||
                    capabilities.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET) ||
                    capabilities.hasTransport(NetworkCapabilities.TRANSPORT_VPN)
                );
            }
            android.net.NetworkInfo info = manager.getActiveNetworkInfo();
            return info != null && info.isConnected();
        } catch (Exception e) {
            return false;
        }
    }

    private static boolean isTileUrl(String url) {
        if (url == null) return false;
        String lower = url.toLowerCase();
        return lower.matches(".*\\/(\\d+)\\/(\\d+)\\/(\\d+)\\.(png|webp|jpg|jpeg|pbf)(\\?.*)?$");
    }

    private static boolean isMapTilerUrl(String url) {
        if (url == null) return false;
        try {
            return "api.maptiler.com".equals(Uri.parse(url).getHost());
        } catch (Exception e) {
            return url.contains("://api.maptiler.com/");
        }
    }

    private static boolean isJsonUrl(String url) {
        if (url == null) return false;
        String lower = url.toLowerCase();
        int q = lower.indexOf('?');
        if (q >= 0) lower = lower.substring(0, q);
        return lower.endsWith(".json");
    }

    private static boolean isTileJsonUrl(String url) {
        if (url == null) return false;
        String lower = url.toLowerCase();
        return lower.matches(".*\\/tiles\\/[^?#]+\\/tiles\\.json(\\?.*)?$");
    }

    private static boolean isStyleUrl(String url) {
        if (url == null) return false;
        String lower = url.toLowerCase();
        return lower.matches(".*\\/maps\\/[^?#]+\\/style\\.json(\\?.*)?$");
    }

    private static boolean isGlyphUrl(String url) {
        if (url == null) return false;
        String lower = url.toLowerCase();
        return lower.matches(".*\\/fonts\\/[^?#]+\\/\\d+-\\d+\\.pbf(\\?.*)?$");
    }

    private static boolean isSpriteUrl(String url) {
        if (url == null) return false;
        String lower = url.toLowerCase();
        return lower.matches(".*\\/sprite(?:@2x)?\\.(json|png)(\\?.*)?$");
    }

    private static String glyphFontStackFromUrl(String url) {
        if (url == null || url.isEmpty()) return "";
        try {
            int fonts = url.indexOf("/fonts/");
            if (fonts < 0) return "";
            int stackStart = fonts + "/fonts/".length();
            int stackEnd = url.indexOf('/', stackStart);
            if (stackEnd <= stackStart) return "";
            return decodeRepeated(url.substring(stackStart, stackEnd));
        } catch (Exception e) {
            return "";
        }
    }

    private static String glyphRangeFromUrl(String url) {
        if (url == null || url.isEmpty()) return "";
        try {
            int pbf = url.indexOf(".pbf");
            if (pbf < 0) return "";
            int slash = url.lastIndexOf('/', pbf);
            if (slash < 0 || slash + 1 >= pbf) return "";
            return url.substring(slash + 1, pbf);
        } catch (Exception e) {
            return "";
        }
    }

    private static String glyphLabelFromUrl(String url) {
        String font = glyphFontStackFromUrl(url);
        String range = glyphRangeFromUrl(url);
        if (font.isEmpty() && range.isEmpty()) return "font=? range=?";
        return "font=" + (font.isEmpty() ? "?" : font) + " range=" + (range.isEmpty() ? "?" : range);
    }

    private static String spriteLabelFromUrl(String url) {
        if (url == null || url.isEmpty()) return "sprite=?";
        try {
            Uri uri = Uri.parse(url);
            String path = uri.getPath();
            if (path == null || path.isEmpty()) return "sprite=?";
            int slash = path.lastIndexOf('/');
            return "sprite=" + (slash >= 0 ? path.substring(slash + 1) : path);
        } catch (Exception e) {
            return "sprite=?";
        }
    }

    private static void logOfflineResourceHit(String url, String lookupUrl) {
        if (isTileJsonUrl(url)) {
            Log.i(TAG, "OfflineTileJsonHit url=" + urlForLog(url) + " canonical=" + canonicalForLog(lookupUrl));
        } else if (isGlyphUrl(url)) {
            Log.i(TAG, "OfflineGlyphHit " + glyphLabelFromUrl(url) + " url=" + urlForLog(url) + " canonical=" + canonicalForLog(lookupUrl));
        } else if (isSpriteUrl(url)) {
            Log.i(TAG, "OfflineSpriteHit " + spriteLabelFromUrl(url) + " url=" + urlForLog(url) + " canonical=" + canonicalForLog(lookupUrl));
        }
    }

    private static void logOfflineResourceMiss(String url) {
        if (isTileJsonUrl(url)) {
            logOfflineMissing("OfflineTileJsonMiss", url, "canonical=" + canonicalForLog(url));
        } else if (isGlyphUrl(url)) {
            logOfflineMissing("OfflineGlyphMiss", url, glyphLabelFromUrl(url) + " canonical=" + canonicalForLog(url));
        } else if (isSpriteUrl(url)) {
            logOfflineMissing("OfflineSpriteMiss", url, spriteLabelFromUrl(url) + " canonical=" + canonicalForLog(url));
        }
    }

    private static void logOfflineResourceBlockedBeforeLookup(String url, boolean blockedBeforeLookup, String reason) {
        String marker = "";
        String detail = "blockedBeforeLookup=" + (blockedBeforeLookup ? "true" : "false")
            + " reason=" + String.valueOf(reason == null ? "" : reason);
        if (isTileJsonUrl(url)) marker = "OfflineTileJsonBlockedBeforeLookup";
        else if (isGlyphUrl(url)) {
            marker = "OfflineGlyphBlockedBeforeLookup";
            detail += " " + glyphLabelFromUrl(url);
        } else if (isSpriteUrl(url)) {
            marker = "OfflineSpriteBlockedBeforeLookup";
            detail += " " + spriteLabelFromUrl(url);
        }
        if (!marker.isEmpty()) logOfflineMissing(marker, url, detail + " canonical=" + canonicalForLog(url));
    }

    private static void logOfflineMissingGlyph(String url) {
        logOfflineResourceMiss(url);
    }

    private static void logOfflineMissingSprite(String url) {
        logOfflineResourceMiss(url);
    }

    private static void logOfflineMissing(String marker, String url, String detail) {
        String key = marker + "|" + urlForLog(url);
        long now = System.currentTimeMillis();
        synchronized (MAPTILER_LOCK) {
            Long last = offlineMissingLogByUrl.get(key);
            if (last != null && now - last.longValue() <= 10000L) return;
            offlineMissingLogByUrl.put(key, now);
        }
        Log.i(TAG, marker + " " + detail + " url=" + urlForLog(url));
    }

    private static boolean sameUrlForLog(String a, String b) {
        return canonicalForLog(a).equals(canonicalForLog(b));
    }

    private static String canonicalForLog(String url) {
        try {
            return OfflineMapCacheStore.canonicalKey(url);
        } catch (Exception e) {
            return stripQueryAndFragment(url);
        }
    }

    private static String stripQueryAndFragment(String url) {
        if (url == null) return "";
        int end = url.indexOf('#');
        String out = end >= 0 ? url.substring(0, end) : url;
        int queryStart = out.indexOf('?');
        return queryStart >= 0 ? out.substring(0, queryStart) : out;
    }

    private static String decodeRepeated(String value) {
        String out = value == null ? "" : value;
        for (int i = 0; i < 2; i += 1) {
            try {
                String next = URLDecoder.decode(out, StandardCharsets.UTF_8.name());
                if (next.equals(out)) break;
                out = next;
            } catch (Exception e) {
                break;
            }
        }
        return out;
    }

    private static String urlForLog(String url) {
        if (url == null) return "";
        try {
            return Uri.parse(url).buildUpon().clearQuery().build().toString();
        } catch (Exception e) {
            int q = url.indexOf('?');
            return q >= 0 ? url.substring(0, q) : url;
        }
    }

    private static boolean isTextType(String contentType) {
        if (contentType == null) return false;
        String lower = contentType.toLowerCase();
        return lower.startsWith("text/") || lower.contains("json") || lower.contains("xml");
    }

    private static String mimeTypeFromContentType(String contentType) {
        if (contentType == null) return "";
        int semi = contentType.indexOf(';');
        String mime = semi >= 0 ? contentType.substring(0, semi) : contentType;
        return mime.trim();
    }

    private static String charsetFromContentType(String contentType) {
        if (contentType == null) return null;
        String[] parts = contentType.split(";");
        for (int i = 1; i < parts.length; i += 1) {
            String part = parts[i].trim();
            int eq = part.indexOf('=');
            if (eq <= 0) continue;
            String key = part.substring(0, eq).trim();
            if (!"charset".equalsIgnoreCase(key)) continue;
            String value = part.substring(eq + 1).trim();
            if (value.startsWith("\"") && value.endsWith("\"") && value.length() >= 2) {
                value = value.substring(1, value.length() - 1);
            }
            return value.isEmpty() ? null : value;
        }
        return null;
    }

    private static String defaultReasonPhrase(int statusCode) {
        if (statusCode == 200) return "OK";
        if (statusCode == 204) return "No Content";
        if (statusCode == 400) return "Bad Request";
        if (statusCode == 401) return "Unauthorized";
        if (statusCode == 403) return "Forbidden";
        if (statusCode == 404) return "Not Found";
        if (statusCode == 429) return "Too Many Requests";
        if (statusCode >= 500) return "Server Error";
        return "HTTP " + statusCode;
    }

    private static String guessContentTypeFromUrl(String url) {
        if (url == null) return "application/octet-stream";
        String lower = url.toLowerCase();
        int q = lower.indexOf('?');
        if (q >= 0) lower = lower.substring(0, q);
        if (lower.endsWith(".pbf")) return "application/x-protobuf";
        if (lower.endsWith(".png")) return "image/png";
        if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
        if (lower.endsWith(".webp")) return "image/webp";
        if (lower.endsWith(".json")) return "application/json";
        if (lower.endsWith(".js")) return "application/javascript";
        if (lower.endsWith(".css")) return "text/css";
        return "application/octet-stream";
    }
}
