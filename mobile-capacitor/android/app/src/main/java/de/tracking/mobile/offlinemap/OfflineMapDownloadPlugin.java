package de.tracking.mobile.offlinemap;

import android.app.NotificationManager;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.SharedPreferences;
import android.os.Build;
import android.util.Base64;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.lang.ref.WeakReference;
import java.nio.charset.StandardCharsets;
import java.util.Iterator;
import java.util.Set;

@CapacitorPlugin(name = "OfflineMapDownload")
public class OfflineMapDownloadPlugin extends Plugin {

    private static WeakReference<OfflineMapDownloadPlugin> activePluginRef = new WeakReference<>(null);
    private static final long DEFAULT_ESTIMATED_URL_BYTES = 32L * 1024L;
    private static final long STORAGE_RESERVE_BYTES = 256L * 1024L * 1024L;
    private BroadcastReceiver progressReceiver = null;

    @Override
    public void load() {
        super.load();
        activePluginRef = new WeakReference<>(this);
        registerProgressReceiver();
        try {
            OfflineMapCacheStore.getInstance(getContext()).recoverStaleDownloads(OfflineMapDownloadService.isActive());
        } catch (Exception ignored) {}
    }

    @Override
    protected void handleOnDestroy() {
        unregisterProgressReceiver();
        OfflineMapDownloadPlugin current = activePluginRef.get();
        if (current == this) activePluginRef = new WeakReference<>(null);
        super.handleOnDestroy();
    }

    @PluginMethod
    public void startDownload(PluginCall call) {
        if (OfflineMapDownloadService.isActive()) {
            call.reject("Ein Download läuft bereits");
            return;
        }
        JSONArray regionsArr = call.getArray("regions");
        if (regionsArr == null || regionsArr.length() == 0) {
            call.reject("regions fehlt oder leer");
            return;
        }
        OfflineMapCacheStore store = OfflineMapCacheStore.getInstance(getContext());
        File downloadDir = new File(getContext().getFilesDir(), "offline_map_download_queue");
        if (!downloadDir.exists()) downloadDir.mkdirs();

        long estimatedMissingBytes = 0L;
        try {
            for (int i = 0; i < regionsArr.length(); i += 1) {
                JSONObject regionObj = regionsArr.getJSONObject(i);
                String regionId = sanitize(regionObj.optString("regionId", ""), "");
                if (regionId.isEmpty()) {
                    call.reject("regionId fehlt fuer Eintrag " + i);
                    return;
                }
                JSONArray urls = regionObj.optJSONArray("urls");
                if (urls == null || urls.length() == 0) {
                    call.reject("urls fehlt fuer Region " + regionId);
                    return;
                }
                estimatedMissingBytes += estimateMissingBytes(store, regionObj, urls);
            }
            String storageError = storagePreflightError(estimatedMissingBytes);
            if (storageError != null) {
                call.reject(storageError);
                return;
            }
        } catch (Exception e) {
            call.reject("Speicherplatz-Pruefung fehlgeschlagen: " + e.getMessage());
            return;
        }

        JSONArray queueArr = new JSONArray();
        try {
            for (int i = 0; i < regionsArr.length(); i += 1) {
                JSONObject regionObj = regionsArr.getJSONObject(i);
                String regionId = sanitize(regionObj.optString("regionId", ""), "");
                if (regionId.isEmpty()) {
                    call.reject("regionId fehlt für Eintrag " + i);
                    return;
                }
                String regionName = sanitize(regionObj.optString("regionName", "Karte"), "Karte");
                String styleLabel = sanitize(regionObj.optString("styleLabel", ""), "");
                JSONObject regionRecord = regionObj.optJSONObject("regionRecord");
                JSONArray urls = regionObj.optJSONArray("urls");
                if (urls == null || urls.length() == 0) {
                    call.reject("urls fehlt für Region " + regionId);
                    return;
                }
                store.putRegionPlan(regionId, urls);
                JSONArray taskList = store.ensureTaskListForPlan(regionId, urls);
                JSONObject taskSummary = store.summarizeTasks(regionId, taskList);
                long regionEstimatedBytes = estimateMissingBytes(store, regionObj, urls);
                String jobId = "job_" + regionId;
                if (regionRecord != null) {
                    regionRecord.put("id", regionId);
                    regionRecord.put("name", regionName);
                    regionRecord.put("jobId", jobId);
                    regionRecord.put("status", "wartet");
                    regionRecord.put("ready", false);
                    regionRecord.put("tileTotal", urls.length());
                    regionRecord.put("estimatedMissingBytes", regionEstimatedBytes);
                    regionRecord.put("updatedAt", System.currentTimeMillis());
                    store.putRegion(regionRecord);
                }
                JSONObject jobPatch = new JSONObject();
                jobPatch.put("jobId", jobId);
                jobPatch.put("regionId", regionId);
                jobPatch.put("queueIndex", i);
                jobPatch.put("queueTotal", regionsArr.length());
                jobPatch.put("status", "pending");
                jobPatch.put("profile", regionRecord != null ? regionRecord.optString("profile", "") : "");
                jobPatch.put("totalUrls", urls.length());
                jobPatch.put("doneUrls", taskSummary.optInt("doneUrls", 0));
                jobPatch.put("failedUrls", taskSummary.optInt("failedUrls", 0));
                jobPatch.put("chunkIndex", 0);
                jobPatch.put("chunkSize", 512);
                jobPatch.put("chunkStatus", "pending");
                jobPatch.put("verifyStatus", "not_started");
                store.upsertJob(regionId, jobPatch);
                File urlsFile = new File(downloadDir, "urls_" + sanitizeFileName(regionId) + ".json");
                FileOutputStream fos = new FileOutputStream(urlsFile);
                try { fos.write(urls.toString().getBytes(StandardCharsets.UTF_8)); }
                finally { try { fos.close(); } catch (Exception ignored) {} }

                JSONObject queueEntry = new JSONObject();
                queueEntry.put("regionId", regionId);
                queueEntry.put("regionName", regionName);
                queueEntry.put("styleLabel", styleLabel);
                queueEntry.put("urlsFilePath", urlsFile.getAbsolutePath());
                queueEntry.put("jobId", jobId);
                if (regionRecord != null) queueEntry.put("regionRecord", regionRecord);
                queueArr.put(queueEntry);
            }
        } catch (Exception e) {
            call.reject("Queue konnte nicht vorbereitet werden: " + e.getMessage());
            return;
        }

        File queueFile = new File(downloadDir, "queue_" + System.currentTimeMillis() + ".json");
        try {
            FileOutputStream fos = new FileOutputStream(queueFile);
            try { fos.write(queueArr.toString().getBytes(StandardCharsets.UTF_8)); }
            finally { try { fos.close(); } catch (Exception ignored) {} }
        } catch (Exception e) {
            call.reject("Queue-Datei konnte nicht geschrieben werden: " + e.getMessage());
            return;
        }

        Intent intent = new Intent(getContext(), OfflineMapDownloadService.class);
        intent.setAction(OfflineMapDownloadService.ACTION_START);
        intent.putExtra(OfflineMapDownloadService.EXTRA_QUEUE_FILE_PATH, queueFile.getAbsolutePath());
        try { startService(intent); } catch (Exception startError) {
            call.reject("Service konnte nicht gestartet werden: " + startError.getMessage());
            return;
        }
        JSObject result = new JSObject();
        result.put("started", true);
        result.put("queueSize", regionsArr.length());
        call.resolve(result);
    }

