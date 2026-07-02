package de.tracking.mobile.offlinemap;

import android.content.Context;
import android.net.ConnectivityManager;
import android.net.NetworkCapabilities;
import android.net.Uri;
import android.os.Build;
import android.util.Log;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;

import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeWebViewClient;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Map;

public class OfflineMapWebViewClient extends BridgeWebViewClient {

    private static final String TAG = "OfflineMapWebView";
    private static final String[] INTERCEPT_HOSTS = new String[] {
        "api.maptiler.com",
        "tiles.openfreemap.org",
        "unpkg.com"
    };
    private static final long MAPTILER_TILE_COOLDOWN_NETWORK_MS = 60 * 1000L;
    private static final long MAPTILER_TILE_COOLDOWN_FORBIDDEN_MS = 5 * 60 * 1000L;
    private static final long MAPTILER_TILE_PROBE_TIMEOUT_MS = 15 * 1000L;
    private static long mapTilerTileCooldownUntilMs = 0L;
    private static boolean mapTilerTileProbeInFlight = false;
    private static long mapTilerTileProbeStartedAtMs = 0L;
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
                boolean mapTilerVectorTile = isMapTilerVectorTileUrl(url);
                if (mapTilerVectorTile && !online) {
                    startMapTilerTileCooldown("network", url, MAPTILER_TILE_COOLDOWN_NETWORK_MS);
                    return offlinePlaceholder(url, false);
                }
                if (mapTilerVectorTile && mapTilerTileCooldownBlocks(url)) {
                    return offlinePlaceholder(url, false);
                }
                boolean tileJson = isTileJsonUrl(url);
                boolean glyph = isGlyphUrl(url);
                boolean unsupportedGlyph = glyph && OfflineMapCacheStore.isUnsupportedGlyphRange(url);
                boolean knownRuntimeGlyphMiss = glyph && store.hasRuntimeGlyphMiss(url);
                if (glyph && (unsupportedGlyph || !online || knownRuntimeGlyphMiss)) {
                    return offlinePlaceholder(url, knownRuntimeGlyphMiss);
                }
                store.incrementDebugCounter("cacheMisses", 1L);
                if (glyph) store.incrementDebugCounter("glyphCacheMisses", 1L);
                if (tileJson) {
                    Log.i(TAG, "offline tilejson miss: " + urlForLog(url));
                    if (!online) return offlineTileJsonPlaceholder(url);
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

    @Override
    public void onReceivedHttpError(WebView view, WebResourceRequest request, WebResourceResponse errorResponse) {
        if (request != null && request.getUrl() != null && errorResponse != null) {
            String url = targetUrlForRequest(request.getUrl().toString());
            if (isMapTilerVectorTileUrl(url) && errorResponse.getStatusCode() == 403) {
                startMapTilerTileCooldown("403", url, MAPTILER_TILE_COOLDOWN_FORBIDDEN_MS);
            }
        }
        super.onReceivedHttpError(view, request, errorResponse);
    }

    @Override
    public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
        if (request != null && request.getUrl() != null && isMapTilerVectorTileUrl(targetUrlForRequest(request.getUrl().toString()))) {
            startMapTilerTileCooldown("network", targetUrlForRequest(request.getUrl().toString()), MAPTILER_TILE_COOLDOWN_NETWORK_MS);
        }
        super.onReceivedError(view, request, error);
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
        if (!store.hasUrl(url)) return null;
        byte[] bytes = store.readBytes(url);
        if (bytes == null) return null;
        store.incrementDebugCounter("cacheHits", 1L);
        if (isGlyphUrl(url)) store.incrementDebugCounter("glyphCacheHits", 1L);
        if (isStyleUrl(url)) Log.i(TAG, "OfflineLocalStyleHit: " + urlForLog(url));
        else if (isTileUrl(url)) Log.i(TAG, "OfflineLocalTileHit: " + urlForLog(url));
        else Log.i(TAG, "OfflineLocalHit: " + urlForLog(url));
        String contentType = store.readContentType(url);
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

    private WebResourceResponse offlineTileJsonPlaceholder(String url) {
        Log.i(TAG, "blocked offline network request: " + urlForLog(url));
        Log.i(TAG, "offline tilejson fallback: " + urlForLog(url));
        OfflineMapCacheStore.getInstance(appContext).incrementDebugCounter("blockedOfflineNetworkRequests", 1L);
        Map<String, String> headers = new HashMap<>();
        headers.put("Cache-Control", "no-store");
        headers.put("Access-Control-Allow-Origin", "*");
        headers.put("X-Offline-Cache", "tilejson-placeholder");
        return new WebResourceResponse(
            "application/json",
            "UTF-8",
            200,
            "OK",
            headers,
            new ByteArrayInputStream(tileJsonBody(url))
        );
    }

    private WebResourceResponse offlinePlaceholder(String url, boolean knownRuntimeGlyphMiss) {
        String contentType = guessContentTypeFromUrl(url);
        boolean glyph = isGlyphUrl(url);
        if (glyph) {
            OfflineMapCacheStore.getInstance(appContext).recordRuntimeGlyphFallback(url, knownRuntimeGlyphMiss);
        }
        byte[] body = glyph ? emptyGlyphPbf(url) : (contentType.equals("application/x-protobuf") ? new byte[0] : TRANSPARENT_PNG);
        if (body.length > 0 && !contentType.startsWith("image/")) contentType = "image/png";
        if (glyph) contentType = "application/x-protobuf";
        Map<String, String> headers = new HashMap<>();
        headers.put("Cache-Control", "no-store");
        headers.put("Access-Control-Allow-Origin", "*");
        headers.put("X-Offline-Cache", glyph ? "glyph-placeholder" : "native-placeholder");
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

    private static boolean isMapTilerVectorTileUrl(String url) {
        if (url == null) return false;
        try {
            Uri uri = Uri.parse(url);
            String scheme = uri.getScheme();
            String host = uri.getHost();
            String path = uri.getPath();
            return "https".equalsIgnoreCase(scheme)
                && "api.maptiler.com".equalsIgnoreCase(host)
                && path != null
                && path.toLowerCase().matches("^/tiles/v3/\\d+/\\d+/\\d+\\.pbf$");
        } catch (Exception e) {
            return false;
        }
    }

    private static synchronized boolean mapTilerTileCooldownBlocks(String url) {
        long now = System.currentTimeMillis();
        if (mapTilerTileProbeInFlight) {
            if (now - mapTilerTileProbeStartedAtMs >= MAPTILER_TILE_PROBE_TIMEOUT_MS) {
                clearMapTilerTileCooldown(url);
                return false;
            }
            Log.i(TAG, "MapTilerTileCooldownBlock url=" + urlForLog(url));
            return true;
        }
        if (mapTilerTileCooldownUntilMs > now) {
            Log.i(TAG, "MapTilerTileCooldownBlock url=" + urlForLog(url));
            return true;
        }
        if (mapTilerTileCooldownUntilMs > 0L) {
            mapTilerTileCooldownUntilMs = 0L;
            mapTilerTileProbeInFlight = true;
            mapTilerTileProbeStartedAtMs = now;
            Log.i(TAG, "MapTilerTileCooldownProbe url=" + urlForLog(url));
        }
        return false;
    }

    private static synchronized void startMapTilerTileCooldown(String reason, String url, long durationMs) {
        long now = System.currentTimeMillis();
        mapTilerTileCooldownUntilMs = Math.max(mapTilerTileCooldownUntilMs, now + durationMs);
        mapTilerTileProbeInFlight = false;
        mapTilerTileProbeStartedAtMs = 0L;
        Log.i(TAG, "MapTilerTileCooldownStart reason=" + reason + " url=" + urlForLog(url));
    }

    private static synchronized void clearMapTilerTileCooldown(String url) {
        boolean wasActive = mapTilerTileCooldownUntilMs > 0L || mapTilerTileProbeInFlight;
        mapTilerTileCooldownUntilMs = 0L;
        mapTilerTileProbeInFlight = false;
        mapTilerTileProbeStartedAtMs = 0L;
        if (wasActive) {
            Log.i(TAG, "MapTilerTileCooldownClear url=" + urlForLog(url));
        }
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

    private static byte[] tileJsonBody(String url) {
        String tileSet = "v3";
        String key = "";
        try {
            Uri uri = Uri.parse(url);
            java.util.List<String> segments = uri.getPathSegments();
            for (int i = 0; i + 1 < segments.size(); i += 1) {
                if ("tiles".equals(segments.get(i))) {
                    tileSet = segments.get(i + 1);
                    break;
                }
            }
            String keyParam = uri.getQueryParameter("key");
            if (keyParam == null || keyParam.isEmpty()) keyParam = uri.getQueryParameter("apikey");
            if (keyParam == null || keyParam.isEmpty()) keyParam = uri.getQueryParameter("access_token");
            if (keyParam != null) key = keyParam;
        } catch (Exception e) {}
        String tileUrl = "https://api.maptiler.com/tiles/" + tileSet + "/{z}/{x}/{y}.pbf" + (key.isEmpty() ? "" : "?key=" + Uri.encode(key));
        String json = "{"
            + "\"tilejson\":\"2.2.0\","
            + "\"name\":\"offline-" + escapeJson(tileSet) + "\","
            + "\"version\":\"1.0.0\","
            + "\"scheme\":\"xyz\","
            + "\"type\":\"overlay\","
            + "\"format\":\"pbf\","
            + "\"minzoom\":0,"
            + "\"maxzoom\":14,"
            + "\"tiles\":[\"" + escapeJson(tileUrl) + "\"]"
            + "}";
        return json.getBytes(StandardCharsets.UTF_8);
    }

    private static byte[] emptyGlyphPbf(String url) {
        String fontstack = glyphFontStackFromUrl(url);
        if (fontstack.isEmpty()) return new byte[0];
        byte[] name = fontstack.getBytes(StandardCharsets.UTF_8);
        ByteArrayOutputStream inner = new ByteArrayOutputStream(name.length + 8);
        inner.write(0x0A);
        writeVarint(inner, name.length);
        inner.write(name, 0, name.length);
        byte[] innerBytes = inner.toByteArray();
        ByteArrayOutputStream outer = new ByteArrayOutputStream(innerBytes.length + 8);
        outer.write(0x0A);
        writeVarint(outer, innerBytes.length);
        outer.write(innerBytes, 0, innerBytes.length);
        return outer.toByteArray();
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

    private static void writeVarint(ByteArrayOutputStream out, int value) {
        int v = value;
        while (v >= 0x80) {
            out.write((v & 0x7F) | 0x80);
            v >>>= 7;
        }
        out.write(v);
    }

    private static String escapeJson(String value) {
        return String.valueOf(value == null ? "" : value)
            .replace("\\", "\\\\")
            .replace("\"", "\\\"");
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
