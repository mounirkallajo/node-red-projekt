package de.tracking.mobile.offlinemap;

import android.content.Context;
import android.content.SharedPreferences;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Iterator;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

public class OfflineMapCacheStore {

    private static final String CACHE_DIR = "offline_map_cache";
    private static final String REGIONS_DIR = "offline_map_regions";
    private static final String PLANS_DIR = "offline_map_region_plans";
    private static final String JOBS_DIR = "offline_map_download_jobs";
    private static final String TASKS_DIR = "offline_map_tile_tasks";
    private static final String DOWNLOAD_QUEUE_DIR = "offline_map_download_queue";
    private static final String DEBUG_PREFS_NAME = "offline_map_debug_counters";
    private static final String[] DEBUG_COUNTER_KEYS = new String[] {
        "cacheHits",
        "cacheMisses",
        "glyphCacheHits",
        "glyphCacheMisses",
        "glyphFallbackServed",
        "glyphRuntimeMisses",
        "glyphRuntimeMissSuppressed",
        "blockedOfflineNetworkRequests",
        "httpDownloads",
        "httpErrors",
        "skippedAlreadyPresent",
        "errorHttp429",
        "errorHttp403",
        "errorHttp404",
        "errorTimeout",
        "errorConnectionReset",
        "errorStorage",
        "errorTileTooLarge",
        "errorEmptyResponse",
        "errorUnknown"
    };
    private static final String[] TIMING_KEYS = new String[] {
        "httpDownload",
        "fileWrite",
        "cacheLookup",
        "taskPersistence",
        "verify"
    };

    private final Context appContext;
    private final File cacheDir;
    private final File regionsDir;
    private final File plansDir;
    private final File jobsDir;
    private final File tasksDir;
    private final File queueDir;
    private final Map<String, Long> timingMsByKey = new HashMap<>();
    private final Map<String, Long> timingCountByKey = new HashMap<>();
    private static volatile OfflineMapCacheStore singletonInstance = null;
    private static final Object lock = new Object();

    public static OfflineMapCacheStore getInstance(Context context) {
        if (singletonInstance == null) {
            synchronized (lock) {
                if (singletonInstance == null) {
                    singletonInstance = new OfflineMapCacheStore(context.getApplicationContext());
                }
            }
        }
        return singletonInstance;
    }

    private OfflineMapCacheStore(Context context) {
        this.appContext = context.getApplicationContext();
        this.cacheDir = new File(context.getFilesDir(), CACHE_DIR);
        this.regionsDir = new File(context.getFilesDir(), REGIONS_DIR);
        this.plansDir = new File(context.getFilesDir(), PLANS_DIR);
        this.jobsDir = new File(context.getFilesDir(), JOBS_DIR);
        this.tasksDir = new File(context.getFilesDir(), TASKS_DIR);
        this.queueDir = new File(context.getFilesDir(), DOWNLOAD_QUEUE_DIR);
        if (!cacheDir.exists()) cacheDir.mkdirs();
        if (!regionsDir.exists()) regionsDir.mkdirs();
        if (!plansDir.exists()) plansDir.mkdirs();
        if (!jobsDir.exists()) jobsDir.mkdirs();
        if (!tasksDir.exists()) tasksDir.mkdirs();
        if (!queueDir.exists()) queueDir.mkdirs();
    }

    public static String canonicalKey(String rawUrl) {
        if (rawUrl == null) return "";
        try {
            int queryStart = rawUrl.indexOf('?');
            if (queryStart < 0) return normalizeGlyphCanonicalBase(rawUrl);
            String base = normalizeGlyphCanonicalBase(rawUrl.substring(0, queryStart));
            String[] pairs = rawUrl.substring(queryStart + 1).split("&");
            List<String> kept = new ArrayList<>();
            for (int i = 0; i < pairs.length; i += 1) {
                String pair = pairs[i];
                if (pair.isEmpty()) continue;
                int eq = pair.indexOf('=');
                String key = eq >= 0 ? pair.substring(0, eq) : pair;
                String lower = key.toLowerCase();
                if (lower.equals("key") || lower.equals("apikey") || lower.equals("access_token")) continue;
                kept.add(pair);
            }
            Collections.sort(kept);
            if (kept.isEmpty()) return base;
            StringBuilder rebuilt = new StringBuilder(base);
            rebuilt.append('?');
            for (int i = 0; i < kept.size(); i += 1) {
                if (i > 0) rebuilt.append('&');
                rebuilt.append(kept.get(i));
            }
            return rebuilt.toString();
        } catch (Exception e) {
            return rawUrl;
        }
    }