    @PluginMethod
    public void cancelDownload(PluginCall call) {
        Intent intent = new Intent(getContext(), OfflineMapDownloadService.class);
        intent.setAction(OfflineMapDownloadService.ACTION_CANCEL);
        try { startService(intent); } catch (Exception ignored) {}
        OfflineMapDownloadService.requestCancel();
        JSObject result = new JSObject();
        result.put("cancelled", true);
        call.resolve(result);
    }

    @PluginMethod
    public void getDownloadStatus(PluginCall call) {
        SharedPreferences prefs = getContext().getSharedPreferences(OfflineMapDownloadService.PREFS_NAME, Context.MODE_PRIVATE);
        boolean active = prefs.getBoolean(OfflineMapDownloadService.KEY_ACTIVE, false) && OfflineMapDownloadService.isActive();
        if (!active) {
            try {
                OfflineMapCacheStore.getInstance(getContext()).recoverStaleDownloads(false);
            } catch (Exception ignored) {}
        }
        JSObject result = new JSObject();
        result.put("active", active);
        if (active) {
            result.put("regionId", prefs.getString(OfflineMapDownloadService.KEY_REGION_ID, ""));
            result.put("regionName", prefs.getString(OfflineMapDownloadService.KEY_REGION_NAME, ""));
            result.put("styleLabel", prefs.getString(OfflineMapDownloadService.KEY_STYLE_LABEL, ""));
            result.put("downloaded", prefs.getInt(OfflineMapDownloadService.KEY_DOWNLOADED, 0));
            result.put("total", prefs.getInt(OfflineMapDownloadService.KEY_TOTAL, 0));
            result.put("failed", prefs.getInt(OfflineMapDownloadService.KEY_FAILED, 0));
            int downloaded = prefs.getInt(OfflineMapDownloadService.KEY_DOWNLOADED, 0);
            int total = prefs.getInt(OfflineMapDownloadService.KEY_TOTAL, 0);
            int failed = prefs.getInt(OfflineMapDownloadService.KEY_FAILED, 0);
            int processed = Math.min(Math.max(0, total), Math.max(0, downloaded) + Math.max(0, failed));
            result.put("processed", processed);
            result.put("missing", Math.max(0, total - processed));
            result.put("phase", prefs.getString(OfflineMapDownloadService.KEY_PHASE, "tiles"));
            result.put("message", prefs.getString(OfflineMapDownloadService.KEY_MESSAGE, ""));
            result.put("queueIndex", prefs.getInt(OfflineMapDownloadService.KEY_QUEUE_INDEX, 0));
            result.put("queueTotal", prefs.getInt(OfflineMapDownloadService.KEY_QUEUE_TOTAL, 0));
        }
        call.resolve(result);
    }

    @PluginMethod
    public void listRegions(PluginCall call) {
        try {
            OfflineMapCacheStore store = OfflineMapCacheStore.getInstance(getContext());
            JSONArray regions = store.listRegions();
            JSObject result = new JSObject();
            result.put("regions", jsonArrayToJSArray(regions));
            call.resolve(result);
        } catch (Exception e) {
            call.reject("Konnte Regionen nicht laden: " + e.getMessage());
        }
    }

    @PluginMethod
    public void deleteRegion(PluginCall call) {
        String regionId = sanitize(call.getString("regionId", ""), "");
        if (regionId.isEmpty()) {
            call.reject("regionId fehlt");
            return;
        }
        OfflineMapCacheStore store = OfflineMapCacheStore.getInstance(getContext());
        Set<String> regionUrls = store.findUrlsForRegion(regionId);
        Iterator<String> iter = regionUrls.iterator();
        while (iter.hasNext()) {
            store.detachRegionFromUrl(iter.next(), regionId);
        }
        boolean removed = store.deleteRegion(regionId);
        JSObject result = new JSObject();
        result.put("removed", removed);
        result.put("urls", regionUrls.size());
        call.resolve(result);
    }

    @PluginMethod
    public void clearAllRegions(PluginCall call) {
        OfflineMapCacheStore store = OfflineMapCacheStore.getInstance(getContext());
        store.wipeAll();
        JSObject result = new JSObject();
        result.put("cleared", true);
        call.resolve(result);
    }

    @PluginMethod
    public void getStorageInfo(PluginCall call) {
        OfflineMapCacheStore store = OfflineMapCacheStore.getInstance(getContext());
        JSONObject stored = store.getStoredStorageInfo();
        JSObject result = new JSObject();
        result.put("totalBytes", stored.optLong("totalBytes", 0L));
        result.put("totalTiles", stored.optInt("totalTiles", 0));
        result.put("regions", stored.optInt("regions", 0));
        result.put("availableBytes", stored.optLong("availableBytes", getContext().getFilesDir().getUsableSpace()));
        call.resolve(result);
    }

    @PluginMethod
    public void recoverOfflineState(PluginCall call) {
        try {
            OfflineMapCacheStore store = OfflineMapCacheStore.getInstance(getContext());
            JSONObject recovery = store.recoverStaleDownloads(OfflineMapDownloadService.isActive());
            call.resolve(new JSObject(recovery.toString()));
        } catch (Exception e) {
            call.reject("Offline-Recovery fehlgeschlagen: " + e.getMessage());
        }
    }

    @PluginMethod
    public void getDebugInfo(PluginCall call) {
        try {
            OfflineMapCacheStore store = OfflineMapCacheStore.getInstance(getContext());
            JSONObject debug = store.getDebugInfo(OfflineMapDownloadService.isActive());
            call.resolve(new JSObject(debug.toString()));
        } catch (Exception e) {
            call.reject("Offline-Debug konnte nicht geladen werden: " + e.getMessage());
        }
    }