    private static String normalizeGlyphCanonicalBase(String base) {
        if (base == null) return "";
        try {
            int fonts = base.indexOf("/fonts/");
            if (fonts < 0) return base;
            int stackStart = fonts + "/fonts/".length();
            int stackEnd = base.indexOf('/', stackStart);
            if (stackEnd <= stackStart) return base;
            String suffix = base.substring(stackEnd);
            if (!suffix.matches("/\\d+-\\d+\\.pbf.*")) return base;
            String fontstack = decodeRepeated(base.substring(stackStart, stackEnd));
            String[] fontsParts = fontstack.split(",");
            StringBuilder normalized = new StringBuilder();
            for (int i = 0; i < fontsParts.length; i += 1) {
                String font = fontsParts[i] == null ? "" : fontsParts[i].trim();
                if (font.isEmpty()) continue;
                if (normalized.length() > 0) normalized.append(',');
                normalized.append(encodePathSegment(font));
            }
            if (normalized.length() == 0) return base;
            return base.substring(0, stackStart) + normalized + suffix;
        } catch (Exception e) {
            return base;
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

    private static String encodePathSegment(String value) {
        if (value == null || value.isEmpty()) return "";
        byte[] bytes = value.getBytes(StandardCharsets.UTF_8);
        StringBuilder out = new StringBuilder(bytes.length * 3);
        final char[] hex = "0123456789ABCDEF".toCharArray();
        for (int i = 0; i < bytes.length; i += 1) {
            int b = bytes[i] & 0xff;
            boolean safe = (b >= 'a' && b <= 'z') || (b >= 'A' && b <= 'Z') || (b >= '0' && b <= '9') || b == '-' || b == '_' || b == '.' || b == '~';
            if (safe) out.append((char) b);
            else {
                out.append('%');
                out.append(hex[(b >> 4) & 0x0f]);
                out.append(hex[b & 0x0f]);
            }
        }
        return out.toString();
    }

    private static String glyphRangeLabel(String url) {
        if (url == null || url.isEmpty()) return "";
        try {
            String base = canonicalKey(url);
            int fonts = base.indexOf("/fonts/");
            if (fonts < 0) return "";
            int stackStart = fonts + "/fonts/".length();
            int stackEnd = base.indexOf('/', stackStart);
            if (stackEnd <= stackStart) return "";
            int rangeEnd = base.indexOf(".pbf", stackEnd);
            if (rangeEnd <= stackEnd) return "";
            String fontstack = decodeRepeated(base.substring(stackStart, stackEnd));
            String range = base.substring(stackEnd + 1, rangeEnd);
            return fontstack + "/" + range;
        } catch (Exception e) {
            return "";
        }
    }

    public static boolean isUnsupportedGlyphRange(String url) {
        if (url == null || url.isEmpty()) return false;
        String base = canonicalKey(url).toLowerCase();
        return base.matches(".*\\/fonts\\/[^?#]+\\/(65024-65279|127744-127999)\\.pbf(\\?.*)?$");
    }

    private static boolean isUnsupportedGlyphTask(JSONObject task) {
        if (task == null) return false;
        String kind = task.optString("kind", "tile");
        if (!"glyph".equals(kind)) return false;
        if (task.optBoolean("unsupportedGlyphRange", false)) return true;
        if ("unsupportedGlyphRange".equals(task.optString("errorType", ""))) return true;
        if ("doneUnsupported".equals(task.optString("status", "")) || "skippedUnsupported".equals(task.optString("status", ""))) return true;
        return isUnsupportedGlyphRange(task.optString("url", "")) && task.optString("lastError", "").contains("400");
    }

    public static String hashKey(String canonical) {
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-1");
            byte[] bytes = digest.digest(canonical.getBytes(StandardCharsets.UTF_8));
            StringBuilder sb = new StringBuilder(bytes.length * 2);
            for (int i = 0; i < bytes.length; i += 1) {
                sb.append(String.format("%02x", bytes[i]));
            }
            return sb.toString();
        } catch (Exception e) {
            return Integer.toHexString(canonical.hashCode());
        }
    }

    public File binFileFor(String url) {
        return new File(cacheDir, hashKey(canonicalKey(url)) + ".bin");
    }

    public File sidecarFileFor(String url) {
        return new File(cacheDir, hashKey(canonicalKey(url)) + ".json");
    }

    public synchronized boolean hasUrl(String url) {
        return isUrlHealthy(url);
    }

    public synchronized String findCachedUrlByCanonicalBase(String url) {
        long started = System.nanoTime();
        try {
            String targetBase = canonicalBaseKey(url);
            if (targetBase.isEmpty()) return "";
            File[] sidecars = cacheDir.listFiles();
            if (sidecars == null || sidecars.length == 0) return "";
            for (int i = 0; i < sidecars.length; i += 1) {
                File sidecarFile = sidecars[i];
                if (sidecarFile == null || !sidecarFile.isFile() || !sidecarFile.getName().endsWith(".json")) continue;
                JSONObject sidecar;
                try {
                    sidecar = readJsonFile(sidecarFile);
                } catch (Exception e) {
                    continue;
                }
                String storedUrl = sidecar != null ? sidecar.optString("url", "") : "";
                if (storedUrl.isEmpty()) continue;
                if (!targetBase.equals(canonicalBaseKey(storedUrl))) continue;
                if (isUrlHealthy(storedUrl)) return storedUrl;
            }
            return "";
        } finally {
            recordTiming("cacheLookup", elapsedMs(started));
        }
    }

    private static String canonicalBaseKey(String url) {
        String key = canonicalKey(url);
        int queryStart = key.indexOf('?');
        return queryStart >= 0 ? key.substring(0, queryStart) : key;
    }

    public synchronized boolean isUrlHealthy(String url) {
        long started = System.nanoTime();
        try {
            File bin = binFileFor(url);
            if (!bin.exists()) return false;
            if (bin.length() > 0L) return true;
            return isEmptyTileMarker(sidecarFileFor(url));
        } finally {
            recordTiming("cacheLookup", elapsedMs(started));
        }
    }

    public synchronized byte[] readBytes(String url) {
        File bin = binFileFor(url);
        if (!bin.exists()) return null;
        try {
            FileInputStream fis = new FileInputStream(bin);
            try {
                ByteArrayOutputStream out = new ByteArrayOutputStream((int) Math.max(1024, bin.length()));
                byte[] buffer = new byte[8192];
                int read;
                while ((read = fis.read(buffer)) > 0) out.write(buffer, 0, read);
                return out.toByteArray();
            } finally {
                try { fis.close(); } catch (IOException ignored) {}
            }
        } catch (IOException e) {
            return null;
        }
    }

    public synchronized String readContentType(String url) {
        File side = sidecarFileFor(url);
        if (!side.exists()) return null;
        try {
            JSONObject sidecar = readJsonFile(side);
            return sidecar != null ? sidecar.optString("contentType", null) : null;
        } catch (Exception e) {
            return null;
        }
    }

    public synchronized void writeEntry(String url, byte[] bytes, String contentType, String regionId) throws IOException {
        writeEntry(url, bytes, contentType, regionId, false);
    }

    public synchronized void writeEmptyTileEntry(String url, String contentType, String regionId) throws IOException {
        writeEntry(url, new byte[0], contentType, regionId, true);
    }

    public synchronized void writeEntry(String url, byte[] bytes, String contentType, String regionId, boolean emptyTile) throws IOException {
        long started = System.nanoTime();
        try {
        File bin = binFileFor(url);
        File side = sidecarFileFor(url);
        File tmp = new File(cacheDir, bin.getName() + ".tmp");
        FileOutputStream fos = new FileOutputStream(tmp);
        byte[] safeBytes = bytes == null ? new byte[0] : bytes;
        try { fos.write(safeBytes); } finally { try { fos.close(); } catch (IOException ignored) {} }
        if (bin.exists() && !bin.delete()) {
            tmp.delete();
            throw new IOException("Konnte bestehende Cache-Datei nicht ersetzen: " + bin.getName());
        }
        if (!tmp.renameTo(bin)) {
            throw new IOException("Konnte temporäre Cache-Datei nicht umbenennen");
        }

        JSONObject sidecar = side.exists() ? readJsonFileOrEmpty(side) : new JSONObject();
        try {
            sidecar.put("url", url);
            sidecar.put("contentType", contentType == null ? "" : contentType);
            Set<String> ownersSet = readOwnersFromSidecar(sidecar);
            if (regionId != null && !regionId.isEmpty()) ownersSet.add(regionId);
            writeOwnersToSidecar(sidecar, ownersSet);
            sidecar.put("size", safeBytes.length);
            if (emptyTile) sidecar.put("emptyTile", true);
            else sidecar.remove("emptyTile");
            sidecar.put("storedAt", System.currentTimeMillis());
        } catch (Exception e) {}
        writeJsonFile(side, sidecar);
        } finally {
            recordTiming("fileWrite", elapsedMs(started));
        }
    }

    public synchronized void attachOwnerToUrl(String url, String ownerId) {
        if (url == null || url.isEmpty() || ownerId == null || ownerId.isEmpty()) return;
        if (!isUrlHealthy(url)) return;
        File side = sidecarFileFor(url);
        JSONObject sidecar = side.exists() ? readJsonFileOrEmpty(side) : new JSONObject();
        try {
            sidecar.put("url", url);
            if (!sidecar.has("contentType")) sidecar.put("contentType", "");
            Set<String> ownersSet = readOwnersFromSidecar(sidecar);
            ownersSet.add(ownerId);
            writeOwnersToSidecar(sidecar, ownersSet);
            sidecar.put("size", getEntrySize(url));
            writeJsonFile(side, sidecar);
        } catch (Exception e) {}
    }

    public synchronized void detachRegionFromUrl(String url, String regionId) {
        detachOwnerFromUrl(url, regionId);
    }

    public synchronized void detachOwnerFromUrl(String url, String ownerId) {
        File side = sidecarFileFor(url);
        if (!side.exists()) return;
        try {
            JSONObject sidecar = readJsonFileOrEmpty(side);
            Set<String> ownersSet = readOwnersFromSidecar(sidecar);
            if (ownersSet.isEmpty()) {
                deleteEntry(url);
                return;
            }
            ownersSet.remove(ownerId);
            if (ownersSet.isEmpty()) {
                deleteEntry(url);
            } else {
                writeOwnersToSidecar(sidecar, ownersSet);
                writeJsonFile(side, sidecar);
            }
        } catch (Exception e) {}
    }

    public synchronized void deleteEntry(String url) {
        File bin = binFileFor(url);
        File side = sidecarFileFor(url);
        if (bin.exists()) bin.delete();
        if (side.exists()) side.delete();
    }

    public synchronized long getEntrySize(String url) {
        File bin = binFileFor(url);
        return bin.exists() ? bin.length() : 0L;
    }

    private static boolean isEmptyTileMarker(File sidecarFile) {
        if (sidecarFile == null || !sidecarFile.exists()) return false;
        JSONObject sidecar = readJsonFileOrEmpty(sidecarFile);
        return sidecar != null && sidecar.optBoolean("emptyTile", false);
    }

    public synchronized void putRegion(JSONObject regionRecord) {
        try {
            String regionId = regionRecord.optString("id", "");
            if (regionId.isEmpty()) return;
            File f = new File(regionsDir, sanitizeId(regionId) + ".json");
            writeJsonFile(f, regionRecord);
        } catch (Exception e) {}
    }

    public synchronized JSONObject markRegionStatus(String regionId, String status, JSONObject verify, String message) {
        JSONObject record = getRegion(regionId);
        if (record == null) record = new JSONObject();
        try {
            record.put("id", regionId);
            record.put("status", status == null || status.isEmpty() ? "unvollstaendig" : status);
            record.put("updatedAt", System.currentTimeMillis());
            if (message != null && !message.isEmpty()) record.put("message", message);
            if (verify != null) {
                record.put("verify", verify);
                record.put("verifyStatus", verify.optString("verifyStatus", verify.optBoolean("complete", false) ? "passed" : "failed"));
                record.put("missingRequired", verify.optInt("requiredMissing", record.optInt("missingRequired", 0)));
                record.put("missingOptionalTiles", verify.optInt("missingOptionalTiles", record.optInt("missingOptionalTiles", 0)));
                record.put("resourceMissing", verify.optInt("resourceMissing", record.optInt("resourceMissing", 0)));
                record.put("missingTiles", verify.optInt("missingTiles", record.optInt("missingTiles", 0)));
                record.put("missingGlyphs", verify.optInt("missingGlyphs", record.optInt("missingGlyphs", 0)));
                record.put("missingSprites", verify.optInt("missingSprites", record.optInt("missingSprites", 0)));
                record.put("unsupportedGlyphRangeCount", verify.optInt("unsupportedGlyphRangeCount", record.optInt("unsupportedGlyphRangeCount", 0)));
                JSONArray missingGlyphRanges = verify.optJSONArray("missingGlyphRanges");
                if (missingGlyphRanges != null) record.put("missingGlyphRanges", missingGlyphRanges);
                JSONArray unsupportedGlyphRanges = verify.optJSONArray("unsupportedGlyphRanges");
                if (unsupportedGlyphRanges != null) record.put("unsupportedGlyphRanges", unsupportedGlyphRanges);
                record.put("lastVerifyAt", verify.optLong("lastVerifyAt", System.currentTimeMillis()));
                record.put("tileCount", verify.optInt("present", record.optInt("tileCount", 0)));
                record.put("tileTotal", verify.optInt("total", record.optInt("tileTotal", 0)));
                record.put("failed", verify.optInt("missing", record.optInt("failed", 0)));
            }
            putRegion(record);
        } catch (Exception e) {}
        return record;
    }

    public synchronized JSONObject getRegion(String regionId) {
        if (regionId == null || regionId.isEmpty()) return null;
        File f = new File(regionsDir, sanitizeId(regionId) + ".json");
        if (!f.exists()) return null;
        return readJsonFileOrEmpty(f);
    }

    public synchronized boolean deleteRegion(String regionId) {
        if (regionId == null || regionId.isEmpty()) return false;
        File f = new File(regionsDir, sanitizeId(regionId) + ".json");
        if (!f.exists()) return false;
        boolean removed = f.delete();
        deleteRegionPlan(regionId);
        deleteJob(regionId);
        deleteTaskList(regionId);
        return removed;
    }

    public synchronized JSONArray listRegions() {
        JSONArray result = new JSONArray();
        File[] files = regionsDir.listFiles();
        if (files == null) return result;
        Arrays.sort(files);
        for (int i = 0; i < files.length; i += 1) {
            JSONObject record = readJsonFileOrEmpty(files[i]);
            if (record != null && record.length() > 0) result.put(record);
        }
        return result;
    }

    public synchronized JSONArray listAllSidecarUrls() {
        JSONArray result = new JSONArray();
        File[] files = cacheDir.listFiles();
        if (files == null) return result;
        for (int i = 0; i < files.length; i += 1) {
            File f = files[i];
            if (!f.getName().endsWith(".json")) continue;
            JSONObject sidecar = readJsonFileOrEmpty(f);
            if (sidecar == null) continue;
            String url = sidecar.optString("url", "");
            if (!url.isEmpty()) result.put(url);
        }
        return result;
    }

    public synchronized long calculateTotalSize() {
        long total = 0L;
        File[] files = cacheDir.listFiles();
        if (files == null) return total;
        for (int i = 0; i < files.length; i += 1) {
            if (files[i].getName().endsWith(".bin")) total += files[i].length();
        }
        return total;
    }

    public synchronized void wipeAll() {
        deleteFolderContents(cacheDir);
        deleteFolderContents(regionsDir);
        deleteFolderContents(plansDir);
        deleteFolderContents(jobsDir);
        deleteFolderContents(tasksDir);
        resetDebugCounters();
    }

    public synchronized Set<String> findUrlsForRegion(String regionId) {
        return findUrlsForOwner(regionId);
    }

    public synchronized Set<String> findUrlsForOwner(String ownerId) {
        Set<String> result = new HashSet<>();
        if (ownerId == null || ownerId.isEmpty()) return result;
        File[] files = cacheDir.listFiles();
        if (files == null) return result;
        for (int i = 0; i < files.length; i += 1) {
            File f = files[i];
            if (!f.getName().endsWith(".json")) continue;
            JSONObject sidecar = readJsonFileOrEmpty(f);
            if (sidecar == null) continue;
            Set<String> owners = readOwnersFromSidecar(sidecar);
            if (owners.contains(ownerId)) {
                String url = sidecar.optString("url", "");
                if (!url.isEmpty()) result.add(url);
            }
        }
        return result;
    }

    public synchronized void putRegionPlan(String regionId, JSONArray urls) {
        if (regionId == null || regionId.isEmpty() || urls == null) return;
        File f = new File(plansDir, sanitizeId(regionId) + ".json");
        writeTextFile(f, urls.toString());
    }

    public synchronized JSONArray getRegionPlan(String regionId) {
        if (regionId == null || regionId.isEmpty()) return null;
        File f = new File(plansDir, sanitizeId(regionId) + ".json");
        if (!f.exists()) return null;
        try {
            String raw = readTextFile(f);
            if (raw == null || raw.isEmpty()) return null;
            return new JSONArray(raw);
        } catch (Exception e) {
            return null;
        }
    }

    public synchronized boolean deleteRegionPlan(String regionId) {
        if (regionId == null || regionId.isEmpty()) return false;
        File f = new File(plansDir, sanitizeId(regionId) + ".json");
        return f.exists() && f.delete();
    }

    public synchronized JSONObject upsertJob(String ownerId, JSONObject patch) {
        String normalizedOwner = ownerId == null ? "" : ownerId.trim();
        if (normalizedOwner.isEmpty() && patch != null) {
            normalizedOwner = patch.optString("ownerId", patch.optString("regionId", ""));
        }
        if (normalizedOwner.isEmpty()) return new JSONObject();
        File f = new File(jobsDir, sanitizeId(normalizedOwner) + ".json");
        JSONObject job = f.exists() ? readJsonFileOrEmpty(f) : new JSONObject();
        long now = System.currentTimeMillis();
        try {
            if (!job.has("createdAt")) job.put("createdAt", patch != null ? patch.optLong("createdAt", now) : now);
            if (patch != null) {
                Iterator<String> keys = patch.keys();
                while (keys.hasNext()) {
                    String key = keys.next();
                    job.put(key, patch.opt(key));
                }
            }
            job.put("ownerId", normalizedOwner);
            if (!job.has("regionId")) job.put("regionId", normalizedOwner);
            if (!job.has("jobId") || job.optString("jobId", "").isEmpty()) job.put("jobId", "job_" + normalizedOwner);
            job.put("updatedAt", now);
            writeJsonFile(f, job);
        } catch (Exception e) {}
        return job;
    }

    public synchronized JSONObject getJob(String ownerId) {
        if (ownerId == null || ownerId.isEmpty()) return null;
        File f = new File(jobsDir, sanitizeId(ownerId) + ".json");
        if (!f.exists()) return null;
        return readJsonFileOrEmpty(f);
    }

    public synchronized JSONArray listJobs() {
        JSONArray result = new JSONArray();
        File[] files = jobsDir.listFiles();
        if (files == null) return result;
        Arrays.sort(files);
        for (int i = 0; i < files.length; i += 1) {
            if (!files[i].getName().endsWith(".json")) continue;
            JSONObject job = readJsonFileOrEmpty(files[i]);
            if (job != null && job.length() > 0) result.put(job);
        }
        return result;
    }

    public synchronized boolean deleteJob(String ownerId) {
        if (ownerId == null || ownerId.isEmpty()) return false;
        File f = new File(jobsDir, sanitizeId(ownerId) + ".json");
        return f.exists() && f.delete();
    }

    public synchronized JSONArray ensureTaskListForPlan(String ownerId, JSONArray urls) {
        if (ownerId == null || ownerId.isEmpty() || urls == null) return new JSONArray();
        JSONArray previous = getTaskList(ownerId);
        Map<String, JSONObject> previousByKey = new HashMap<>();
        for (int i = 0; i < previous.length(); i += 1) {
            JSONObject item = previous.optJSONObject(i);
            if (item == null) continue;
            String key = item.optString("canonicalKey", canonicalKey(item.optString("url", "")));
            if (!key.isEmpty()) previousByKey.put(key, item);
        }
        JSONArray next = new JSONArray();
        long now = System.currentTimeMillis();
        for (int i = 0; i < urls.length(); i += 1) {
            JSONObject planEntry = urls.optJSONObject(i);
            String url = planEntry != null ? planEntry.optString("url", "") : "";
            String kind = planEntry != null ? planEntry.optString("kind", "tile") : "tile";
            boolean required = planEntry != null && planEntry.optBoolean("required", false);
            if (url.isEmpty()) continue;
            String key = canonicalKey(url);
            JSONObject task = new JSONObject();
            try {
                if (previousByKey.containsKey(key)) task = new JSONObject(previousByKey.get(key).toString());
                task.put("canonicalKey", key);
                task.put("hash", hashKey(key));
                task.put("url", url);
                task.put("ownerId", ownerId);
                task.put("kind", kind == null || kind.isEmpty() ? "tile" : kind);
                task.put("required", required);
                task.put("index", i);
                if (!task.has("createdAt")) task.put("createdAt", now);
                if (!task.has("retryCount")) task.put("retryCount", 0);
                if (!task.has("lastError")) task.put("lastError", "");
                if (!task.has("nextRetryAt")) task.put("nextRetryAt", 0L);
                String status = task.optString("status", "pending");
                if (isUrlHealthy(url)) {
                    status = "done";
                    task.put("lastError", "");
                    task.put("nextRetryAt", 0L);
                } else if (isUnsupportedGlyphTask(task)) {
                    status = "doneUnsupported";
                    task.put("unsupportedGlyphRange", true);
                    task.put("errorType", "unsupportedGlyphRange");
                    task.put("lastError", "unsupportedGlyphRange");
                    task.put("nextRetryAt", 0L);
                } else if ("done".equals(status) || "downloading".equals(status) || "cancelled".equals(status)) {
                    status = "pending";
                } else if (!"failed".equals(status) && !"pending".equals(status) && !"doneUnsupported".equals(status) && !"skippedUnsupported".equals(status)) {
                    status = "pending";
                }
                task.put("status", status);
                task.put("updatedAt", now);
            } catch (Exception e) {}
            next.put(task);
        }
        putTaskList(ownerId, next);
        return next;
    }

    public synchronized JSONArray getTaskList(String ownerId) {
        if (ownerId == null || ownerId.isEmpty()) return new JSONArray();
        File f = new File(tasksDir, sanitizeId(ownerId) + ".json");
        if (!f.exists()) return new JSONArray();
        try {
            String raw = readTextFile(f);
            if (raw == null || raw.isEmpty()) return new JSONArray();
            return new JSONArray(raw);
        } catch (Exception e) {
            return new JSONArray();
        }
    }

    public synchronized void putTaskList(String ownerId, JSONArray tasks) {
        if (ownerId == null || ownerId.isEmpty() || tasks == null) return;
        long started = System.nanoTime();
        File f = new File(tasksDir, sanitizeId(ownerId) + ".json");
        try {
            writeTextFile(f, tasks.toString());
        } finally {
            recordTiming("taskPersistence", elapsedMs(started));
        }
    }

    public synchronized boolean deleteTaskList(String ownerId) {
        if (ownerId == null || ownerId.isEmpty()) return false;
        File f = new File(tasksDir, sanitizeId(ownerId) + ".json");
        return f.exists() && f.delete();
    }

    public synchronized int resetDownloadingTasks(String ownerId) {
        JSONArray tasks = getTaskList(ownerId);
        int changed = 0;
        long now = System.currentTimeMillis();
        for (int i = 0; i < tasks.length(); i += 1) {
            JSONObject task = tasks.optJSONObject(i);
            if (task == null) continue;
            if ("downloading".equals(task.optString("status", ""))) {
                try {
                    task.put("status", "pending");
                    task.put("updatedAt", now);
                    changed += 1;
                } catch (Exception e) {}
            }
        }
        if (changed > 0) putTaskList(ownerId, tasks);
        return changed;
    }

    public synchronized JSONObject summarizeTasks(String ownerId) {
        JSONArray tasks = getTaskList(ownerId);
        if (normalizeUnsupportedGlyphTasks(tasks)) putTaskList(ownerId, tasks);
        return summarizeTasks(ownerId, tasks);
    }

    private static boolean normalizeUnsupportedGlyphTasks(JSONArray tasks) {
        boolean changed = false;
        if (tasks == null) return false;
        long now = System.currentTimeMillis();
        for (int i = 0; i < tasks.length(); i += 1) {
            JSONObject task = tasks.optJSONObject(i);
            if (!isUnsupportedGlyphTask(task)) continue;
            try {
                String status = task.optString("status", "");
                if (!"doneUnsupported".equals(status) && !"skippedUnsupported".equals(status)) {
                    task.put("status", "doneUnsupported");
                    changed = true;
                }
                if (!task.optBoolean("unsupportedGlyphRange", false)) {
                    task.put("unsupportedGlyphRange", true);
                    changed = true;
                }
                if (!"unsupportedGlyphRange".equals(task.optString("errorType", ""))) {
                    task.put("errorType", "unsupportedGlyphRange");
                    changed = true;
                }
                if (!"unsupportedGlyphRange".equals(task.optString("lastError", ""))) {
                    task.put("lastError", "unsupportedGlyphRange");
                    changed = true;
                }
                if (task.optInt("retryCount", 0) != 0) {
                    task.put("retryCount", 0);
                    changed = true;
                }
                if (task.optLong("nextRetryAt", 0L) != 0L) {
                    task.put("nextRetryAt", 0L);
                    changed = true;
                }
                if (changed) task.put("updatedAt", now);
            } catch (Exception e) {}
        }
        return changed;
    }

    public synchronized JSONObject summarizeTasks(String ownerId, JSONArray tasks) {
        JSONObject result = new JSONObject();
        int total = tasks != null ? tasks.length() : 0;
        int done = 0;
        int present = 0;
        int pending = 0;
        int failed = 0;
        int downloading = 0;
        int missing = 0;
        int requiredMissing = 0;
        int missingOptionalTiles = 0;
        int tileTotal = 0;
        int tileDone = 0;
        int tilePresent = 0;
        int tilePending = 0;
        int tileFailed = 0;
        int tileDownloading = 0;
        int tileMissing = 0;
        int resourceTotal = 0;
        int resourceMissing = 0;
        int resourceFailed = 0;
        int glyphTotal = 0;
        int glyphMissing = 0;
        int glyphFailed = 0;
        int unsupportedGlyphRanges = 0;
        int spriteTotal = 0;
        int spriteMissing = 0;
        int spriteFailed = 0;
        long bytes = 0L;
        try {
            for (int i = 0; i < total; i += 1) {
                JSONObject task = tasks.optJSONObject(i);
                if (task == null) continue;
                String url = task.optString("url", "");
                String kind = task.optString("kind", "tile");
                boolean isTile = "tile".equals(kind) || kind.isEmpty();
                String status = task.optString("status", "pending");
                boolean isGlyph = "glyph".equals(kind);
                boolean unsupportedGlyph = isUnsupportedGlyphTask(task) || (isGlyph && isUnsupportedGlyphRange(url));
                boolean required = (task.optBoolean("required", false) || isGlyph) && !unsupportedGlyph;
                boolean healthy = !url.isEmpty() && isUrlHealthy(url);
                if (isTile) tileTotal += 1;
                else {
                    resourceTotal += 1;
                    if (isGlyph) glyphTotal += 1;
                    else if ("sprite".equals(kind)) spriteTotal += 1;
                }
                if (unsupportedGlyph) {
                    unsupportedGlyphRanges += 1;
                    done += 1;
                    pending += 0;
                } else if (healthy) {
                    present += 1;
                    done += 1;
                    bytes += getEntrySize(url);
                    if (isTile) {
                        tilePresent += 1;
                        tileDone += 1;
                    }
                } else {
                    missing += 1;
                    if (required) requiredMissing += 1;
                    if (isTile) {
                        tileMissing += 1;
                        if (!required) missingOptionalTiles += 1;
                        if ("failed".equals(status)) tileFailed += 1;
                        else if ("downloading".equals(status) || "rate_limited".equals(status)) tileDownloading += 1;
                        else tilePending += 1;
                    } else {
                        resourceMissing += 1;
                        if (isGlyph) glyphMissing += 1;
                        else if ("sprite".equals(kind)) spriteMissing += 1;
                    }
                    if ("failed".equals(status)) {
                        failed += 1;
                        if (!isTile) {
                            resourceFailed += 1;
                            if (isGlyph) glyphFailed += 1;
                            else if ("sprite".equals(kind)) spriteFailed += 1;
                        }
                    } else if ("downloading".equals(status) || "rate_limited".equals(status)) downloading += 1;
                    else pending += 1;
                }
            }
            result.put("ownerId", ownerId == null ? "" : ownerId);
            result.put("totalUrls", total);
            result.put("doneUrls", done);
            result.put("presentUrls", present);
            result.put("pendingUrls", pending);
            result.put("failedUrls", failed);
            result.put("downloadingUrls", downloading);
            result.put("missingUrls", missing);
            result.put("requiredMissing", requiredMissing);
            result.put("missingOptionalTiles", missingOptionalTiles);
            result.put("tileTotalUrls", tileTotal);
            result.put("tileDoneUrls", tileDone);
            result.put("tilePresentUrls", tilePresent);
            result.put("tilePendingUrls", tilePending);
            result.put("tileFailedUrls", tileFailed);
            result.put("tileDownloadingUrls", tileDownloading);
            result.put("tileMissingUrls", tileMissing);
            result.put("resourceTotalUrls", resourceTotal);
            result.put("resourceMissingUrls", resourceMissing);
            result.put("resourceFailedUrls", resourceFailed);
            result.put("glyphTotalUrls", glyphTotal);
            result.put("glyphMissingUrls", glyphMissing);
            result.put("glyphFailedUrls", glyphFailed);
            result.put("unsupportedGlyphRangeUrls", unsupportedGlyphRanges);
            result.put("spriteTotalUrls", spriteTotal);
            result.put("spriteMissingUrls", spriteMissing);
            result.put("spriteFailedUrls", spriteFailed);
            result.put("sizeBytes", bytes);
        } catch (Exception e) {}
        return result;
    }

    public synchronized JSONObject verifyRegionPlan(String regionId) {
        return verifyRegionPlan(regionId, getRegionPlan(regionId));
    }

    public synchronized JSONObject verifyRegionPlan(String regionId, JSONArray urls) {
        long started = System.nanoTime();
        JSONObject result = new JSONObject();
        int urlTotal = urls != null ? urls.length() : 0;
        int urlPresent = 0;
        int urlMissing = 0;
        int tileTotal = 0;
        int tilePresent = 0;
        int tileMissing = 0;
        int requiredTotal = 0;
        int requiredMissing = 0;
        int resourceTotal = 0;
        int resourcePresent = 0;
        int resourceMissing = 0;
        int glyphTotal = 0;
        int glyphPresent = 0;
        int glyphMissing = 0;
        int unsupportedGlyphRangeCount = 0;
        int spriteTotal = 0;
        int spritePresent = 0;
        int spriteMissing = 0;
        long bytes = 0L;
        JSONArray missingSamples = new JSONArray();
        JSONArray missingGlyphRanges = new JSONArray();
        JSONArray unsupportedGlyphRanges = new JSONArray();
        Set<String> missingGlyphRangeSet = new LinkedHashSet<>();
        Set<String> unsupportedGlyphRangeSet = new LinkedHashSet<>();
        try {
            for (int i = 0; i < urlTotal; i += 1) {
                JSONObject entry = urls.optJSONObject(i);
                String url = entry != null ? entry.optString("url", "") : "";
                String kind = entry != null ? entry.optString("kind", "tile") : "tile";
                boolean isTile = "tile".equals(kind) || kind.isEmpty();
                boolean isGlyph = "glyph".equals(kind);
                boolean unsupportedGlyph = isGlyph && isUnsupportedGlyphRange(url);
                boolean required = ((entry != null && entry.optBoolean("required", false)) || isGlyph) && !unsupportedGlyph;
                if (required) requiredTotal += 1;
                if (isTile) tileTotal += 1;
                else {
                    resourceTotal += 1;
                    if (isGlyph) glyphTotal += 1;
                    else if ("sprite".equals(kind)) spriteTotal += 1;
                }
                boolean ok = !url.isEmpty() && isUrlHealthy(url);
                if (unsupportedGlyph) {
                    unsupportedGlyphRangeCount += 1;
                    String glyphLabel = glyphRangeLabel(url);
                    if (!glyphLabel.isEmpty()) unsupportedGlyphRangeSet.add(glyphLabel);
                } else if (ok) {
                    urlPresent += 1;
                    bytes += getEntrySize(url);
                    if (isTile) tilePresent += 1;
                    else {
                        resourcePresent += 1;
                        if (isGlyph) glyphPresent += 1;
                        else if ("sprite".equals(kind)) spritePresent += 1;
                    }
                } else {
                    urlMissing += 1;
                    if (isTile) tileMissing += 1;
                    else {
                        resourceMissing += 1;
                        if (isGlyph) {
                            glyphMissing += 1;
                            String glyphLabel = glyphRangeLabel(url);
                            if (!glyphLabel.isEmpty()) missingGlyphRangeSet.add(glyphLabel);
                        } else if ("sprite".equals(kind)) {
                            spriteMissing += 1;
                        }
                    }
                    if (required) requiredMissing += 1;
                    if (missingSamples.length() < 50) missingSamples.put(url);
                }
            }
            for (String glyphRange : missingGlyphRangeSet) {
                if (missingGlyphRanges.length() >= 50) break;
                missingGlyphRanges.put(glyphRange);
            }
            for (String glyphRange : unsupportedGlyphRangeSet) {
                if (unsupportedGlyphRanges.length() >= 50) break;
                unsupportedGlyphRanges.put(glyphRange);
            }
            result.put("regionId", regionId == null ? "" : regionId);
            result.put("total", tileTotal);
            result.put("present", tilePresent);
            result.put("missing", tileMissing);
            result.put("missingTiles", tileMissing);
            result.put("urlTotal", urlTotal);
            result.put("urlPresent", urlPresent);
            result.put("urlMissing", urlMissing);
            result.put("requiredTotal", requiredTotal);
            result.put("requiredMissing", requiredMissing);
            result.put("missingOptionalTiles", Math.max(0, tileMissing));
            result.put("resourceTotal", resourceTotal);
            result.put("resourcePresent", resourcePresent);
            result.put("resourceMissing", resourceMissing);
            result.put("glyphTotal", glyphTotal);
            result.put("glyphPresent", glyphPresent);
            result.put("missingGlyphs", glyphMissing);
            result.put("unsupportedGlyphRangeCount", unsupportedGlyphRangeCount);
            result.put("unsupportedGlyphRanges", unsupportedGlyphRanges);
            result.put("spriteTotal", spriteTotal);
            result.put("spritePresent", spritePresent);
            result.put("missingSprites", spriteMissing);
            result.put("optionalResourceMissing", Math.max(0, resourceMissing - requiredMissing));
            result.put("sizeBytes", bytes);
            result.put("complete", tileTotal > 0 && tileMissing == 0 && requiredMissing == 0);
            result.put("verifyStatus", (tileTotal > 0 && tileMissing == 0 && requiredMissing == 0) ? "passed" : "failed");
            result.put("lastVerifyAt", System.currentTimeMillis());
            result.put("missingSamples", missingSamples);
            result.put("missingGlyphRanges", missingGlyphRanges);
        } catch (Exception e) {}
        finally {
            recordTiming("verify", elapsedMs(started));
        }
        return result;
    }

    public synchronized JSONObject recoverStaleDownloads(boolean serviceActive) {
        JSONObject result = new JSONObject();
        int recoveredJobs = 0;
        int recoveredRegions = 0;
        int resetTasks = 0;
        long now = System.currentTimeMillis();
        if (!serviceActive) {
            JSONArray jobs = listJobs();
            for (int i = 0; i < jobs.length(); i += 1) {
                JSONObject job = jobs.optJSONObject(i);
                if (job == null) continue;
                String ownerId = job.optString("ownerId", job.optString("regionId", ""));
                String status = job.optString("status", "");
                if (isRunningLikeStatus(status)) {
                    resetTasks += resetDownloadingTasks(ownerId);
                    JSONObject patch = new JSONObject();
                    try {
                        JSONObject summary = summarizeTasks(ownerId);
                        patch.put("status", "fortsetzbar");
                        patch.put("chunkStatus", "paused");
                        patch.put("doneUrls", summary.optInt("doneUrls", 0));
                        patch.put("failedUrls", summary.optInt("failedUrls", 0));
                        patch.put("updatedAt", now);
                    } catch (Exception e) {}
                    upsertJob(ownerId, patch);
                    recoveredJobs += 1;
                }
            }

            JSONArray regions = listRegions();
            for (int i = 0; i < regions.length(); i += 1) {
                JSONObject region = regions.optJSONObject(i);
                if (region == null) continue;
                String regionId = region.optString("id", "");
                String status = region.optString("status", "");
                if (isRunningLikeStatus(status)) {
                    try {
                        JSONObject verify = verifyRegionPlan(regionId);
                        region.put("status", "fortsetzbar");
                        region.put("ready", false);
                        region.put("message", "Download nach Prozessende automatisch als fortsetzbar markiert");
                        region.put("verify", verify);
                        region.put("verifyStatus", verify.optString("verifyStatus", "failed"));
                        region.put("tileCount", verify.optInt("present", region.optInt("tileCount", 0)));
                        region.put("tileTotal", verify.optInt("total", region.optInt("tileTotal", 0)));
                        region.put("missing", verify.optInt("missing", region.optInt("missing", 0)));
                        region.put("requiredMissing", verify.optInt("requiredMissing", region.optInt("requiredMissing", 0)));
                        region.put("missingOptionalTiles", verify.optInt("missingOptionalTiles", region.optInt("missingOptionalTiles", 0)));
                        region.put("resourceMissing", verify.optInt("resourceMissing", region.optInt("resourceMissing", 0)));
                        region.put("missingTiles", verify.optInt("missingTiles", region.optInt("missingTiles", 0)));
                        region.put("missingGlyphs", verify.optInt("missingGlyphs", region.optInt("missingGlyphs", 0)));
                        region.put("missingSprites", verify.optInt("missingSprites", region.optInt("missingSprites", 0)));
                        region.put("unsupportedGlyphRangeCount", verify.optInt("unsupportedGlyphRangeCount", region.optInt("unsupportedGlyphRangeCount", 0)));
                        JSONArray missingGlyphRanges = verify.optJSONArray("missingGlyphRanges");
                        if (missingGlyphRanges != null) region.put("missingGlyphRanges", missingGlyphRanges);
                        JSONArray unsupportedGlyphRanges = verify.optJSONArray("unsupportedGlyphRanges");
                        if (unsupportedGlyphRanges != null) region.put("unsupportedGlyphRanges", unsupportedGlyphRanges);
                        region.put("lastVerifyAt", verify.optLong("lastVerifyAt", now));
                        region.put("updatedAt", now);
                        putRegion(region);
                        recoveredRegions += 1;
                    } catch (Exception e) {}
                }
            }
        }
        try {
            result.put("serviceActive", serviceActive);
            result.put("recoveredJobs", recoveredJobs);
            result.put("recoveredRegions", recoveredRegions);
            result.put("resetTasks", resetTasks);
            result.put("queueStatus", getQueueStatus());
        } catch (Exception e) {}
        return result;
    }

    public synchronized JSONObject getDebugInfo(boolean serviceActive) {
        JSONObject result = new JSONObject();
        JSONArray regions = listRegions();
        JSONArray jobs = listJobs();
        JSONObject currentErrorDiagnostics = getCurrentTaskErrorDebugInfo(true);
        JSONObject counters = getDebugCounters();
        int corridors = 0;
        int tilesTotal = 0;
        int tilesPresent = 0;
        int tilesMissing = 0;
        int missingRequired = 0;
        int missingOptionalTiles = 0;
        int resourceMissing = 0;
        int missingGlyphs = 0;
        int missingSprites = 0;
        int unsupportedGlyphRangeCount = 0;
        long cacheSizeBytes = 0L;
        long lastVerifyAt = 0L;
        boolean anyFailed = false;
        boolean anyRunning = false;
        boolean anyNotStarted = false;
        JSONArray missingGlyphRanges = new JSONArray();
        JSONArray unsupportedGlyphRanges = new JSONArray();
        Set<String> missingGlyphRangeSet = new LinkedHashSet<>();
        Set<String> unsupportedGlyphRangeSet = new LinkedHashSet<>();
        try {
            for (int i = 0; i < regions.length(); i += 1) {
                JSONObject region = regions.optJSONObject(i);
                if (region == null) continue;
                if ("corridor".equals(region.optString("type", ""))) corridors += 1;
                JSONObject verify = region.optJSONObject("verify");
                int regionTotal = region.optInt("tileTotal", verify != null ? verify.optInt("total", 0) : 0);
                int regionPresent = region.optInt("tileCount", verify != null ? verify.optInt("present", 0) : 0);
                int regionMissing = region.optInt("missing", Math.max(0, regionTotal - regionPresent));
                tilesTotal += Math.max(0, regionTotal);
                tilesPresent += Math.max(0, regionPresent);
                tilesMissing += Math.max(0, regionMissing);
                missingRequired += region.optInt("requiredMissing", verify != null ? verify.optInt("requiredMissing", 0) : 0);
                missingOptionalTiles += region.optInt("missingOptionalTiles", verify != null ? verify.optInt("missingOptionalTiles", 0) : 0);
                resourceMissing += region.optInt("resourceMissing", verify != null ? verify.optInt("resourceMissing", 0) : 0);
                missingGlyphs += region.optInt("missingGlyphs", verify != null ? verify.optInt("missingGlyphs", 0) : 0);
                missingSprites += region.optInt("missingSprites", verify != null ? verify.optInt("missingSprites", 0) : 0);
                unsupportedGlyphRangeCount += region.optInt("unsupportedGlyphRangeCount", verify != null ? verify.optInt("unsupportedGlyphRangeCount", 0) : 0);
                JSONArray regionMissingGlyphRanges = region.optJSONArray("missingGlyphRanges");
                if (regionMissingGlyphRanges == null && verify != null) regionMissingGlyphRanges = verify.optJSONArray("missingGlyphRanges");
                if (regionMissingGlyphRanges != null) {
                    for (int j = 0; j < regionMissingGlyphRanges.length(); j += 1) {
                        String label = regionMissingGlyphRanges.optString(j, "");
                        if (!label.isEmpty()) missingGlyphRangeSet.add(label);
                    }
                }
                JSONArray regionUnsupportedGlyphRanges = region.optJSONArray("unsupportedGlyphRanges");
                if (regionUnsupportedGlyphRanges == null && verify != null) regionUnsupportedGlyphRanges = verify.optJSONArray("unsupportedGlyphRanges");
                if (regionUnsupportedGlyphRanges != null) {
                    for (int j = 0; j < regionUnsupportedGlyphRanges.length(); j += 1) {
                        String label = regionUnsupportedGlyphRanges.optString(j, "");
                        if (!label.isEmpty()) unsupportedGlyphRangeSet.add(label);
                    }
                }
                cacheSizeBytes += Math.max(0L, region.optLong("sizeBytes", verify != null ? verify.optLong("sizeBytes", 0L) : 0L));
                lastVerifyAt = Math.max(lastVerifyAt, region.optLong("lastVerifyAt", verify != null ? verify.optLong("lastVerifyAt", 0L) : 0L));
                String status = region.optString("verifyStatus", verify != null ? verify.optString("verifyStatus", "not_started") : "not_started");
                if ("running".equals(status)) anyRunning = true;
                else if ("failed".equals(status)) anyFailed = true;
                else if (!"passed".equals(status)) anyNotStarted = true;
            }
            for (String label : missingGlyphRangeSet) {
                if (missingGlyphRanges.length() >= 50) break;
                missingGlyphRanges.put(label);
            }
            JSONArray currentUnsupportedGlyphRanges = currentErrorDiagnostics.optJSONArray("unsupportedGlyphRanges");
            if (currentUnsupportedGlyphRanges != null) {
                for (int i = 0; i < currentUnsupportedGlyphRanges.length(); i += 1) {
                    String label = currentUnsupportedGlyphRanges.optString(i, "");
                    if (!label.isEmpty()) unsupportedGlyphRangeSet.add(label);
                }
            }
            unsupportedGlyphRangeCount = Math.max(unsupportedGlyphRangeCount, currentErrorDiagnostics.optInt("unsupportedGlyphRangeCount", unsupportedGlyphRangeCount));
            for (String label : unsupportedGlyphRangeSet) {
                if (unsupportedGlyphRanges.length() >= 50) break;
                unsupportedGlyphRanges.put(label);
            }
            String verifyStatus = anyRunning ? "running" : (anyFailed ? "failed" : (anyNotStarted ? "not_started" : (regions.length() > 0 ? "passed" : "not_started")));
            result.put("regionsTotal", regions.length());
            result.put("corridorsTotal", corridors);
            result.put("downloadJobs", jobs.length());
            result.put("queueStatus", getQueueStatus());
            result.put("tilesTotal", tilesTotal);
            result.put("tilesPresent", tilesPresent);
            result.put("tilesMissing", tilesMissing);
            result.put("missingTiles", tilesMissing);
            result.put("missingRequired", missingRequired);
            result.put("missingOptionalTiles", missingOptionalTiles);
            result.put("resourceMissing", resourceMissing);
            result.put("missingGlyphs", missingGlyphs);
            result.put("plannedGlyphsMissing", missingGlyphs);
            result.put("missingSprites", missingSprites);
            result.put("missingGlyphRanges", missingGlyphRanges);
            result.put("unsupportedGlyphRangeCount", unsupportedGlyphRangeCount);
            result.put("unsupportedGlyphRanges", unsupportedGlyphRanges);
            result.put("cacheSizeBytes", cacheSizeBytes);
            result.put("cacheEntries", tilesPresent);
            result.put("cacheHits", counters.optLong("cacheHits", 0L));
            result.put("cacheMisses", counters.optLong("cacheMisses", 0L));
            result.put("glyphCacheHits", counters.optLong("glyphCacheHits", 0L));
            result.put("glyphCacheMisses", counters.optLong("glyphCacheMisses", 0L));
            result.put("glyphFallbackServed", counters.optLong("glyphFallbackServed", 0L));
            result.put("runtimeGlyphMisses", counters.optLong("glyphRuntimeMisses", 0L));
            result.put("glyphRuntimeMissSuppressed", counters.optLong("glyphRuntimeMissSuppressed", 0L));
            result.put("blockedOfflineNetworkRequests", counters.optLong("blockedOfflineNetworkRequests", 0L));
            result.put("topRuntimeGlyphMisses", getRuntimeGlyphMissDebugList());
            result.put("httpDownloads", counters.optLong("httpDownloads", 0L));
            result.put("httpErrors", counters.optLong("httpErrors", 0L));
            result.put("skippedAlreadyPresent", counters.optLong("skippedAlreadyPresent", 0L));
            result.put("errorDiagnostics", currentErrorDiagnostics);
            result.put("timings", getTimingDebugInfo());
            result.put("currentWorkerCount", getDebugLong("currentWorkerCount", 0L));
            result.put("rateLimitedUntil", getDebugLong("rateLimitedUntil", 0L));
            result.put("verifyStatus", verifyStatus);
            result.put("lastVerifyAt", lastVerifyAt);
            result.put("serviceActive", serviceActive);
            result.put("jobs", jobs);
            result.put("availableBytes", appContext.getFilesDir().getUsableSpace());
        } catch (Exception e) {}
        return result;
    }

    public synchronized JSONObject getStoredStorageInfo() {
        JSONObject result = new JSONObject();
        JSONArray regions = listRegions();
        long totalBytes = 0L;
        int totalTiles = 0;
        try {
            for (int i = 0; i < regions.length(); i += 1) {
                JSONObject region = regions.optJSONObject(i);
                if (region == null) continue;
                totalBytes += Math.max(0L, region.optLong("sizeBytes", 0L));
                totalTiles += Math.max(0, region.optInt("tileCount", 0));
            }
            result.put("regions", regions.length());
            result.put("totalBytes", totalBytes);
            result.put("totalTiles", totalTiles);
            result.put("availableBytes", appContext.getFilesDir().getUsableSpace());
        } catch (Exception e) {}
        return result;
    }

    public synchronized JSONObject getQueueStatus() {
        JSONObject result = new JSONObject();
        int queueFiles = 0;
        int urlsFiles = 0;
        long newest = 0L;
        JSONArray filesJson = new JSONArray();
        File[] files = queueDir.listFiles();
        if (files != null) {
            Arrays.sort(files);
            for (int i = 0; i < files.length; i += 1) {
                File f = files[i];
                if (f.getName().startsWith("queue_") && f.getName().endsWith(".json")) queueFiles += 1;
                if (f.getName().startsWith("urls_") && f.getName().endsWith(".json")) urlsFiles += 1;
                newest = Math.max(newest, f.lastModified());
                if (filesJson.length() < 20) {
                    JSONObject item = new JSONObject();
                    try {
                        item.put("name", f.getName());
                        item.put("size", f.length());
                        item.put("updatedAt", f.lastModified());
                    } catch (Exception e) {}
                    filesJson.put(item);
                }
            }
        }
        try {
            result.put("queueFiles", queueFiles);
            result.put("urlsFiles", urlsFiles);
            result.put("queueLength", queueFiles);
            result.put("updatedAt", newest);
            result.put("files", filesJson);
        } catch (Exception e) {}
        return result;
    }

    public synchronized int countHealthyEntries() {
        int total = 0;
        File[] files = cacheDir.listFiles();
        if (files == null) return total;
        for (int i = 0; i < files.length; i += 1) {
            File f = files[i];
            if (f.getName().endsWith(".bin") && f.length() > 0L) total += 1;
        }
        return total;
    }

    public synchronized void incrementDebugCounter(String key, long delta) {
        if (key == null || key.isEmpty() || delta == 0L) return;
        SharedPreferences prefs = appContext.getSharedPreferences(DEBUG_PREFS_NAME, Context.MODE_PRIVATE);
        long next = prefs.getLong(key, 0L) + delta;
        prefs.edit().putLong(key, Math.max(0L, next)).putLong("updatedAt", System.currentTimeMillis()).apply();
    }

    public synchronized JSONObject getDebugCounters() {
        SharedPreferences prefs = appContext.getSharedPreferences(DEBUG_PREFS_NAME, Context.MODE_PRIVATE);
        JSONObject result = new JSONObject();
        try {
            for (int i = 0; i < DEBUG_COUNTER_KEYS.length; i += 1) {
                result.put(DEBUG_COUNTER_KEYS[i], prefs.getLong(DEBUG_COUNTER_KEYS[i], 0L));
            }
            result.put("updatedAt", prefs.getLong("updatedAt", 0L));
        } catch (Exception e) {}
        return result;
    }

    public synchronized void setDebugLong(String key, long value) {
        if (key == null || key.isEmpty()) return;
        appContext.getSharedPreferences(DEBUG_PREFS_NAME, Context.MODE_PRIVATE)
            .edit()
            .putLong(key, Math.max(0L, value))
            .putLong("updatedAt", System.currentTimeMillis())
            .apply();
    }

    public synchronized long getDebugLong(String key, long fallback) {
        if (key == null || key.isEmpty()) return fallback;
        return appContext.getSharedPreferences(DEBUG_PREFS_NAME, Context.MODE_PRIVATE).getLong(key, fallback);
    }

    public synchronized boolean hasRuntimeGlyphMiss(String url) {
        String key = runtimeGlyphMissKey(url);
        if (key.isEmpty()) return false;
        return appContext.getSharedPreferences(DEBUG_PREFS_NAME, Context.MODE_PRIVATE).getBoolean(key, false);
    }

    public synchronized void recordRuntimeGlyphFallback(String url, boolean alreadyKnown) {
        incrementDebugCounter("glyphFallbackServed", 1L);
        if (alreadyKnown) incrementDebugCounter("glyphRuntimeMissSuppressed", 1L);
        else incrementDebugCounter("glyphRuntimeMisses", 1L);

        String canonical = canonicalKey(url);
        String key = runtimeGlyphMissKey(canonical);
        String label = glyphRangeLabel(canonical);
        if (label.isEmpty()) label = canonical;
        SharedPreferences prefs = appContext.getSharedPreferences(DEBUG_PREFS_NAME, Context.MODE_PRIVATE);
        JSONObject counts;
        try {
            counts = new JSONObject(prefs.getString("runtimeGlyphMissCounts", "{}"));
        } catch (Exception e) {
            counts = new JSONObject();
        }
        try {
            counts.put(label, counts.optLong(label, 0L) + 1L);
            List<ErrorCount> ordered = new ArrayList<>();
            Iterator<String> keys = counts.keys();
            while (keys.hasNext()) {
                String itemKey = keys.next();
                ordered.add(new ErrorCount(itemKey, counts.optLong(itemKey, 0L)));
            }
            Collections.sort(ordered);
            JSONObject capped = new JSONObject();
            for (int i = 0; i < ordered.size() && i < 50; i += 1) {
                capped.put(ordered.get(i).error, ordered.get(i).count);
            }
            SharedPreferences.Editor editor = prefs.edit()
                .putString("runtimeGlyphMissCounts", capped.toString())
                .putLong("updatedAt", System.currentTimeMillis());
            if (!key.isEmpty()) editor.putBoolean(key, true);
            editor.apply();
        } catch (Exception e) {}
    }

    public synchronized JSONArray getRuntimeGlyphMissDebugList() {
        SharedPreferences prefs = appContext.getSharedPreferences(DEBUG_PREFS_NAME, Context.MODE_PRIVATE);
        JSONArray result = new JSONArray();
        try {
            JSONObject counts = new JSONObject(prefs.getString("runtimeGlyphMissCounts", "{}"));
            List<ErrorCount> ordered = new ArrayList<>();
            Iterator<String> keys = counts.keys();
            while (keys.hasNext()) {
                String key = keys.next();
                ordered.add(new ErrorCount(key, counts.optLong(key, 0L)));
            }
            Collections.sort(ordered);
            for (int i = 0; i < ordered.size() && i < 12; i += 1) {
                JSONObject item = new JSONObject();
                item.put("label", ordered.get(i).error);
                item.put("count", ordered.get(i).count);
                result.put(item);
            }
        } catch (Exception e) {}
        return result;
    }

    private static String runtimeGlyphMissKey(String url) {
        if (url == null || url.isEmpty()) return "";
        return "runtimeGlyphMiss:" + hashKey(canonicalKey(url));
    }

    private synchronized JSONObject getCurrentTaskErrorDebugInfo(boolean syncPrefs) {
        JSONObject result = new JSONObject();
        JSONObject byType = new JSONObject();
        JSONObject lastErrorCounts = new JSONObject();
        JSONArray topLastErrors = new JSONArray();
        JSONArray unsupportedGlyphRanges = new JSONArray();
        Set<String> unsupportedGlyphRangeSet = new LinkedHashSet<>();
        Map<String, Long> categoryCounts = new HashMap<>();
        int failedTaskCount = 0;
        int unsupportedGlyphRangeCount = 0;
        File[] files = tasksDir.listFiles();
        try {
            if (files != null) {
                Arrays.sort(files);
                for (int i = 0; i < files.length; i += 1) {
                    File f = files[i];
                    if (!f.getName().endsWith(".json")) continue;
                    JSONArray tasks;
                    try {
                        String raw = readTextFile(f);
                        tasks = raw == null || raw.isEmpty() ? new JSONArray() : new JSONArray(raw);
                    } catch (Exception e) {
                        continue;
                    }
                    boolean changed = false;
                    for (int j = 0; j < tasks.length(); j += 1) {
                        JSONObject task = tasks.optJSONObject(j);
                        if (task == null) continue;
                        if (isUnsupportedGlyphTask(task)) {
                            unsupportedGlyphRangeCount += 1;
                            String label = glyphRangeLabel(task.optString("url", ""));
                            if (!label.isEmpty()) unsupportedGlyphRangeSet.add(label);
                            String status = task.optString("status", "");
                            if (!"doneUnsupported".equals(status) && !"skippedUnsupported".equals(status)) {
                                task.put("status", "doneUnsupported");
                                task.put("unsupportedGlyphRange", true);
                                task.put("errorType", "unsupportedGlyphRange");
                                task.put("lastError", "unsupportedGlyphRange");
                                task.put("retryCount", 0);
                                task.put("nextRetryAt", 0L);
                                task.put("updatedAt", System.currentTimeMillis());
                                changed = true;
                            }
                            continue;
                        }
                        if (!"failed".equals(task.optString("status", ""))) continue;
                        failedTaskCount += 1;
                        String lastError = task.optString("lastError", "");
                        String category = normalizeErrorCategory(task.optString("errorType", ""), lastError);
                        categoryCounts.put(category, categoryCounts.containsKey(category) ? categoryCounts.get(category) + 1L : 1L);
                        String normalizedLastError = normalizeLastError(lastError);
                        lastErrorCounts.put(normalizedLastError, lastErrorCounts.optLong(normalizedLastError, 0L) + 1L);
                    }
                    if (changed) writeTextFile(f, tasks.toString());
                }
            }
            byType.put("HTTP 429", categoryCounts.containsKey("http429") ? categoryCounts.get("http429") : 0L);
            byType.put("HTTP 403", categoryCounts.containsKey("http403") ? categoryCounts.get("http403") : 0L);
            byType.put("HTTP 404", categoryCounts.containsKey("http404") ? categoryCounts.get("http404") : 0L);
            byType.put("timeout", categoryCounts.containsKey("timeout") ? categoryCounts.get("timeout") : 0L);
            byType.put("connection reset", categoryCounts.containsKey("connectionReset") ? categoryCounts.get("connectionReset") : 0L);
            byType.put("storage error", categoryCounts.containsKey("storage") ? categoryCounts.get("storage") : 0L);
            byType.put("tile too large", categoryCounts.containsKey("tileTooLarge") ? categoryCounts.get("tileTooLarge") : 0L);
            byType.put("empty response", categoryCounts.containsKey("emptyResponse") ? categoryCounts.get("emptyResponse") : 0L);
            byType.put("unknown", categoryCounts.containsKey("unknown") ? categoryCounts.get("unknown") : 0L);

            List<ErrorCount> ordered = new ArrayList<>();
            Iterator<String> keys = lastErrorCounts.keys();
            while (keys.hasNext()) {
                String key = keys.next();
                ordered.add(new ErrorCount(key, lastErrorCounts.optLong(key, 0L)));
            }
            Collections.sort(ordered);
            JSONObject cappedLastErrorCounts = new JSONObject();
            for (int i = 0; i < ordered.size() && i < 50; i += 1) {
                cappedLastErrorCounts.put(ordered.get(i).error, ordered.get(i).count);
                if (i < 8) {
                    JSONObject item = new JSONObject();
                    item.put("error", ordered.get(i).error);
                    item.put("count", ordered.get(i).count);
                    topLastErrors.put(item);
                }
            }
            for (String label : unsupportedGlyphRangeSet) {
                if (unsupportedGlyphRanges.length() >= 50) break;
                unsupportedGlyphRanges.put(label);
            }
            if (syncPrefs) {
                appContext.getSharedPreferences(DEBUG_PREFS_NAME, Context.MODE_PRIVATE).edit()
                    .putLong("errorHttp429", byType.optLong("HTTP 429", 0L))
                    .putLong("errorHttp403", byType.optLong("HTTP 403", 0L))
                    .putLong("errorHttp404", byType.optLong("HTTP 404", 0L))
                    .putLong("errorTimeout", byType.optLong("timeout", 0L))
                    .putLong("errorConnectionReset", byType.optLong("connection reset", 0L))
                    .putLong("errorStorage", byType.optLong("storage error", 0L))
                    .putLong("errorTileTooLarge", byType.optLong("tile too large", 0L))
                    .putLong("errorEmptyResponse", byType.optLong("empty response", 0L))
                    .putLong("errorUnknown", byType.optLong("unknown", 0L))
                    .putString("lastErrorCounts", cappedLastErrorCounts.toString())
                    .putLong("updatedAt", System.currentTimeMillis())
                    .apply();
            }
            result.put("byType", byType);
            result.put("topLastErrors", topLastErrors);
            result.put("failedTaskCount", failedTaskCount);
            result.put("unsupportedGlyphRangeCount", unsupportedGlyphRangeCount);
            result.put("unsupportedGlyphRanges", unsupportedGlyphRanges);
            result.put("source", "currentTasks");
        } catch (Exception e) {}
        return result;
    }

    public synchronized void recordDownloadError(String category, String lastError) {
        String normalizedCategory = normalizeErrorCategory(category, lastError);
        incrementDebugCounter(debugCounterKeyForErrorCategory(normalizedCategory), 1L);
        String normalizedLastError = normalizeLastError(lastError);
        SharedPreferences prefs = appContext.getSharedPreferences(DEBUG_PREFS_NAME, Context.MODE_PRIVATE);
        JSONObject counts;
        try {
            counts = new JSONObject(prefs.getString("lastErrorCounts", "{}"));
        } catch (Exception e) {
            counts = new JSONObject();
        }
        try {
            counts.put(normalizedLastError, counts.optLong(normalizedLastError, 0L) + 1L);
            List<ErrorCount> ordered = new ArrayList<>();
            Iterator<String> keys = counts.keys();
            while (keys.hasNext()) {
                String key = keys.next();
                ordered.add(new ErrorCount(key, counts.optLong(key, 0L)));
            }
            Collections.sort(ordered);
            JSONObject capped = new JSONObject();
            for (int i = 0; i < ordered.size() && i < 50; i += 1) {
                capped.put(ordered.get(i).error, ordered.get(i).count);
            }
            prefs.edit()
                .putString("lastErrorCounts", capped.toString())
                .putLong("updatedAt", System.currentTimeMillis())
                .apply();
        } catch (Exception e) {}
    }

    public synchronized JSONObject getErrorDebugInfo() {
        SharedPreferences prefs = appContext.getSharedPreferences(DEBUG_PREFS_NAME, Context.MODE_PRIVATE);
        JSONObject result = new JSONObject();
        JSONObject byType = new JSONObject();
        JSONArray topLastErrors = new JSONArray();
        try {
            byType.put("HTTP 429", prefs.getLong("errorHttp429", 0L));
            byType.put("HTTP 403", prefs.getLong("errorHttp403", 0L));
            byType.put("HTTP 404", prefs.getLong("errorHttp404", 0L));
            byType.put("timeout", prefs.getLong("errorTimeout", 0L));
            byType.put("connection reset", prefs.getLong("errorConnectionReset", 0L));
            byType.put("storage error", prefs.getLong("errorStorage", 0L));
            byType.put("tile too large", prefs.getLong("errorTileTooLarge", 0L));
            byType.put("empty response", prefs.getLong("errorEmptyResponse", 0L));
            byType.put("unknown", prefs.getLong("errorUnknown", 0L));
            JSONObject counts = new JSONObject(prefs.getString("lastErrorCounts", "{}"));
            List<ErrorCount> ordered = new ArrayList<>();
            Iterator<String> keys = counts.keys();
            while (keys.hasNext()) {
                String key = keys.next();
                ordered.add(new ErrorCount(key, counts.optLong(key, 0L)));
            }
            Collections.sort(ordered);
            for (int i = 0; i < ordered.size() && i < 8; i += 1) {
                JSONObject item = new JSONObject();
                item.put("error", ordered.get(i).error);
                item.put("count", ordered.get(i).count);
                topLastErrors.put(item);
            }
            result.put("byType", byType);
            result.put("topLastErrors", topLastErrors);
        } catch (Exception e) {}
        return result;
    }

    public synchronized void recordTiming(String key, long durationMs) {
        if (key == null || key.isEmpty() || durationMs < 0L) return;
        timingMsByKey.put(key, timingMsByKey.containsKey(key) ? timingMsByKey.get(key) + durationMs : durationMs);
        timingCountByKey.put(key, timingCountByKey.containsKey(key) ? timingCountByKey.get(key) + 1L : 1L);
    }

    public synchronized JSONObject getTimingDebugInfo() {
        JSONObject result = new JSONObject();
        try {
            for (int i = 0; i < TIMING_KEYS.length; i += 1) {
                String key = TIMING_KEYS[i];
                long ms = timingMsByKey.containsKey(key) ? timingMsByKey.get(key) : 0L;
                long count = timingCountByKey.containsKey(key) ? timingCountByKey.get(key) : 0L;
                JSONObject item = new JSONObject();
                item.put("ms", ms);
                item.put("count", count);
                item.put("avgMs", count > 0L ? ((double) ms / (double) count) : 0D);
                result.put(key, item);
            }
        } catch (Exception e) {}
        return result;
    }

    public synchronized void resetDebugCounters() {
        SharedPreferences.Editor editor = appContext.getSharedPreferences(DEBUG_PREFS_NAME, Context.MODE_PRIVATE).edit();
        editor.clear();
        editor.apply();
        timingMsByKey.clear();
        timingCountByKey.clear();
    }

    private static long elapsedMs(long startedNanos) {
        return Math.max(0L, (System.nanoTime() - startedNanos) / 1000000L);
    }

    private static String normalizeErrorCategory(String category, String lastError) {
        String raw = ((category == null ? "" : category) + " " + (lastError == null ? "" : lastError)).toLowerCase();
        if (raw.contains("429")) return "http429";
        if (raw.contains("403")) return "http403";
        if (raw.contains("404")) return "http404";
        if (raw.contains("timeout") || raw.contains("timed out") || raw.contains("sockettimeoutexception")) return "timeout";
        if (raw.contains("connection reset") || raw.contains("reset by peer") || raw.contains("connectionreset")) return "connectionReset";
        if (raw.contains("speicher") || raw.contains("storage") || raw.contains("no space") || raw.contains("enospc")) return "storage";
        if (raw.contains("too large") || raw.contains("groesser") || raw.contains("limit")) return "tileTooLarge";
        if (raw.contains("empty") || raw.contains("leere")) return "emptyResponse";
        return "unknown";
    }

    private static String debugCounterKeyForErrorCategory(String category) {
        if ("http429".equals(category)) return "errorHttp429";
        if ("http403".equals(category)) return "errorHttp403";
        if ("http404".equals(category)) return "errorHttp404";
        if ("timeout".equals(category)) return "errorTimeout";
        if ("connectionReset".equals(category)) return "errorConnectionReset";
        if ("storage".equals(category)) return "errorStorage";
        if ("tileTooLarge".equals(category)) return "errorTileTooLarge";
        if ("emptyResponse".equals(category)) return "errorEmptyResponse";
        return "errorUnknown";
    }

    private static String normalizeLastError(String value) {
        String text = value == null ? "" : value.trim();
        if (text.isEmpty()) return "unknown";
        if (text.length() > 120) text = text.substring(0, 120);
        return text;
    }

    private static class ErrorCount implements Comparable<ErrorCount> {
        final String error;
        final long count;
        ErrorCount(String error, long count) {
            this.error = error == null ? "unknown" : error;
            this.count = count;
        }
        @Override public int compareTo(ErrorCount other) {
            if (other == null) return -1;
            if (other.count == count) return error.compareTo(other.error);
            return other.count > count ? 1 : -1;
        }
    }

    private static boolean isRunningLikeStatus(String status) {
        if (status == null) return false;
        String s = status.trim().toLowerCase();
        return "running".equals(s)
            || "downloading".equals(s)
            || "wird heruntergeladen".equals(s)
            || "wartet".equals(s)
            || "pending".equals(s);
    }

    private static void deleteFolderContents(File folder) {
        if (folder == null || !folder.exists()) return;
        File[] files = folder.listFiles();
        if (files == null) return;
        for (int i = 0; i < files.length; i += 1) files[i].delete();
    }

    private static Set<String> readOwnersFromSidecar(JSONObject sidecar) {
        Set<String> owners = new LinkedHashSet<>();
        if (sidecar == null) return owners;
        JSONArray ownerIds = sidecar.optJSONArray("ownerIds");
        if (ownerIds != null) {
            for (int i = 0; i < ownerIds.length(); i += 1) {
                String value = ownerIds.optString(i, "");
                if (!value.isEmpty()) owners.add(value);
            }
        }
        JSONArray regionIds = sidecar.optJSONArray("regionIds");
        if (regionIds != null) {
            for (int i = 0; i < regionIds.length(); i += 1) {
                String value = regionIds.optString(i, "");
                if (!value.isEmpty()) owners.add(value);
            }
        }
        return owners;
    }

    private static void writeOwnersToSidecar(JSONObject sidecar, Set<String> owners) {
        try {
            JSONArray ownerArr = new JSONArray();
            JSONArray regionArr = new JSONArray();
            for (String owner : owners) {
                if (owner == null || owner.isEmpty()) continue;
                ownerArr.put(owner);
                regionArr.put(owner);
            }
            sidecar.put("ownerIds", ownerArr);
            sidecar.put("regionIds", regionArr);
            sidecar.put("refCount", ownerArr.length());
        } catch (Exception e) {}
    }

    private static String sanitizeId(String value) {
        StringBuilder out = new StringBuilder(value.length());
        for (int i = 0; i < value.length(); i += 1) {
            char c = value.charAt(i);
            if ((c >= '0' && c <= '9') || (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c == '-' || c == '_') {
                out.append(c);
            } else {
                out.append('_');
            }
        }
        String s = out.toString();
        return s.length() > 64 ? s.substring(0, 64) : s;
    }

    private static JSONObject readJsonFile(File file) {
        try {
            FileInputStream fis = new FileInputStream(file);
            try {
                ByteArrayOutputStream out = new ByteArrayOutputStream((int) Math.max(64, file.length()));
                byte[] buffer = new byte[4096];
                int n;
                while ((n = fis.read(buffer)) > 0) out.write(buffer, 0, n);
                String content = out.toString(StandardCharsets.UTF_8.name());
                if (content.isEmpty()) return null;
                return new JSONObject(content);
            } finally {
                try { fis.close(); } catch (IOException ignored) {}
            }
        } catch (Exception e) {
            return null;
        }
    }

    private static String readTextFile(File file) {
        try {
            FileInputStream fis = new FileInputStream(file);
            try {
                ByteArrayOutputStream out = new ByteArrayOutputStream((int) Math.max(64, file.length()));
                byte[] buffer = new byte[4096];
                int n;
                while ((n = fis.read(buffer)) > 0) out.write(buffer, 0, n);
                return out.toString(StandardCharsets.UTF_8.name());
            } finally {
                try { fis.close(); } catch (IOException ignored) {}
            }
        } catch (Exception e) {
            return null;
        }
    }

    private static JSONObject readJsonFileOrEmpty(File file) {
        JSONObject value = readJsonFile(file);
        return value != null ? value : new JSONObject();
    }

    private static void writeJsonFile(File file, JSONObject body) {
        writeTextFile(file, body.toString());
    }

    private static void writeTextFile(File file, String body) {
        try {
            File tmp = new File(file.getParent(), file.getName() + ".tmp");
            FileOutputStream fos = new FileOutputStream(tmp);
            try { fos.write(String.valueOf(body).getBytes(StandardCharsets.UTF_8)); }
            finally { try { fos.close(); } catch (IOException ignored) {} }
            if (file.exists()) file.delete();
            tmp.renameTo(file);
        } catch (Exception e) {}
    }
}