    @PluginMethod
    public void verifyOfflineIntegrity(PluginCall call) {
        try {
            OfflineMapCacheStore store = OfflineMapCacheStore.getInstance(getContext());
            String onlyRegionId = sanitize(call.getString("regionId", ""), "");
            JSONArray regions = store.listRegions();
            int checked = 0;
            int failed = 0;
            for (int i = 0; i < regions.length(); i += 1) {
                JSONObject region = regions.optJSONObject(i);
                if (region == null) continue;
                String regionId = region.optString("id", "");
                if (!onlyRegionId.isEmpty() && !onlyRegionId.equals(regionId)) continue;
                JSONObject verify = store.verifyRegionPlan(regionId);
                JSONObject taskSummary = store.summarizeTasks(regionId);
                int failedUrls = taskSummary.optInt("failedUrls", verify.optInt("missing", 0));
                boolean ready = "passed".equals(verify.optString("verifyStatus", ""))
                    && verify.optBoolean("complete", false)
                    && failedUrls == 0
                    && verify.optInt("missing", 0) == 0
                    && verify.optInt("requiredMissing", 0) == 0;
                String status = ready ? "bereit" : (verify.optInt("requiredMissing", 0) > 0 ? "beschaedigt" : "fortsetzbar");
                region.put("status", status);
                region.put("ready", ready);
                region.put("verify", verify);
                region.put("verifyStatus", verify.optString("verifyStatus", ready ? "passed" : "failed"));
                region.put("tileCount", verify.optInt("present", region.optInt("tileCount", 0)));
                region.put("tileTotal", verify.optInt("total", region.optInt("tileTotal", 0)));
                region.put("missing", verify.optInt("missing", 0));
                region.put("requiredMissing", verify.optInt("requiredMissing", 0));
                region.put("missingOptionalTiles", verify.optInt("missingOptionalTiles", 0));
                region.put("resourceMissing", verify.optInt("resourceMissing", 0));
                region.put("missingTiles", verify.optInt("missingTiles", verify.optInt("missing", 0)));
                region.put("missingGlyphs", verify.optInt("missingGlyphs", 0));
                region.put("missingSprites", verify.optInt("missingSprites", 0));
                JSONArray missingGlyphRanges = verify.optJSONArray("missingGlyphRanges");
                if (missingGlyphRanges != null) region.put("missingGlyphRanges", missingGlyphRanges);
                region.put("unsupportedGlyphRangeCount", verify.optInt("unsupportedGlyphRangeCount", 0));
                JSONArray unsupportedGlyphRanges = verify.optJSONArray("unsupportedGlyphRanges");
                if (unsupportedGlyphRanges != null) region.put("unsupportedGlyphRanges", unsupportedGlyphRanges);
                region.put("lastVerifyAt", verify.optLong("lastVerifyAt", System.currentTimeMillis()));
                region.put("updatedAt", System.currentTimeMillis());
                store.putRegion(region);
                JSONObject jobPatch = new JSONObject();
                jobPatch.put("status", ready ? "done" : (verify.optInt("requiredMissing", 0) > 0 ? "failed" : "fortsetzbar"));
                jobPatch.put("doneUrls", verify.optInt("present", 0));
                jobPatch.put("failedUrls", ready ? 0 : failedUrls);
                jobPatch.put("verifyStatus", verify.optString("verifyStatus", ready ? "passed" : "failed"));
                jobPatch.put("missingRequired", verify.optInt("requiredMissing", 0));
                jobPatch.put("missingOptionalTiles", verify.optInt("missingOptionalTiles", 0));
                jobPatch.put("resourceMissing", verify.optInt("resourceMissing", 0));
                jobPatch.put("missingTiles", verify.optInt("missingTiles", verify.optInt("missing", 0)));
                jobPatch.put("missingGlyphs", verify.optInt("missingGlyphs", 0));
                jobPatch.put("missingSprites", verify.optInt("missingSprites", 0));
                if (missingGlyphRanges != null) jobPatch.put("missingGlyphRanges", missingGlyphRanges);
                jobPatch.put("unsupportedGlyphRangeCount", verify.optInt("unsupportedGlyphRangeCount", 0));
                if (unsupportedGlyphRanges != null) jobPatch.put("unsupportedGlyphRanges", unsupportedGlyphRanges);
                jobPatch.put("lastVerifyAt", verify.optLong("lastVerifyAt", System.currentTimeMillis()));
                store.upsertJob(regionId, jobPatch);
                checked += 1;
                if (!ready) failed += 1;
            }
            JSONObject debug = store.getDebugInfo(OfflineMapDownloadService.isActive());
            debug.put("checkedRegions", checked);
            debug.put("failedRegions", failed);
            call.resolve(new JSObject(debug.toString()));
        } catch (Exception e) {
            call.reject("Offline-Integritaet konnte nicht geprueft werden: " + e.getMessage());
        }
    }

    @PluginMethod
    public void repairStaleJobs(PluginCall call) {
        recoverOfflineState(call);
    }

    @PluginMethod
    public void hasUrl(PluginCall call) {
        String url = call.getString("url", "");
        OfflineMapCacheStore store = OfflineMapCacheStore.getInstance(getContext());
        boolean cached = url != null && !url.isEmpty() && store.hasUrl(url);
        if (!cached && url != null && !url.isEmpty()) {
            try { cached = !store.findCachedUrlByCanonicalBase(url).isEmpty(); } catch (Exception ignored) {}
        }
        JSObject result = new JSObject();
        result.put("cached", cached);
        call.resolve(result);
    }

    @PluginMethod
    public void readCachedResource(PluginCall call) {
        String url = call.getString("url", "");
        JSObject result = new JSObject();
        result.put("found", false);
        if (url == null || url.isEmpty()) {
            call.resolve(result);
            return;
        }
        try {
            OfflineMapCacheStore store = OfflineMapCacheStore.getInstance(getContext());
            String lookupUrl = resolveCachedLookupUrl(store, url);
            if (lookupUrl.isEmpty()) {
                call.resolve(result);
                return;
            }
            byte[] bytes = store.readBytes(lookupUrl);
            if (bytes == null || bytes.length == 0) {
                call.resolve(result);
                return;
            }
            String contentType = store.readContentType(lookupUrl);
            result.put("found", true);
            result.put("mimeType", guessCachedResourceMimeType(url, contentType));
            result.put("base64", Base64.encodeToString(bytes, Base64.NO_WRAP));
            call.resolve(result);
        } catch (Exception e) {
            call.reject("Cache read failed: " + e.getMessage());
        }
    }

    @PluginMethod
    public void storeResource(PluginCall call) {
        String url = call.getString("url", "");
        String contentType = call.getString("contentType", "");
        String base64 = call.getString("base64", "");
        if (url == null || url.isEmpty()) {
            call.reject("url fehlt");
            return;
        }
        if (base64 == null || base64.isEmpty()) {
            call.reject("base64 fehlt");
            return;
        }
        try {
            byte[] bytes = Base64.decode(base64, Base64.DEFAULT);
            if (bytes == null || bytes.length == 0) {
                call.reject("Leere Ressource");
                return;
            }
            OfflineMapCacheStore store = OfflineMapCacheStore.getInstance(getContext());
            store.writeEntry(url, bytes, contentType, "restore-dependency");
            JSObject result = new JSObject();
            result.put("cached", store.hasUrl(url));
            result.put("size", bytes.length);
            call.resolve(result);
        } catch (Exception e) {
            call.reject("Ressource konnte nicht gespeichert werden: " + e.getMessage());
        }
    }

    @PluginMethod
    public void getRegionDetails(PluginCall call) {
        String regionId = sanitize(call.getString("regionId", ""), "");
        if (regionId.isEmpty()) {
            call.reject("regionId fehlt");
            return;
        }
        try {
            OfflineMapCacheStore store = OfflineMapCacheStore.getInstance(getContext());
            JSONObject record = store.getRegion(regionId);
            JSONArray plan = store.getRegionPlan(regionId);
            JSONObject verify = store.verifyRegionPlan(regionId, plan);
            JSObject result = new JSObject();
            result.put("regionId", regionId);
            result.put("region", record != null ? new JSObject(record.toString()) : new JSObject());
            result.put("verify", new JSObject(verify.toString()));
            result.put("planTotal", plan != null ? plan.length() : 0);
            call.resolve(result);
        } catch (Exception e) {
            call.reject("Details konnten nicht geladen werden: " + e.getMessage());
        }
    }

    @PluginMethod
    public void resumeRegion(PluginCall call) {
        startStoredRegion(call, "fortsetzen");
    }

    @PluginMethod
    public void repairRegion(PluginCall call) {
        startStoredRegion(call, "reparieren");
    }

    @PluginMethod
    public void dismissCompletionNotification(PluginCall call) {
        NotificationManager manager = (NotificationManager) getContext().getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager != null) {
            try { manager.cancel(OfflineMapDownloadService.NOTIFICATION_ID + 1); } catch (SecurityException ignored) {}
            try { manager.cancel(OfflineMapDownloadService.NOTIFICATION_ID + 2); } catch (SecurityException ignored) {}
        }
        call.resolve();
    }

    public static void notifyCancelFromNotification() {
        OfflineMapDownloadPlugin plugin = activePluginRef.get();
        if (plugin == null) return;
        try { plugin.notifyListeners("cancel", new JSObject().put("source", "notification")); }
        catch (Exception ignored) {}
    }

    public static void notifyOpenSheetFromIntent() {
        OfflineMapDownloadPlugin plugin = activePluginRef.get();
        if (plugin == null) return;
        try { plugin.notifyListeners("openSheet", new JSObject().put("source", "notification")); }
        catch (Exception ignored) {}
    }

    private void startStoredRegion(PluginCall call, String actionLabel) {
        if (OfflineMapDownloadService.isActive()) {
            call.reject("Ein Download laeuft bereits");
            return;
        }
        String regionId = sanitize(call.getString("regionId", ""), "");
        if (regionId.isEmpty()) {
            call.reject("regionId fehlt");
            return;
        }
        try {
            OfflineMapCacheStore store = OfflineMapCacheStore.getInstance(getContext());
            JSONArray urls = store.getRegionPlan(regionId);
            if (urls == null || urls.length() == 0) {
                call.reject("Kein gespeicherter Download-Plan fuer diese Region");
                return;
            }
            long estimatedBytes = estimateMissingBytes(store, null, urls);
            String storageError = storagePreflightError(estimatedBytes);
            if (storageError != null) {
                call.reject(storageError);
                return;
            }
            JSONArray taskList = store.ensureTaskListForPlan(regionId, urls);
            JSONObject taskSummary = store.summarizeTasks(regionId, taskList);
            String jobId = "job_" + regionId;
            JSONObject record = store.getRegion(regionId);
            if (record == null) record = new JSONObject();
            String regionName = sanitize(record.optString("name", "Karte"), "Karte");
            String styleLabel = sanitize(record.optString("styleLabel", ""), "");
            record.put("id", regionId);
            record.put("jobId", jobId);
            record.put("status", "wartet");
            record.put("ready", false);
            record.put("estimatedMissingBytes", estimatedBytes);
            record.put("updatedAt", System.currentTimeMillis());
            store.putRegion(record);
            JSONObject jobPatch = new JSONObject();
            jobPatch.put("jobId", jobId);
            jobPatch.put("regionId", regionId);
            jobPatch.put("queueIndex", 0);
            jobPatch.put("queueTotal", 1);
            jobPatch.put("status", "pending");
            jobPatch.put("profile", record.optString("profile", ""));
            jobPatch.put("totalUrls", urls.length());
            jobPatch.put("doneUrls", taskSummary.optInt("doneUrls", 0));
            jobPatch.put("failedUrls", taskSummary.optInt("failedUrls", 0));
            jobPatch.put("chunkIndex", 0);
            jobPatch.put("chunkSize", 512);
            jobPatch.put("chunkStatus", "pending");
            jobPatch.put("verifyStatus", "not_started");
            store.upsertJob(regionId, jobPatch);

            File downloadDir = new File(getContext().getFilesDir(), "offline_map_download_queue");
            if (!downloadDir.exists()) downloadDir.mkdirs();
            File urlsFile = new File(downloadDir, "urls_" + sanitizeFileName(regionId) + "_" + System.currentTimeMillis() + ".json");
            if (!writeTextFile(urlsFile, urls.toString())) {
                call.reject("URL-Datei konnte nicht geschrieben werden");
                return;
            }
            JSONArray queueArr = new JSONArray();
            JSONObject queueEntry = new JSONObject();
            queueEntry.put("regionId", regionId);
            queueEntry.put("regionName", regionName);
            queueEntry.put("styleLabel", styleLabel);
            queueEntry.put("urlsFilePath", urlsFile.getAbsolutePath());
            queueEntry.put("jobId", jobId);
            queueEntry.put("regionRecord", record);
            queueArr.put(queueEntry);
            File queueFile = new File(downloadDir, "queue_" + actionLabel + "_" + System.currentTimeMillis() + ".json");
            if (!writeTextFile(queueFile, queueArr.toString())) {
                call.reject("Queue-Datei konnte nicht geschrieben werden");
                return;
            }

            Intent intent = new Intent(getContext(), OfflineMapDownloadService.class);
            intent.setAction(OfflineMapDownloadService.ACTION_START);
            intent.putExtra(OfflineMapDownloadService.EXTRA_QUEUE_FILE_PATH, queueFile.getAbsolutePath());
            startService(intent);
            JSObject result = new JSObject();
            result.put("started", true);
            result.put("regionId", regionId);
            result.put("action", actionLabel);
            call.resolve(result);
        } catch (Exception e) {
            call.reject("Region konnte nicht gestartet werden: " + e.getMessage());
        }
    }

    private long estimateMissingBytes(OfflineMapCacheStore store, JSONObject regionObj, JSONArray urls) {
        if (urls == null || urls.length() == 0) return 0L;
        int missing = 0;
        for (int i = 0; i < urls.length(); i += 1) {
            JSONObject entry = urls.optJSONObject(i);
            String url = entry != null ? entry.optString("url", "") : "";
            if (!url.isEmpty() && !store.hasUrl(url)) missing += 1;
        }
        long defaultEstimate = Math.max(0L, missing * DEFAULT_ESTIMATED_URL_BYTES);
        long declaredEstimate = 0L;
        if (regionObj != null) {
            declaredEstimate = regionObj.optLong("estimatedBytes", 0L);
            JSONObject record = regionObj.optJSONObject("regionRecord");
            if (declaredEstimate <= 0L && record != null) {
                declaredEstimate = record.optLong("estimatedMissingBytes", record.optLong("estimatedBytes", 0L));
            }
        }
        if (declaredEstimate > 0L) {
            long scaled = Math.round(((double) declaredEstimate) * ((double) missing / (double) Math.max(1, urls.length())));
            return Math.max(defaultEstimate, scaled);
        }
        return defaultEstimate;
    }

    private String storagePreflightError(long estimatedMissingBytes) {
        if (estimatedMissingBytes <= 0L) return null;
        long reserve = Math.max(STORAGE_RESERVE_BYTES, estimatedMissingBytes / 5L);
        long required = estimatedMissingBytes + reserve;
        long usable = getContext().getFilesDir().getUsableSpace();
        if (usable >= required) return null;
        return "Zu wenig freier Speicher fuer Offline-Download: benoetigt ca. "
            + (required / (1024L * 1024L))
            + " MB, frei "
            + (usable / (1024L * 1024L))
            + " MB";
    }

    private void registerProgressReceiver() {
        if (progressReceiver != null) return;
        progressReceiver = new BroadcastReceiver() {
            @Override
            public void onReceive(Context context, Intent intent) {
                if (intent == null || !OfflineMapDownloadService.BROADCAST_PROGRESS.equals(intent.getAction())) return;
                String eventType = intent.getStringExtra(OfflineMapDownloadService.BROADCAST_EVENT_TYPE);
                if (eventType == null) eventType = "progress";
                JSObject payload = new JSObject();
                payload.put("regionId", intent.getStringExtra(OfflineMapDownloadService.BROADCAST_REGION_ID));
                payload.put("regionName", intent.getStringExtra(OfflineMapDownloadService.BROADCAST_REGION_NAME));
                payload.put("downloaded", intent.getIntExtra(OfflineMapDownloadService.BROADCAST_DOWNLOADED, 0));
                payload.put("total", intent.getIntExtra(OfflineMapDownloadService.BROADCAST_TOTAL, 0));
                payload.put("failed", intent.getIntExtra(OfflineMapDownloadService.BROADCAST_FAILED, 0));
                payload.put("processed", intent.getIntExtra(OfflineMapDownloadService.BROADCAST_PROCESSED, 0));
                payload.put("missing", intent.getIntExtra(OfflineMapDownloadService.BROADCAST_MISSING, 0));
                payload.put("workers", intent.getIntExtra(OfflineMapDownloadService.BROADCAST_WORKERS, 0));
                payload.put("phase", intent.getStringExtra(OfflineMapDownloadService.BROADCAST_PHASE));
                payload.put("queueIndex", intent.getIntExtra(OfflineMapDownloadService.BROADCAST_QUEUE_INDEX, 0));
                payload.put("queueTotal", intent.getIntExtra(OfflineMapDownloadService.BROADCAST_QUEUE_TOTAL, 0));
                String message = intent.getStringExtra(OfflineMapDownloadService.BROADCAST_MESSAGE);
                if (message != null && !message.isEmpty()) payload.put("message", message);
                String regionRecordJson = intent.getStringExtra(OfflineMapDownloadService.BROADCAST_REGION_RECORD);
                if (regionRecordJson != null && !regionRecordJson.isEmpty()) {
                    try { payload.put("regionRecord", new JSObject(regionRecordJson)); } catch (Exception ignored) {}
                }
                String completedJson = intent.getStringExtra(OfflineMapDownloadService.BROADCAST_COMPLETED_REGION_IDS);
                if (completedJson != null && !completedJson.isEmpty()) {
                    try {
                        JSONArray arr = new JSONArray(completedJson);
                        com.getcapacitor.JSArray jsArr = new com.getcapacitor.JSArray();
                        for (int i = 0; i < arr.length(); i += 1) jsArr.put(arr.get(i));
                        payload.put("completedRegionIds", jsArr);
                    } catch (Exception ignored) {}
                }
                try { notifyListeners(eventType, payload); } catch (Exception ignored) {}
            }
        };
        IntentFilter filter = new IntentFilter(OfflineMapDownloadService.BROADCAST_PROGRESS);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            getContext().registerReceiver(progressReceiver, filter, Context.RECEIVER_NOT_EXPORTED);
        } else {
            getContext().registerReceiver(progressReceiver, filter);
        }
    }

    private void unregisterProgressReceiver() {
        if (progressReceiver == null) return;
        try { getContext().unregisterReceiver(progressReceiver); } catch (Exception ignored) {}
        progressReceiver = null;
    }

    private void startService(Intent intent) {
        Context context = getContext();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            context.startForegroundService(intent);
        } else {
            context.startService(intent);
        }
    }

    private static String sanitize(String value, String fallback) {
        if (value == null) return fallback;
        String trimmed = value.trim();
        return trimmed.isEmpty() ? fallback : trimmed;
    }

    private static boolean writeTextFile(File file, String body) {
        try {
            FileOutputStream fos = new FileOutputStream(file);
            try { fos.write(String.valueOf(body).getBytes(StandardCharsets.UTF_8)); }
            finally { try { fos.close(); } catch (Exception ignored) {} }
            return true;
        } catch (Exception e) {
            return false;
        }
    }

    private static String resolveCachedLookupUrl(OfflineMapCacheStore store, String url) {
        if (store.hasUrl(url)) return url;
        String stripped = stripQueryAndFragment(url);
        if (!stripped.equals(url) && store.hasUrl(stripped)) return stripped;
        if (isTileJsonUrl(url) || isGlyphUrl(url) || isSpriteUrl(url) || isStyleUrl(url)) {
            try {
                String alias = store.findCachedUrlByCanonicalBase(url);
                if (!alias.isEmpty() && !alias.equals(url) && !alias.equals(stripped) && store.hasUrl(alias)) {
                    return alias;
                }
            } catch (Exception ignored) {}
        }
        return "";
    }

    private static String stripQueryAndFragment(String url) {
        if (url == null) return "";
        int end = url.indexOf('#');
        String out = end >= 0 ? url.substring(0, end) : url;
        int queryStart = out.indexOf('?');
        return queryStart >= 0 ? out.substring(0, queryStart) : out;
    }

    private static boolean isTileJsonUrl(String url) {
        if (url == null) return false;
        return url.toLowerCase().matches(".*\\/tiles\\/[^?#]+\\/tiles\\.json(\\?.*)?$");
    }

    private static boolean isStyleUrl(String url) {
        if (url == null) return false;
        return url.toLowerCase().matches(".*\\/maps\\/[^?#]+\\/style\\.json(\\?.*)?$");
    }

    private static boolean isGlyphUrl(String url) {
        if (url == null) return false;
        return url.toLowerCase().matches(".*\\/fonts\\/[^?#]+\\/\\d+-\\d+\\.pbf(\\?.*)?$");
    }

    private static boolean isSpriteUrl(String url) {
        if (url == null) return false;
        return url.toLowerCase().matches(".*\\/sprite(?:@2x)?\\.(?:json|png)(\\?.*)?$");
    }

    private static String guessCachedResourceMimeType(String url, String storedContentType) {
        if (storedContentType != null && !storedContentType.trim().isEmpty()) {
            return storedContentType.trim();
        }
        if (url == null) return "application/octet-stream";
        String lower = url.toLowerCase();
        int q = lower.indexOf('?');
        if (q >= 0) lower = lower.substring(0, q);
        if (lower.endsWith(".pbf")) return "application/x-protobuf";
        if (lower.endsWith(".png")) return "image/png";
        if (lower.endsWith(".json")) return "application/json";
        return "application/octet-stream";
    }

    private static String sanitizeFileName(String value) {
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

    private static com.getcapacitor.JSArray jsonArrayToJSArray(JSONArray src) throws org.json.JSONException {
        com.getcapacitor.JSArray dst = new com.getcapacitor.JSArray();
        if (src == null) return dst;
        for (int i = 0; i < src.length(); i += 1) dst.put(src.get(i));
        return dst;
    }
}
