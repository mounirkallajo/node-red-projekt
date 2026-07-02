package de.tracking.mobile.offlinemap;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.SharedPreferences;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.os.BatteryManager;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;
import android.util.Log;

import androidx.core.app.NotificationCompat;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;

public class OfflineMapDownloadService extends Service {

    public static final String ACTION_START = "de.tracking.mobile.offlinemap.START";
    public static final String ACTION_CANCEL = "de.tracking.mobile.offlinemap.CANCEL";
    public static final String ACTION_STOP = "de.tracking.mobile.offlinemap.STOP";

    public static final String EXTRA_QUEUE_FILE_PATH = "queueFilePath";

    public static final String PREFS_NAME = "offline_map_download_state";
    public static final String KEY_ACTIVE = "active";
    public static final String KEY_QUEUE_INDEX = "queueIndex";
    public static final String KEY_QUEUE_TOTAL = "queueTotal";
    public static final String KEY_REGION_ID = "regionId";
    public static final String KEY_REGION_NAME = "regionName";
    public static final String KEY_STYLE_LABEL = "styleLabel";
    public static final String KEY_DOWNLOADED = "downloaded";
    public static final String KEY_TOTAL = "total";
    public static final String KEY_FAILED = "failed";
    public static final String KEY_PHASE = "phase";
    public static final String KEY_COMPLETED_REGION_IDS = "completedRegionIds";
    public static final String KEY_QUEUE_FILE_PATH = "queueFilePath";
    public static final String KEY_MESSAGE = "message";

    public static final String BROADCAST_PROGRESS = "de.tracking.mobile.offlinemap.PROGRESS";
    public static final String BROADCAST_EVENT_TYPE = "eventType";
    public static final String BROADCAST_REGION_ID = "regionId";
    public static final String BROADCAST_REGION_NAME = "regionName";
    public static final String BROADCAST_DOWNLOADED = "downloaded";
    public static final String BROADCAST_TOTAL = "total";
    public static final String BROADCAST_FAILED = "failed";
    public static final String BROADCAST_PROCESSED = "processed";
    public static final String BROADCAST_MISSING = "missing";
    public static final String BROADCAST_WORKERS = "workers";
    public static final String BROADCAST_PHASE = "phase";
    public static final String BROADCAST_QUEUE_INDEX = "queueIndex";
    public static final String BROADCAST_QUEUE_TOTAL = "queueTotal";
    public static final String BROADCAST_REGION_RECORD = "regionRecord";
    public static final String BROADCAST_COMPLETED_REGION_IDS = "completedRegionIds";
    public static final String BROADCAST_MESSAGE = "message";

    static final int NOTIFICATION_ID = 28401;
    static final String CHANNEL_ID = "offline_map_download_channel";
    private static final String TAG = "OfflineMapDl";
    private static final int NORMAL_DOWNLOAD_CONCURRENCY = 4;
    private static final int BOOSTED_DOWNLOAD_CONCURRENCY = 6;
    private static final int REDUCED_DOWNLOAD_CONCURRENCY = 2;
    private static final int CHUNK_SIZE = 512;
    private static final int TASK_FLUSH_COMPLETED_THRESHOLD = 75;
    private static final long TASK_FLUSH_INTERVAL_MS = 3000L;
    private static final int MAX_ATTEMPTS = 5;
    private static final int CONNECT_TIMEOUT_MS = 15000;
    private static final int READ_TIMEOUT_MS = 30000;
    private static final int MAX_BYTES_PER_TILE = 8 * 1024 * 1024;
    private static final long DEFAULT_ESTIMATED_URL_BYTES = 32L * 1024L;
    private static final long STORAGE_RESERVE_BYTES = 256L * 1024L * 1024L;
    private static final long[] BACKOFF_MS = new long[] { 5000L, 15000L, 60000L, 300000L };
    private static final long RATE_LIMIT_BACKOFF_MS = 300000L;

    private static volatile AtomicBoolean activeCancelFlag = new AtomicBoolean(false);
    private static volatile boolean activeFlag = false;

    private ExecutorService downloadExecutor = null;
    private Thread coordinatorThread = null;
    private PowerManager.WakeLock wakeLock = null;
    private NotificationManager notificationManager = null;

    private List<RegionTask> currentQueue = new ArrayList<>();
    private int currentQueueIndex = 0;
    private RegionTask currentTask = null;
    private long lastNotificationUpdateMs = 0L;
    private final AtomicInteger adaptiveWorkerCount = new AtomicInteger(NORMAL_DOWNLOAD_CONCURRENCY);
    private final RateLimitCoordinator rateLimitCoordinator = new RateLimitCoordinator();

    public static boolean isActive() { return activeFlag; }

    public static void requestCancel() {
        AtomicBoolean flag = activeCancelFlag;
        if (flag != null) flag.set(true);
    }

    @Override
    public void onCreate() {
        super.onCreate();
        notificationManager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        ensureNotificationChannel();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent == null) {
            SharedPreferences prefs = getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
            String persistedQueuePath = prefs.getString(KEY_QUEUE_FILE_PATH, "");
            if (!persistedQueuePath.isEmpty() && new File(persistedQueuePath).exists()) {
                intent = new Intent(this, OfflineMapDownloadService.class);
                intent.setAction(ACTION_START);
                intent.putExtra(EXTRA_QUEUE_FILE_PATH, persistedQueuePath);
            } else {
                stopSelf();
                return START_NOT_STICKY;
            }
        }
        final String action = intent.getAction();

        if (ACTION_CANCEL.equals(action)) {
            requestCancel();
            return START_NOT_STICKY;
        }
        if (ACTION_STOP.equals(action)) {
            requestCancel();
            stopForeground(true);
            stopSelf();
            return START_NOT_STICKY;
        }
        if (!ACTION_START.equals(action)) {
            return START_NOT_STICKY;
        }
        if (coordinatorThread != null && coordinatorThread.isAlive()) {
            Log.w(TAG, "Download bereits aktiv – START ignoriert");
            return START_NOT_STICKY;
        }

        final String queueFilePath = nonEmpty(intent.getStringExtra(EXTRA_QUEUE_FILE_PATH), "");
        if (queueFilePath.isEmpty()) {
            Log.w(TAG, "Queue-Datei fehlt – kann nicht starten");
            stopSelf();
            return START_NOT_STICKY;
        }

        activeCancelFlag = new AtomicBoolean(false);
        activeFlag = true;
        persistInitialState(queueFilePath);

        startForeground(NOTIFICATION_ID, buildNotification("style", 0, 0));
        acquireWakeLock();
        sendBroadcastEvent("start", "", "", 0, 0, 0, "style", 0, 0, null, null);

        final File queueFile = new File(queueFilePath);
        coordinatorThread = new Thread(new Runnable() {
            @Override
            public void run() { runQueueCoordinator(queueFile); }
        }, "OfflineMapQueueCoordinator");
        coordinatorThread.setDaemon(false);
        coordinatorThread.start();

        return START_STICKY;
    }

    @Override
    public void onTaskRemoved(Intent rootIntent) {
        super.onTaskRemoved(rootIntent);
    }

    @Override
    public void onDestroy() {
        if (downloadExecutor != null) {
            downloadExecutor.shutdownNow();
            downloadExecutor = null;
        }
        releaseWakeLock();
        if (notificationManager != null) {
            try { notificationManager.cancel(NOTIFICATION_ID); } catch (SecurityException ignored) {}
        }
        clearPersistedActiveState();
        activeFlag = false;
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) { return null; }

    private void runQueueCoordinator(File queueFile) {
        OfflineMapCacheStore store = OfflineMapCacheStore.getInstance(getApplicationContext());
        AtomicBoolean cancelFlag = activeCancelFlag;
        final List<String> completedRegionIds = new ArrayList<>();
        int completedCount = 0;
        int failedRegions = 0;
        try {
            String queueJson = readTextFile(queueFile);
            if (queueJson == null || queueJson.isEmpty()) throw new IllegalStateException("Queue-Datei konnte nicht gelesen werden");
            currentQueue = parseQueue(queueJson);
            if (currentQueue.isEmpty()) throw new IllegalStateException("Queue ist leer");

            int resumeQueueIndex = resolveQueueStartIndex(store, currentQueue, completedRegionIds);
            completedCount = completedRegionIds.size();
            for (currentQueueIndex = resumeQueueIndex; currentQueueIndex < currentQueue.size(); currentQueueIndex += 1) {
                if (cancelFlag.get()) break;
                currentTask = currentQueue.get(currentQueueIndex);
                lastNotificationUpdateMs = 0L;
                persistTaskStart();
                sendBroadcastEvent(
                    "region-start",
                    currentTask.regionId,
                    currentTask.regionName,
                    0, 0, 0, "tiles",
                    currentQueueIndex, currentQueue.size(),
                    null, completedRegionIds, ""
                );
                try { notificationManager.notify(NOTIFICATION_ID, buildNotification("style", 0, 0)); } catch (Exception ignored) {}

                RegionOutcome outcome = runSingleRegionV2(store, currentTask, cancelFlag, completedRegionIds);
                if (outcome.ready) {
                    completedCount += 1;
                    completedRegionIds.add(currentTask.regionId);
                } else if (cancelFlag.get()) {
                    break;
                } else {
                    failedRegions += 1;
                }
            }

            boolean wasCancelled = cancelFlag.get();
            if (wasCancelled) {
                sendBroadcastEvent("cancel", currentTask != null ? currentTask.regionId : "", currentTask != null ? currentTask.regionName : "", 0, 0, 0, "cancel", currentQueueIndex, currentQueue.size(), null, completedRegionIds, "Download abgebrochen");
                postFinalQueueNotification("Abgebrochen", completedCount, currentQueue.size());
            } else {
                sendBroadcastEvent("queue-complete", "", "", completedCount, currentQueue.size(), failedRegions, "complete", currentQueue.size(), currentQueue.size(), null, completedRegionIds, "");
                postSuccessQueueNotification(completedCount, currentQueue.size(), failedRegions);
            }
        } catch (Exception e) {
            Log.e(TAG, "Queue-Fehler", e);
            String msg = e.getMessage() != null ? e.getMessage() : e.toString();
            sendBroadcastEvent("error", "", "", 0, 0, 0, "error", currentQueueIndex, Math.max(1, currentQueue.size()), null, completedRegionIds, msg);
            postFinalQueueNotification("Fehler: " + msg, completedCount, Math.max(1, currentQueue.size()));
        } finally {
            try { if (queueFile.exists()) queueFile.delete(); } catch (Exception ignored) {}
            for (RegionTask t : currentQueue) {
                try {
                    File urlsFile = new File(t.urlsFilePath);
                    if (urlsFile.exists()) urlsFile.delete();
                } catch (Exception ignored) {}
            }
            clearPersistedActiveState();
            activeFlag = false;
            try { Thread.sleep(750L); } catch (InterruptedException ignored) {}
            stopForeground(false);
            releaseWakeLock();
            stopSelf();
        }
    }

    private RegionOutcome runSingleRegionV2(OfflineMapCacheStore store, final RegionTask task, AtomicBoolean cancelFlag, List<String> completedRegionIds) {
        RegionOutcome outcome = new RegionOutcome();
        JSONArray urlsArr = null;
        JSONArray taskList = null;
        int total = 0;
        int failedDuringPlanning = 0;
        try {
            File urlsFile = new File(task.urlsFilePath);
            String urlsJson = readTextFile(urlsFile);
            if (urlsJson == null || urlsJson.isEmpty()) {
                urlsArr = store.getRegionPlan(task.regionId);
            } else {
                urlsArr = new JSONArray(urlsJson);
                store.putRegionPlan(task.regionId, urlsArr);
            }
            if (urlsArr == null || urlsArr.length() == 0) throw new IllegalStateException("Keine URL-Planung fuer Region " + task.regionId);
            int urlTotal = urlsArr.length();
            total = Math.max(1, countPlanEntriesByKind(urlsArr, "tile"));

            JSONObject regionRecord = task.regionRecord != null ? new JSONObject(task.regionRecord.toString()) : new JSONObject();
            regionRecord.put("id", task.regionId);
            if (!regionRecord.has("name")) regionRecord.put("name", task.regionName);
            String jobId = !task.jobId.isEmpty() ? task.jobId : regionRecord.optString("jobId", "job_" + task.regionId);
            regionRecord.put("jobId", jobId);
            regionRecord.put("status", "wird heruntergeladen");
            regionRecord.put("ready", false);
            regionRecord.put("tileTotal", total);
            regionRecord.put("urlTotal", urlTotal);
            regionRecord.put("updatedAt", System.currentTimeMillis());
            store.putRegion(regionRecord);

            taskList = store.ensureTaskListForPlan(task.regionId, urlsArr);
            assertStoragePreflight(store, task.regionId, taskList, regionRecord);

            JSONObject initialSummary = store.summarizeTasks(task.regionId, taskList);
            JSONObject jobPatch = new JSONObject();
            jobPatch.put("jobId", jobId);
            jobPatch.put("regionId", task.regionId);
            jobPatch.put("queueIndex", currentQueueIndex);
            jobPatch.put("queueTotal", currentQueue.size());
            jobPatch.put("status", "running");
            jobPatch.put("profile", regionRecord.optString("profile", ""));
            jobPatch.put("totalUrls", urlTotal);
            jobPatch.put("tileTotalUrls", total);
            jobPatch.put("doneUrls", initialSummary.optInt("doneUrls", 0));
            jobPatch.put("failedUrls", initialSummary.optInt("failedUrls", 0));
            jobPatch.put("chunkSize", CHUNK_SIZE);
            jobPatch.put("chunkIndex", firstOpenChunkIndex(taskList));
            jobPatch.put("chunkStatus", "running");
            jobPatch.put("verifyStatus", "not_started");
            store.upsertJob(task.regionId, jobPatch);

            int presentBefore = 0;
            long now = System.currentTimeMillis();
            for (int i = 0; i < taskList.length(); i += 1) {
                JSONObject taskJson = taskList.optJSONObject(i);
                String url = taskJson != null ? taskJson.optString("url", "") : "";
                boolean isTile = isTileTask(taskJson);
                if (url.isEmpty()) {
                    if (isTile) failedDuringPlanning += 1;
                    if (taskJson != null) markTaskFailed(taskJson, "URL fehlt", 0L);
                    continue;
                }
                if (store.hasUrl(url)) {
                    String previousStatus = taskJson.optString("status", "pending");
                    store.attachOwnerToUrl(url, task.regionId);
                    if (!"done".equals(previousStatus)) store.incrementDebugCounter("skippedAlreadyPresent", 1L);
                    markTaskDone(taskJson);
                    if (isTile) presentBefore += 1;
                } else if ("downloading".equals(taskJson.optString("status", "")) || "rate_limited".equals(taskJson.optString("status", ""))) {
                    taskJson.put("status", "pending");
                    taskJson.put("updatedAt", now);
                }
            }
            store.putTaskList(task.regionId, taskList);
            initialSummary = store.summarizeTasks(task.regionId, taskList);

            final AtomicInteger present = new AtomicInteger(initialSummary.optInt("tileDoneUrls", presentBefore));
            final AtomicInteger failed = new AtomicInteger(initialSummary.optInt("tileFailedUrls", failedDuringPlanning));
            persistProgress("tiles", present.get(), total, failed.get());
            sendBroadcastEvent("progress", task.regionId, task.regionName, present.get(), total, failed.get(), "tiles", currentQueueIndex, currentQueue.size(), null, completedRegionIds, "");
            try { notificationManager.notify(NOTIFICATION_ID, buildNotification("tiles", present.get(), total)); } catch (Exception ignored) {}

            for (int chunkStart = 0; chunkStart < taskList.length() && !cancelFlag.get(); chunkStart += CHUNK_SIZE) {
                List<JSONObject> chunk = openTasksForChunk(taskList, chunkStart, Math.min(taskList.length(), chunkStart + CHUNK_SIZE));
                if (chunk.isEmpty()) continue;
                JSONObject chunkPatch = new JSONObject();
                chunkPatch.put("status", "running");
                chunkPatch.put("chunkIndex", chunkStart / CHUNK_SIZE);
                chunkPatch.put("chunkSize", CHUNK_SIZE);
                chunkPatch.put("chunkStatus", "running");
                store.upsertJob(task.regionId, chunkPatch);
                runDownloadChunk(store, task, taskList, chunk, total, present, failed, cancelFlag);
                JSONObject chunkSummary = store.summarizeTasks(task.regionId, taskList);
                JSONObject afterChunkPatch = new JSONObject();
                afterChunkPatch.put("doneUrls", chunkSummary.optInt("doneUrls", present.get()));
                afterChunkPatch.put("failedUrls", chunkSummary.optInt("failedUrls", failed.get()));
                afterChunkPatch.put("tileDoneUrls", chunkSummary.optInt("tileDoneUrls", present.get()));
                afterChunkPatch.put("tileFailedUrls", chunkSummary.optInt("tileFailedUrls", failed.get()));
                afterChunkPatch.put("tileMissingUrls", chunkSummary.optInt("tileMissingUrls", Math.max(0, total - present.get())));
                afterChunkPatch.put("chunkStatus", cancelFlag.get() ? "paused" : "done");
                store.upsertJob(task.regionId, afterChunkPatch);
            }

            JSONObject verifyStartPatch = new JSONObject();
            verifyStartPatch.put("verifyStatus", "running");
            verifyStartPatch.put("chunkStatus", "done");
            store.upsertJob(task.regionId, verifyStartPatch);
            regionRecord.put("verifyStatus", "running");
            store.putRegion(regionRecord);

            JSONObject verify = store.verifyRegionPlan(task.regionId, urlsArr);
            JSONObject finalSummary = store.summarizeTasks(task.regionId, taskList);
            int failedUrls = finalSummary.optInt("failedUrls", failed.get());
            int failedTileUrls = finalSummary.optInt("tileFailedUrls", failed.get());
            String status;
            String jobStatus;
            String eventType;
            String message = "";
            if (cancelFlag.get()) {
                store.resetDownloadingTasks(task.regionId);
                status = "cancelled";
                jobStatus = "cancelled";
                eventType = "region-incomplete";
                message = "Download abgebrochen";
            } else if ("passed".equals(verify.optString("verifyStatus", "")) && verify.optBoolean("complete", false) && failedTileUrls == 0 && verify.optInt("missing", 0) == 0 && verify.optInt("requiredMissing", 0) == 0) {
                status = "bereit";
                jobStatus = "done";
                eventType = "region-complete";
                outcome.ready = true;
            } else if (verify.optInt("requiredMissing", 0) > 0) {
                status = "beschaedigt";
                jobStatus = "failed";
                eventType = "region-incomplete";
                message = "Pflichtressourcen fehlen";
            } else {
                status = "fortsetzbar";
                jobStatus = "fortsetzbar";
                eventType = "region-incomplete";
                message = "Einige Tiles fehlen und koennen fortgesetzt werden";
            }

            regionRecord = task.regionRecord != null ? new JSONObject(task.regionRecord.toString()) : new JSONObject();
            regionRecord.put("id", task.regionId);
            if (!regionRecord.has("name")) regionRecord.put("name", task.regionName);
            regionRecord.put("jobId", jobId);
            regionRecord.put("status", status);
            regionRecord.put("ready", outcome.ready);
            regionRecord.put("tileCount", verify.optInt("present", present.get()));
            regionRecord.put("tileTotal", total);
            regionRecord.put("failed", failedTileUrls);
            regionRecord.put("missing", verify.optInt("missing", failed.get()));
            regionRecord.put("requiredMissing", verify.optInt("requiredMissing", 0));
            regionRecord.put("missingOptionalTiles", verify.optInt("missingOptionalTiles", 0));
            regionRecord.put("resourceMissing", verify.optInt("resourceMissing", 0));
            regionRecord.put("missingTiles", verify.optInt("missingTiles", verify.optInt("missing", failed.get())));
            regionRecord.put("missingGlyphs", verify.optInt("missingGlyphs", 0));
            regionRecord.put("missingSprites", verify.optInt("missingSprites", 0));
            JSONArray missingGlyphRanges = verify.optJSONArray("missingGlyphRanges");
            if (missingGlyphRanges != null) regionRecord.put("missingGlyphRanges", missingGlyphRanges);
            regionRecord.put("unsupportedGlyphRangeCount", verify.optInt("unsupportedGlyphRangeCount", 0));
            JSONArray unsupportedGlyphRanges = verify.optJSONArray("unsupportedGlyphRanges");
            if (unsupportedGlyphRanges != null) regionRecord.put("unsupportedGlyphRanges", unsupportedGlyphRanges);
            regionRecord.put("sizeBytes", verify.optLong("sizeBytes", 0L));
            regionRecord.put("verifyStatus", verify.optString("verifyStatus", outcome.ready ? "passed" : "failed"));
            regionRecord.put("lastVerifyAt", verify.optLong("lastVerifyAt", System.currentTimeMillis()));
            regionRecord.put("updatedAt", System.currentTimeMillis());
            if (outcome.ready) regionRecord.put("completedAt", System.currentTimeMillis());
            if (!message.isEmpty()) regionRecord.put("message", message);
            regionRecord.put("verify", verify);
            store.putRegion(regionRecord);

            JSONObject finalJobPatch = new JSONObject();
            finalJobPatch.put("status", jobStatus);
            finalJobPatch.put("doneUrls", finalSummary.optInt("doneUrls", verify.optInt("present", present.get())));
            finalJobPatch.put("failedUrls", failedUrls);
            finalJobPatch.put("tileDoneUrls", finalSummary.optInt("tileDoneUrls", verify.optInt("present", present.get())));
            finalJobPatch.put("tileFailedUrls", failedTileUrls);
            finalJobPatch.put("tileMissingUrls", verify.optInt("missing", Math.max(0, total - present.get())));
            finalJobPatch.put("totalUrls", finalSummary.optInt("totalUrls", total));
            finalJobPatch.put("tileTotalUrls", total);
            finalJobPatch.put("verifyStatus", verify.optString("verifyStatus", outcome.ready ? "passed" : "failed"));
            finalJobPatch.put("missingRequired", verify.optInt("requiredMissing", 0));
            finalJobPatch.put("missingOptionalTiles", verify.optInt("missingOptionalTiles", 0));
            finalJobPatch.put("resourceMissing", verify.optInt("resourceMissing", 0));
            finalJobPatch.put("missingTiles", verify.optInt("missingTiles", verify.optInt("missing", 0)));
            finalJobPatch.put("missingGlyphs", verify.optInt("missingGlyphs", 0));
            finalJobPatch.put("missingSprites", verify.optInt("missingSprites", 0));
            if (missingGlyphRanges != null) finalJobPatch.put("missingGlyphRanges", missingGlyphRanges);
            finalJobPatch.put("unsupportedGlyphRangeCount", verify.optInt("unsupportedGlyphRangeCount", 0));
            if (unsupportedGlyphRanges != null) finalJobPatch.put("unsupportedGlyphRanges", unsupportedGlyphRanges);
            finalJobPatch.put("lastVerifyAt", verify.optLong("lastVerifyAt", System.currentTimeMillis()));
            finalJobPatch.put("chunkStatus", jobStatus);
            store.upsertJob(task.regionId, finalJobPatch);

            postProgress(task, outcome.ready ? "verify" : status, verify.optInt("present", present.get()), total, verify.optInt("missing", failed.get()));
            sendBroadcastEvent(eventType, task.regionId, task.regionName, verify.optInt("present", present.get()), total, verify.optInt("missing", failed.get()), status, currentQueueIndex, currentQueue.size(), regionRecord, completedRegionIds, message);
            outcome.status = status;
            outcome.record = regionRecord;
        } catch (Exception e) {
            Log.e(TAG, "Region " + task.regionId + " fehlgeschlagen: " + e.getMessage(), e);
            String msg = e.getMessage() != null ? e.getMessage() : e.toString();
            JSONObject verify = store.verifyRegionPlan(task.regionId, urlsArr);
            String status = verify.optInt("requiredMissing", 0) > 0 ? "beschaedigt" : "fortsetzbar";
            JSONObject record = store.markRegionStatus(task.regionId, status, verify, msg);
            try {
                if (taskList != null) store.putTaskList(task.regionId, taskList);
                JSONObject summary = store.summarizeTasks(task.regionId);
                JSONObject jobPatch = new JSONObject();
                jobPatch.put("status", status.equals("beschaedigt") ? "failed" : "fortsetzbar");
                jobPatch.put("doneUrls", summary.optInt("doneUrls", 0));
                jobPatch.put("failedUrls", summary.optInt("failedUrls", verify.optInt("missing", 0)));
                jobPatch.put("tileDoneUrls", summary.optInt("tileDoneUrls", verify.optInt("present", 0)));
                jobPatch.put("tileFailedUrls", summary.optInt("tileFailedUrls", verify.optInt("missing", 0)));
                jobPatch.put("tileMissingUrls", verify.optInt("missing", 0));
                jobPatch.put("verifyStatus", verify.optString("verifyStatus", "failed"));
                jobPatch.put("missingRequired", verify.optInt("requiredMissing", 0));
                jobPatch.put("missingOptionalTiles", verify.optInt("missingOptionalTiles", 0));
                jobPatch.put("resourceMissing", verify.optInt("resourceMissing", 0));
                jobPatch.put("missingTiles", verify.optInt("missingTiles", verify.optInt("missing", 0)));
                jobPatch.put("missingGlyphs", verify.optInt("missingGlyphs", 0));
                jobPatch.put("missingSprites", verify.optInt("missingSprites", 0));
                JSONArray missingGlyphRanges = verify.optJSONArray("missingGlyphRanges");
                if (missingGlyphRanges != null) jobPatch.put("missingGlyphRanges", missingGlyphRanges);
                jobPatch.put("unsupportedGlyphRangeCount", verify.optInt("unsupportedGlyphRangeCount", 0));
                JSONArray unsupportedGlyphRanges = verify.optJSONArray("unsupportedGlyphRanges");
                if (unsupportedGlyphRanges != null) jobPatch.put("unsupportedGlyphRanges", unsupportedGlyphRanges);
                jobPatch.put("lastVerifyAt", verify.optLong("lastVerifyAt", System.currentTimeMillis()));
                jobPatch.put("chunkStatus", "paused");
                store.upsertJob(task.regionId, jobPatch);
            } catch (Exception ignored) {}
            sendBroadcastEvent("region-incomplete", task.regionId, task.regionName, verify.optInt("present", 0), Math.max(total, verify.optInt("total", 0)), verify.optInt("missing", 0), status, currentQueueIndex, currentQueue.size(), record, completedRegionIds, msg);
            outcome.status = status;
            outcome.record = record;
        } finally {
            if (downloadExecutor != null) {
                downloadExecutor.shutdownNow();
                downloadExecutor = null;
            }
        }
        return outcome;
    }

    private int resolveQueueStartIndex(OfflineMapCacheStore store, List<RegionTask> queue, List<String> completedRegionIds) {
        if (queue == null || queue.isEmpty()) return 0;
        int startIndex = 0;
        for (int i = 0; i < queue.size(); i += 1) {
            RegionTask task = queue.get(i);
            if (task == null || task.regionId == null || task.regionId.isEmpty()) break;
            if (!isRegionPersistentlyComplete(store, task.regionId)) break;
            startIndex = i + 1;
            if (completedRegionIds != null && !completedRegionIds.contains(task.regionId)) completedRegionIds.add(task.regionId);
        }
        return Math.min(startIndex, queue.size());
    }

    private boolean isRegionPersistentlyComplete(OfflineMapCacheStore store, String regionId) {
        try {
            JSONObject region = store.getRegion(regionId);
            JSONObject job = store.getJob(regionId);
            boolean regionReady = region != null && (region.optBoolean("ready", false) || "bereit".equals(region.optString("status", "")));
            boolean jobDone = job != null && "done".equals(job.optString("status", ""));
            int missing = region != null ? region.optInt("missing", 0) : 0;
            int requiredMissing = region != null ? region.optInt("requiredMissing", 0) : 0;
            String verifyStatus = region != null ? region.optString("verifyStatus", "") : "";
            return "passed".equals(verifyStatus)
                && missing == 0
                && requiredMissing == 0
                && (regionReady || jobDone);
        } catch (Exception e) {
            return false;
        }
    }

    private void assertStoragePreflight(OfflineMapCacheStore store, String regionId, JSONArray taskList, JSONObject regionRecord) {
        long estimatedMissingBytes = regionRecord != null ? regionRecord.optLong("estimatedMissingBytes", regionRecord.optLong("estimatedBytes", 0L)) : 0L;
        if (estimatedMissingBytes <= 0L) {
            int missing = 0;
            if (taskList != null) {
                for (int i = 0; i < taskList.length(); i += 1) {
                    JSONObject task = taskList.optJSONObject(i);
                    String url = task != null ? task.optString("url", "") : "";
                    if (!url.isEmpty() && !store.hasUrl(url)) missing += 1;
                }
            }
            estimatedMissingBytes = Math.max(0L, missing * DEFAULT_ESTIMATED_URL_BYTES);
        }
        long reserve = Math.max(STORAGE_RESERVE_BYTES, estimatedMissingBytes / 5L);
        long usable = getFilesDir().getUsableSpace();
        if (estimatedMissingBytes > 0L && usable < estimatedMissingBytes + reserve) {
            throw new IllegalStateException(
                "Zu wenig freier Speicher fuer Offline-Download: benoetigt ca. "
                    + ((estimatedMissingBytes + reserve) / (1024L * 1024L))
                    + " MB, frei "
                    + (usable / (1024L * 1024L))
                    + " MB"
            );
        }
    }

    private static int firstOpenChunkIndex(JSONArray taskList) {
        if (taskList == null || taskList.length() == 0) return 0;
        for (int i = 0; i < taskList.length(); i += 1) {
            JSONObject task = taskList.optJSONObject(i);
            if (task == null) continue;
            String status = task.optString("status", "pending");
            if (!"done".equals(status) && !"doneUnsupported".equals(status) && !"skippedUnsupported".equals(status)) return i / CHUNK_SIZE;
        }
        return Math.max(0, (taskList.length() - 1) / CHUNK_SIZE);
    }

    private static List<JSONObject> openTasksForChunk(JSONArray taskList, int start, int end) {
        List<JSONObject> result = new ArrayList<>();
        if (taskList == null) return result;
        long now = System.currentTimeMillis();
        for (int i = Math.max(0, start); i < Math.min(taskList.length(), end); i += 1) {
            JSONObject task = taskList.optJSONObject(i);
            if (task == null) continue;
            String status = task.optString("status", "pending");
            if ("done".equals(status)) continue;
            if ("doneUnsupported".equals(status) || "skippedUnsupported".equals(status)) continue;
            if ("failed".equals(status) && task.optLong("nextRetryAt", 0L) > now) continue;
            if ("rate_limited".equals(status) && task.optLong("nextRetryAt", 0L) > now) continue;
            result.add(task);
        }
        return result;
    }

    private static void markTaskDone(JSONObject taskJson) {
        markTaskDone(taskJson, false);
    }

    private static void markTaskDone(JSONObject taskJson, boolean emptyTile) {
        if (taskJson == null) return;
        try {
            taskJson.put("status", "done");
            taskJson.put("lastError", "");
            taskJson.put("errorType", "");
            taskJson.put("nextRetryAt", 0L);
            taskJson.put("retryCount", 0);
            if (emptyTile) taskJson.put("emptyTile", true);
            else if (taskJson.optBoolean("emptyTile", false)) taskJson.remove("emptyTile");
            taskJson.put("updatedAt", System.currentTimeMillis());
            taskJson.remove("previousStatus");
        } catch (Exception ignored) {}
    }

    private static void markTaskUnsupportedGlyphRange(JSONObject taskJson, String error) {
        if (taskJson == null) return;
        try {
            taskJson.put("status", "doneUnsupported");
            taskJson.put("unsupportedGlyphRange", true);
            taskJson.put("lastError", error == null || error.isEmpty() ? "unsupportedGlyphRange" : error);
            taskJson.put("errorType", "unsupportedGlyphRange");
            taskJson.put("nextRetryAt", 0L);
            taskJson.put("retryCount", 0);
            taskJson.put("updatedAt", System.currentTimeMillis());
            taskJson.remove("previousStatus");
        } catch (Exception ignored) {}
    }

    private static void markTaskFailed(JSONObject taskJson, String error, long retryDelayMs) {
        if (taskJson == null) return;
        long now = System.currentTimeMillis();
        try {
            taskJson.put("status", "failed");
            taskJson.put("lastError", error == null ? "" : error);
            taskJson.put("errorType", categorizeError(error));
            taskJson.put("nextRetryAt", retryDelayMs > 0L ? now + retryDelayMs : 0L);
            taskJson.put("updatedAt", now);
            taskJson.remove("previousStatus");
        } catch (Exception ignored) {}
    }

    private static void markTaskRateLimited(JSONObject taskJson, String error, long retryDelayMs) {
        if (taskJson == null) return;
        long now = System.currentTimeMillis();
        try {
            taskJson.put("status", "rate_limited");
            taskJson.put("lastError", error == null ? "HTTP 429" : error);
            taskJson.put("errorType", "http429");
            taskJson.put("nextRetryAt", retryDelayMs > 0L ? now + retryDelayMs : 0L);
            taskJson.put("updatedAt", now);
        } catch (Exception ignored) {}
    }

    private static boolean isTileTask(JSONObject taskJson) {
        if (taskJson == null) return true;
        String kind = taskJson.optString("kind", "tile");
        return kind == null || kind.isEmpty() || "tile".equals(kind);
    }

    private static int countPlanEntriesByKind(JSONArray urls, String targetKind) {
        if (urls == null) return 0;
        int count = 0;
        for (int i = 0; i < urls.length(); i += 1) {
            JSONObject entry = urls.optJSONObject(i);
            String kind = entry != null ? entry.optString("kind", "tile") : "tile";
            if (targetKind.equals(kind == null || kind.isEmpty() ? "tile" : kind)) count += 1;
        }
        return count;
    }

    private static class TaskListFlushController {
        private final OfflineMapCacheStore store;
        private final String regionId;
        private final JSONArray taskList;
        private int completedSinceFlush = 0;
        private boolean dirty = false;
        private long lastFlushMs = System.currentTimeMillis();

        TaskListFlushController(OfflineMapCacheStore store, String regionId, JSONArray taskList) {
            this.store = store;
            this.regionId = regionId;
            this.taskList = taskList;
        }

        void markDirtyLocked(boolean completedTask) {
            dirty = true;
            if (completedTask) completedSinceFlush += 1;
            long now = System.currentTimeMillis();
            if (completedSinceFlush >= TASK_FLUSH_COMPLETED_THRESHOLD || now - lastFlushMs >= TASK_FLUSH_INTERVAL_MS) {
                flushLocked(now);
            }
        }

        void flushNow() {
            synchronized (taskList) {
                flushLocked(System.currentTimeMillis());
            }
        }

        private void flushLocked(long now) {
            if (!dirty) return;
            store.putTaskList(regionId, taskList);
            dirty = false;
            completedSinceFlush = 0;
            lastFlushMs = now;
        }
    }

    private static class DownloadTaskResult {
        static final DownloadTaskResult SUCCESS = new DownloadTaskResult(true, false, false);
        static final DownloadTaskResult DEFERRED = new DownloadTaskResult(false, false, true);
        static final DownloadTaskResult FAILED = new DownloadTaskResult(false, true, false);

        final boolean success;
        final boolean countAsFailure;
        final boolean deferred;

        DownloadTaskResult(boolean success, boolean countAsFailure, boolean deferred) {
            this.success = success;
            this.countAsFailure = countAsFailure;
            this.deferred = deferred;
        }
    }

    private static class RateLimitCoordinator {
        private long pauseUntilMs = 0L;

        synchronized void apply(long delayMs) {
            long until = System.currentTimeMillis() + Math.max(1000L, delayMs);
            if (until > pauseUntilMs) pauseUntilMs = until;
        }

        synchronized long pauseUntil() {
            return pauseUntilMs;
        }

        void waitIfPaused(AtomicBoolean cancelFlag) throws InterruptedException {
            while (true) {
                long sleepMs;
                synchronized (this) {
                    sleepMs = pauseUntilMs - System.currentTimeMillis();
                    if (sleepMs <= 0L) return;
                }
                if (cancelFlag != null && cancelFlag.get()) throw new InterruptedException("Abgebrochen");
                Thread.sleep(Math.min(1000L, sleepMs));
            }
        }
    }

    private void runDownloadChunk(
        final OfflineMapCacheStore store,
        final RegionTask task,
        final JSONArray taskList,
        List<JSONObject> chunk,
        final int total,
        final AtomicInteger present,
        final AtomicInteger failed,
        final AtomicBoolean cancelFlag
    ) throws InterruptedException {
        if (chunk == null || chunk.isEmpty()) return;
        synchronized (taskList) {
            long now = System.currentTimeMillis();
            for (int i = 0; i < chunk.size(); i += 1) {
                JSONObject taskJson = chunk.get(i);
                try {
                    taskJson.put("previousStatus", taskJson.optString("status", "pending"));
                    taskJson.put("status", "downloading");
                    taskJson.put("updatedAt", now);
                } catch (Exception ignored) {}
            }
            store.putTaskList(task.regionId, taskList);
        }
        final TaskListFlushController flusher = new TaskListFlushController(store, task.regionId, taskList);
        final AtomicInteger chunkFinished = new AtomicInteger(0);
        final AtomicInteger chunkTileFailures = new AtomicInteger(0);
        final AtomicInteger chunkTileSuccesses = new AtomicInteger(0);
        final int workerCount = resolveAdaptiveWorkerCount(store);
        store.setDebugLong("currentWorkerCount", workerCount);
        downloadExecutor = Executors.newFixedThreadPool(workerCount, new java.util.concurrent.ThreadFactory() {
            @Override public Thread newThread(Runnable r) {
                Thread t = new Thread(r, "OfflineMapDownloadWorker");
                t.setDaemon(false);
                return t;
            }
        });
        for (int i = 0; i < chunk.size(); i += 1) {
            final JSONObject urlTask = chunk.get(i);
            downloadExecutor.submit(new Runnable() {
                @Override public void run() {
                    if (cancelFlag.get()) return;
                    String previousStatus = urlTask.optString("previousStatus", urlTask.optString("status", "pending"));
                    boolean wasFailed = "failed".equals(previousStatus);
                    boolean isTile = isTileTask(urlTask);
                    DownloadTaskResult result = downloadAndStoreTask(store, urlTask, taskList, task.regionId, cancelFlag, flusher);
                    if (isTile && result.success) {
                        present.incrementAndGet();
                        chunkTileSuccesses.incrementAndGet();
                        if (wasFailed) failed.decrementAndGet();
                    } else if (isTile && result.countAsFailure) {
                        chunkTileFailures.incrementAndGet();
                        if (!wasFailed) failed.incrementAndGet();
                    }
                    int done = present.get() + failed.get();
                    int finishedInChunk = chunkFinished.incrementAndGet();
                    if (done % 5 == 0 || finishedInChunk >= chunk.size() || done >= total || cancelFlag.get()) {
                        postProgress(task, "tiles", present.get(), total, failed.get());
                    }
                }
            });
        }
        downloadExecutor.shutdown();
        while (!downloadExecutor.awaitTermination(500, TimeUnit.MILLISECONDS)) {
            if (cancelFlag.get()) {
                downloadExecutor.shutdownNow();
                break;
            }
        }
        if (cancelFlag.get()) {
            downloadExecutor.shutdownNow();
            downloadExecutor.awaitTermination(2, TimeUnit.SECONDS);
        }
        downloadExecutor = null;
        flusher.flushNow();
        adjustAdaptiveWorkerCountAfterChunk(store, chunkTileSuccesses.get(), chunkTileFailures.get());
    }

    private boolean runSingleRegion(OfflineMapCacheStore store, final RegionTask task, AtomicBoolean cancelFlag, List<String> completedRegionIds) {
        final List<String> newlyStoredUrls = new ArrayList<>();
        boolean ok = false;
        try {
            File urlsFile = new File(task.urlsFilePath);
            String urlsJson = readTextFile(urlsFile);
            if (urlsJson == null || urlsJson.isEmpty()) throw new IllegalStateException("URL-Datei für Region " + task.regionId + " nicht lesbar");
            JSONArray urlsArr = new JSONArray(urlsJson);
            final int total = urlsArr.length();
            if (total == 0) throw new IllegalStateException("Keine URLs für Region " + task.regionId);

            persistProgress("tiles", 0, total, 0);
            sendBroadcastEvent("progress", task.regionId, task.regionName, 0, total, 0, "tiles", currentQueueIndex, currentQueue.size(), null, completedRegionIds);
            try { notificationManager.notify(NOTIFICATION_ID, buildNotification("tiles", 0, total)); } catch (Exception ignored) {}

            downloadExecutor = Executors.newFixedThreadPool(NORMAL_DOWNLOAD_CONCURRENCY, new java.util.concurrent.ThreadFactory() {
                @Override public Thread newThread(Runnable r) {
                    Thread t = new Thread(r, "OfflineMapDownloadWorker");
                    t.setDaemon(false);
                    return t;
                }
            });

            final AtomicInteger downloaded = new AtomicInteger(0);
            final AtomicInteger failed = new AtomicInteger(0);
            final AtomicLong bytesTotal = new AtomicLong(0L);
            final Object newlyStoredLock = new Object();

            for (int i = 0; i < total; i += 1) {
                JSONObject taskJson = urlsArr.optJSONObject(i);
                final String url = taskJson != null ? taskJson.optString("url", "") : "";
                final boolean isRequired = taskJson != null && taskJson.optBoolean("required", false);
                if (url.isEmpty()) {
                    downloaded.incrementAndGet();
                    failed.incrementAndGet();
                    continue;
                }
                downloadExecutor.submit(new Runnable() {
                    @Override public void run() {
                        if (cancelFlag.get()) return;
                        boolean alreadyExisted = store.hasUrl(url);
                        boolean okDownload = downloadAndStore(store, url, task.regionId, cancelFlag);
                        if (!okDownload) {
                            failed.incrementAndGet();
                            if (isRequired) cancelFlag.set(true);
                        } else if (!alreadyExisted) {
                            synchronized (newlyStoredLock) { newlyStoredUrls.add(url); }
                            bytesTotal.addAndGet(store.getEntrySize(url));
                        }
                        int finishedNow = downloaded.incrementAndGet();
                        if (finishedNow % 5 == 0 || finishedNow == total) {
                            postProgress(task, "tiles", finishedNow, total, failed.get());
                        }
                    }
                });
            }

            downloadExecutor.shutdown();
            while (!downloadExecutor.awaitTermination(500, TimeUnit.MILLISECONDS)) {
                if (cancelFlag.get()) {
                    downloadExecutor.shutdownNow();
                    break;
                }
            }
            if (cancelFlag.get()) {
                downloadExecutor.shutdownNow();
                downloadExecutor.awaitTermination(2, TimeUnit.SECONDS);
                throw new InterruptedException("Abgebrochen");
            }

            JSONObject regionRecord = task.regionRecord != null ? new JSONObject(task.regionRecord.toString()) : new JSONObject();
            regionRecord.put("id", task.regionId);
            if (!regionRecord.has("name")) regionRecord.put("name", task.regionName);
            regionRecord.put("tileCount", Math.max(0, downloaded.get() - failed.get()));
            regionRecord.put("tileTotal", total);
            regionRecord.put("failed", failed.get());
            regionRecord.put("sizeBytes", bytesTotal.get());
            regionRecord.put("createdAt", System.currentTimeMillis());
            store.putRegion(regionRecord);

            sendBroadcastEvent("region-complete", task.regionId, task.regionName, downloaded.get(), total, failed.get(), "complete", currentQueueIndex, currentQueue.size(), regionRecord, completedRegionIds);
            ok = true;
        } catch (InterruptedException ie) {
            Log.i(TAG, "Region " + task.regionId + " abgebrochen, rolle " + newlyStoredUrls.size() + " URLs zurück");
            rollbackUrls(store, newlyStoredUrls, task.regionId);
        } catch (Exception e) {
            Log.e(TAG, "Region " + task.regionId + " fehlgeschlagen: " + e.getMessage(), e);
            rollbackUrls(store, newlyStoredUrls, task.regionId);
        } finally {
            if (downloadExecutor != null) {
                downloadExecutor.shutdownNow();
                downloadExecutor = null;
            }
        }
        return ok;
    }

    private void rollbackUrls(OfflineMapCacheStore store, List<String> urls, String regionId) {
        if (urls == null || urls.isEmpty()) return;
        synchronized (urls) {
            for (int i = 0; i < urls.size(); i += 1) {
                store.detachRegionFromUrl(urls.get(i), regionId);
            }
        }
    }

    private DownloadTaskResult downloadAndStoreTask(OfflineMapCacheStore store, JSONObject taskJson, JSONArray taskList, String regionId, AtomicBoolean cancelFlag, TaskListFlushController flusher) {
        String url = taskJson != null ? taskJson.optString("url", "") : "";
        String kind = taskJson != null ? taskJson.optString("kind", "tile") : "tile";
        boolean isGlyph = "glyph".equals(kind);
        if (url.isEmpty()) {
            synchronized (taskList) {
                markTaskFailed(taskJson, "URL fehlt", 0L);
                flusher.markDirtyLocked(true);
            }
            store.recordDownloadError("unknown", "URL fehlt");
            return DownloadTaskResult.FAILED;
        }
        if (store.hasUrl(url)) {
            try { store.attachOwnerToUrl(url, regionId); } catch (Exception ignored) {}
            store.incrementDebugCounter("skippedAlreadyPresent", 1L);
            store.incrementDebugCounter("cacheHits", 1L);
            if (isGlyph) store.incrementDebugCounter("glyphCacheHits", 1L);
            synchronized (taskList) {
                markTaskDone(taskJson);
                flusher.markDirtyLocked(true);
            }
            return DownloadTaskResult.SUCCESS;
        }

        store.incrementDebugCounter("cacheMisses", 1L);
        if (isGlyph) store.incrementDebugCounter("glyphCacheMisses", 1L);
        int attempt = Math.max(0, taskJson.optInt("retryCount", 0));
        while (attempt < MAX_ATTEMPTS) {
            if (cancelFlag.get()) return DownloadTaskResult.DEFERRED;
            long nextRetryAt = taskJson.optLong("nextRetryAt", 0L);
            long now = System.currentTimeMillis();
            if (nextRetryAt > now) {
                synchronized (taskList) {
                    try {
                        taskJson.put("status", "rate_limited".equals(taskJson.optString("status", "")) ? "rate_limited" : "failed");
                        taskJson.put("updatedAt", now);
                    } catch (Exception ignored) {}
                    flusher.markDirtyLocked(false);
                }
                return "rate_limited".equals(taskJson.optString("status", "")) ? DownloadTaskResult.DEFERRED : DownloadTaskResult.FAILED;
            }
            try {
                rateLimitCoordinator.waitIfPaused(cancelFlag);
                store.setDebugLong("rateLimitedUntil", rateLimitCoordinator.pauseUntil());
                URL endpoint = new URL(url);
                long httpStarted = System.nanoTime();
                HttpURLConnection connection = (HttpURLConnection) endpoint.openConnection();
                connection.setConnectTimeout(CONNECT_TIMEOUT_MS);
                connection.setReadTimeout(READ_TIMEOUT_MS);
                connection.setRequestMethod("GET");
                connection.setRequestProperty("User-Agent", "OfflineMapDownloader/1.0");
                connection.setRequestProperty("Accept", "*/*");
                connection.setInstanceFollowRedirects(true);
                int status = connection.getResponseCode();
                if (status == 400 && isGlyph && OfflineMapCacheStore.isUnsupportedGlyphRange(url)) {
                    store.recordTiming("httpDownload", elapsedMs(httpStarted));
                    connection.disconnect();
                    synchronized (taskList) {
                        markTaskUnsupportedGlyphRange(taskJson, "HTTP 400 unsupportedGlyphRange");
                        flusher.markDirtyLocked(true);
                    }
                    return DownloadTaskResult.SUCCESS;
                }
                if (status < 200 || status >= 300) {
                    store.recordTiming("httpDownload", elapsedMs(httpStarted));
                    store.incrementDebugCounter("httpErrors", 1L);
                    long retryAfterMs = parseRetryAfterMs(connection.getHeaderField("Retry-After"));
                    connection.disconnect();
                    attempt += 1;
                    boolean retryable = !(status >= 400 && status < 500 && status != 408 && status != 429);
                    long delayMs = status == 429 ? Math.max(RATE_LIMIT_BACKOFF_MS, retryAfterMs) : retryDelayMs(attempt - 1);
                    String error = "HTTP " + status;
                    store.recordDownloadError(categorizeError(error), error);
                    boolean finalHttpFailure = !retryable || attempt >= MAX_ATTEMPTS;
                    synchronized (taskList) {
                        if (status == 429 && attempt < MAX_ATTEMPTS) markTaskRateLimited(taskJson, error, delayMs);
                        else markTaskFailed(taskJson, error, retryable && attempt < MAX_ATTEMPTS ? delayMs : 0L);
                        try { taskJson.put("retryCount", attempt); } catch (Exception ignored) {}
                        flusher.markDirtyLocked(finalHttpFailure);
                    }
                    if (status == 429 && attempt < MAX_ATTEMPTS) {
                        applyRateLimit(store, delayMs);
                        rateLimitCoordinator.waitIfPaused(cancelFlag);
                        continue;
                    }
                    if (!retryable || attempt >= MAX_ATTEMPTS) return DownloadTaskResult.FAILED;
                    sleepWithCancel(delayMs, cancelFlag);
                    continue;
                }
                String contentType = connection.getHeaderField("Content-Type");
                int contentLength = connection.getContentLength();
                if (contentLength > 0 && getFilesDir().getUsableSpace() < Math.max(16L * 1024L * 1024L, contentLength * 2L)) {
                    store.recordTiming("httpDownload", elapsedMs(httpStarted));
                    connection.disconnect();
                    store.incrementDebugCounter("httpErrors", 1L);
                    store.recordDownloadError("storage", "storage error");
                    synchronized (taskList) {
                        markTaskFailed(taskJson, "Zu wenig Speicher fuer Offline-Tile", retryDelayMs(attempt));
                        try { taskJson.put("retryCount", attempt + 1); } catch (Exception ignored) {}
                        flusher.markDirtyLocked(true);
                    }
                    Log.w(TAG, "Zu wenig Speicher fuer Offline-Tile");
                    return DownloadTaskResult.FAILED;
                }
                InputStream input = connection.getInputStream();
                try {
                    ByteArrayOutputStream out = new ByteArrayOutputStream(Math.max(2048, connection.getContentLength()));
                    byte[] buffer = new byte[8192];
                    int read;
                    int totalRead = 0;
                    while ((read = input.read(buffer)) > 0) {
                        totalRead += read;
                        if (totalRead > MAX_BYTES_PER_TILE) {
                            store.recordTiming("httpDownload", elapsedMs(httpStarted));
                            store.incrementDebugCounter("httpErrors", 1L);
                            store.recordDownloadError("tileTooLarge", "Tile groesser als Limit");
                            synchronized (taskList) {
                                markTaskFailed(taskJson, "Tile groesser als Limit", 0L);
                                try { taskJson.put("retryCount", attempt + 1); } catch (Exception ignored) {}
                                flusher.markDirtyLocked(true);
                            }
                            return DownloadTaskResult.FAILED;
                        }
                        out.write(buffer, 0, read);
                    }
                    store.recordTiming("httpDownload", elapsedMs(httpStarted));
                    byte[] bytes = out.toByteArray();
                    if (bytes.length == 0) {
                        if (isTileTask(taskJson)) {
                            store.writeEmptyTileEntry(url, contentType, regionId);
                            store.incrementDebugCounter("httpDownloads", 1L);
                            synchronized (taskList) {
                                markTaskDone(taskJson, true);
                                flusher.markDirtyLocked(true);
                            }
                            return DownloadTaskResult.SUCCESS;
                        }
                        store.incrementDebugCounter("httpErrors", 1L);
                        store.recordDownloadError("emptyResponse", "Leere HTTP-Antwort");
                        synchronized (taskList) {
                            markTaskFailed(taskJson, "Leere HTTP-Antwort", retryDelayMs(attempt));
                            try { taskJson.put("retryCount", attempt + 1); } catch (Exception ignored) {}
                            flusher.markDirtyLocked(true);
                        }
                        return DownloadTaskResult.FAILED;
                    }
                    store.writeEntry(url, bytes, contentType, regionId);
                    store.incrementDebugCounter("httpDownloads", 1L);
                    synchronized (taskList) {
                        markTaskDone(taskJson);
                        flusher.markDirtyLocked(true);
                    }
                    return DownloadTaskResult.SUCCESS;
                } finally {
                    try { input.close(); } catch (Exception ignored) {}
                    connection.disconnect();
                }
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
                return DownloadTaskResult.DEFERRED;
            } catch (Exception e) {
                store.incrementDebugCounter("httpErrors", 1L);
                attempt += 1;
                long delayMs = retryDelayMs(attempt - 1);
                String error = e.getMessage() != null ? e.getMessage() : e.toString();
                String category = e instanceof java.io.IOException ? "storage" : categorizeError(error);
                store.recordDownloadError(category, error);
                synchronized (taskList) {
                    markTaskFailed(taskJson, error, attempt < MAX_ATTEMPTS ? delayMs : 0L);
                    try { taskJson.put("retryCount", attempt); } catch (Exception ignored) {}
                    flusher.markDirtyLocked(attempt >= MAX_ATTEMPTS);
                }
                if (attempt >= MAX_ATTEMPTS) return DownloadTaskResult.FAILED;
                try { sleepWithCancel(delayMs, cancelFlag); } catch (InterruptedException ie) { Thread.currentThread().interrupt(); return DownloadTaskResult.DEFERRED; }
            }
        }
        return DownloadTaskResult.FAILED;
    }

    private boolean downloadAndStore(OfflineMapCacheStore store, String url, String regionId, AtomicBoolean cancelFlag) {
        if (store.hasUrl(url)) {
            try { store.attachOwnerToUrl(url, regionId); } catch (Exception ignored) {}
            store.incrementDebugCounter("skippedAlreadyPresent", 1L);
            store.incrementDebugCounter("cacheHits", 1L);
            return true;
        }
        store.incrementDebugCounter("cacheMisses", 1L);
        for (int attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
            if (cancelFlag.get()) return false;
            try {
                URL endpoint = new URL(url);
                HttpURLConnection connection = (HttpURLConnection) endpoint.openConnection();
                connection.setConnectTimeout(CONNECT_TIMEOUT_MS);
                connection.setReadTimeout(READ_TIMEOUT_MS);
                connection.setRequestMethod("GET");
                connection.setRequestProperty("User-Agent", "OfflineMapDownloader/1.0");
                connection.setRequestProperty("Accept", "*/*");
                connection.setInstanceFollowRedirects(true);
                int status = connection.getResponseCode();
                if (status < 200 || status >= 300) {
                    store.incrementDebugCounter("httpErrors", 1L);
                    long retryAfterMs = parseRetryAfterMs(connection.getHeaderField("Retry-After"));
                    connection.disconnect();
                    if (status >= 400 && status < 500 && status != 408 && status != 429) return false;
                    sleepWithCancel(status == 429 ? Math.max(RATE_LIMIT_BACKOFF_MS, retryAfterMs) : retryDelayMs(attempt), cancelFlag);
                    continue;
                }
                String contentType = connection.getHeaderField("Content-Type");
                int contentLength = connection.getContentLength();
                if (contentLength > 0 && getFilesDir().getUsableSpace() < Math.max(16L * 1024L * 1024L, contentLength * 2L)) {
                    connection.disconnect();
                    Log.w(TAG, "Zu wenig Speicher fuer Offline-Tile");
                    return false;
                }
                InputStream input = connection.getInputStream();
                try {
                    ByteArrayOutputStream out = new ByteArrayOutputStream(Math.max(2048, connection.getContentLength()));
                    byte[] buffer = new byte[8192];
                    int read;
                    int totalRead = 0;
                    while ((read = input.read(buffer)) > 0) {
                        totalRead += read;
                        if (totalRead > MAX_BYTES_PER_TILE) return false;
                        out.write(buffer, 0, read);
                    }
                    byte[] bytes = out.toByteArray();
                    if (bytes.length == 0) return false;
                    store.writeEntry(url, bytes, contentType, regionId);
                    store.incrementDebugCounter("httpDownloads", 1L);
                    return true;
                } finally {
                    try { input.close(); } catch (Exception ignored) {}
                    connection.disconnect();
                }
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
                return false;
            } catch (Exception e) {
                store.incrementDebugCounter("httpErrors", 1L);
                try { sleepWithCancel(retryDelayMs(attempt), cancelFlag); } catch (InterruptedException ie) { Thread.currentThread().interrupt(); return false; }
            }
        }
        return false;
    }

    private static long retryDelayMs(int attempt) {
        int index = Math.max(0, Math.min(attempt, BACKOFF_MS.length - 1));
        return BACKOFF_MS[index];
    }

    private static long parseRetryAfterMs(String retryAfter) {
        if (retryAfter == null || retryAfter.trim().isEmpty()) return 0L;
        try {
            long seconds = Long.parseLong(retryAfter.trim());
            return Math.max(0L, seconds * 1000L);
        } catch (Exception ignored) {
            return 0L;
        }
    }

    private static void sleepWithCancel(long delayMs, AtomicBoolean cancelFlag) throws InterruptedException {
        long deadline = System.currentTimeMillis() + Math.max(0L, delayMs);
        while (System.currentTimeMillis() < deadline) {
            if (cancelFlag != null && cancelFlag.get()) throw new InterruptedException("Abgebrochen");
            Thread.sleep(Math.min(1000L, Math.max(1L, deadline - System.currentTimeMillis())));
        }
    }

    private static long elapsedMs(long startedNanos) {
        return Math.max(0L, (System.nanoTime() - startedNanos) / 1000000L);
    }

    private static String categorizeError(String error) {
        String text = error == null ? "" : error.toLowerCase();
        if (text.contains("429")) return "http429";
        if (text.contains("403")) return "http403";
        if (text.contains("404")) return "http404";
        if (text.contains("timeout") || text.contains("timed out") || text.contains("sockettimeoutexception")) return "timeout";
        if (text.contains("connection reset") || text.contains("reset by peer")) return "connectionReset";
        if (text.contains("speicher") || text.contains("storage") || text.contains("no space") || text.contains("enospc")) return "storage";
        if (text.contains("too large") || text.contains("groesser") || text.contains("limit")) return "tileTooLarge";
        if (text.contains("empty") || text.contains("leere")) return "emptyResponse";
        return "unknown";
    }

    private void applyRateLimit(OfflineMapCacheStore store, long delayMs) {
        rateLimitCoordinator.apply(delayMs);
        adaptiveWorkerCount.set(REDUCED_DOWNLOAD_CONCURRENCY);
        store.setDebugLong("currentWorkerCount", REDUCED_DOWNLOAD_CONCURRENCY);
        store.setDebugLong("rateLimitedUntil", rateLimitCoordinator.pauseUntil());
    }

    private int resolveAdaptiveWorkerCount(OfflineMapCacheStore store) {
        long now = System.currentTimeMillis();
        if (rateLimitCoordinator.pauseUntil() > now) {
            adaptiveWorkerCount.set(REDUCED_DOWNLOAD_CONCURRENCY);
            return REDUCED_DOWNLOAD_CONCURRENCY;
        }
        if (isDeviceThermallyHot()) {
            adaptiveWorkerCount.set(REDUCED_DOWNLOAD_CONCURRENCY);
            return REDUCED_DOWNLOAD_CONCURRENCY;
        }
        int current = adaptiveWorkerCount.get();
        if (current <= REDUCED_DOWNLOAD_CONCURRENCY) return REDUCED_DOWNLOAD_CONCURRENCY;
        if (isWifiConnected() && isCharging()) {
            current = Math.max(current, BOOSTED_DOWNLOAD_CONCURRENCY);
        } else {
            current = Math.min(current, NORMAL_DOWNLOAD_CONCURRENCY);
        }
        current = Math.max(REDUCED_DOWNLOAD_CONCURRENCY, Math.min(BOOSTED_DOWNLOAD_CONCURRENCY, current));
        adaptiveWorkerCount.set(current);
        store.setDebugLong("currentWorkerCount", current);
        store.setDebugLong("rateLimitedUntil", 0L);
        return current;
    }

    private void adjustAdaptiveWorkerCountAfterChunk(OfflineMapCacheStore store, int successes, int failures) {
        int next = adaptiveWorkerCount.get();
        if (failures > 0 && failures * 4 >= Math.max(1, successes)) {
            next = REDUCED_DOWNLOAD_CONCURRENCY;
        } else if (next <= REDUCED_DOWNLOAD_CONCURRENCY && failures == 0 && successes >= 50) {
            next = NORMAL_DOWNLOAD_CONCURRENCY;
        } else if (failures == 0 && successes >= 150 && isWifiConnected() && isCharging() && !isDeviceThermallyHot()) {
            next = BOOSTED_DOWNLOAD_CONCURRENCY;
        }
        adaptiveWorkerCount.set(Math.max(REDUCED_DOWNLOAD_CONCURRENCY, Math.min(BOOSTED_DOWNLOAD_CONCURRENCY, next)));
        store.setDebugLong("currentWorkerCount", adaptiveWorkerCount.get());
    }

    private boolean isWifiConnected() {
        try {
            ConnectivityManager manager = (ConnectivityManager) getSystemService(Context.CONNECTIVITY_SERVICE);
            if (manager == null) return false;
            Network network = manager.getActiveNetwork();
            if (network == null) return false;
            NetworkCapabilities capabilities = manager.getNetworkCapabilities(network);
            return capabilities != null && capabilities.hasTransport(NetworkCapabilities.TRANSPORT_WIFI);
        } catch (Exception e) {
            return false;
        }
    }

    private boolean isCharging() {
        try {
            Intent status = registerReceiver(null, new IntentFilter(Intent.ACTION_BATTERY_CHANGED));
            if (status == null) return false;
            int plugged = status.getIntExtra(BatteryManager.EXTRA_PLUGGED, 0);
            return plugged == BatteryManager.BATTERY_PLUGGED_AC
                || plugged == BatteryManager.BATTERY_PLUGGED_USB
                || plugged == BatteryManager.BATTERY_PLUGGED_WIRELESS;
        } catch (Exception e) {
            return false;
        }
    }

    private boolean isDeviceThermallyHot() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return false;
        try {
            PowerManager powerManager = (PowerManager) getSystemService(Context.POWER_SERVICE);
            if (powerManager == null) return false;
            int status = powerManager.getCurrentThermalStatus();
            return status >= PowerManager.THERMAL_STATUS_MODERATE;
        } catch (Exception e) {
            return false;
        }
    }

    private void postProgress(RegionTask task, String phase, int downloaded, int total, int failed) {
        persistProgress(phase, downloaded, total, failed);
        long now = System.currentTimeMillis();
        if (now - lastNotificationUpdateMs < 750L && downloaded < total) return;
        lastNotificationUpdateMs = now;
        if (notificationManager != null) {
            try { notificationManager.notify(NOTIFICATION_ID, buildNotification(phase, downloaded, total, failed)); } catch (SecurityException ignored) {}
        }
        sendBroadcastEvent("progress", task.regionId, task.regionName, downloaded, total, failed, phase, currentQueueIndex, currentQueue.size(), null, null);
    }

    private void persistInitialState(String queueFilePath) {
        SharedPreferences prefs = getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
        prefs.edit()
            .putBoolean(KEY_ACTIVE, true)
            .putInt(KEY_QUEUE_INDEX, 0)
            .putInt(KEY_QUEUE_TOTAL, 0)
            .putString(KEY_REGION_ID, "")
            .putString(KEY_REGION_NAME, "")
            .putString(KEY_STYLE_LABEL, "")
            .putInt(KEY_DOWNLOADED, 0)
            .putInt(KEY_TOTAL, 0)
            .putInt(KEY_FAILED, 0)
            .putString(KEY_PHASE, "style")
            .putString(KEY_COMPLETED_REGION_IDS, "[]")
            .putString(KEY_QUEUE_FILE_PATH, queueFilePath == null ? "" : queueFilePath)
            .putString(KEY_MESSAGE, "")
            .apply();
    }

    private void persistTaskStart() {
        SharedPreferences prefs = getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
        prefs.edit()
            .putBoolean(KEY_ACTIVE, true)
            .putInt(KEY_QUEUE_INDEX, currentQueueIndex)
            .putInt(KEY_QUEUE_TOTAL, currentQueue.size())
            .putString(KEY_REGION_ID, currentTask != null ? currentTask.regionId : "")
            .putString(KEY_REGION_NAME, currentTask != null ? currentTask.regionName : "")
            .putString(KEY_STYLE_LABEL, currentTask != null ? currentTask.styleLabel : "")
            .putInt(KEY_DOWNLOADED, 0)
            .putInt(KEY_TOTAL, 0)
            .putInt(KEY_FAILED, 0)
            .putString(KEY_PHASE, "tiles")
            .apply();
    }

    private void persistProgress(String phase, int downloaded, int total, int failed) {
        SharedPreferences prefs = getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
        prefs.edit()
            .putBoolean(KEY_ACTIVE, true)
            .putInt(KEY_QUEUE_INDEX, currentQueueIndex)
            .putInt(KEY_QUEUE_TOTAL, currentQueue.size())
            .putString(KEY_REGION_ID, currentTask != null ? currentTask.regionId : "")
            .putString(KEY_REGION_NAME, currentTask != null ? currentTask.regionName : "")
            .putString(KEY_STYLE_LABEL, currentTask != null ? currentTask.styleLabel : "")
            .putInt(KEY_DOWNLOADED, downloaded)
            .putInt(KEY_TOTAL, total)
            .putInt(KEY_FAILED, failed)
            .putString(KEY_PHASE, phase)
            .apply();
    }

    private void clearPersistedActiveState() {
        SharedPreferences prefs = getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
        prefs.edit()
            .putBoolean(KEY_ACTIVE, false)
            .remove(KEY_QUEUE_FILE_PATH)
            .putString(KEY_MESSAGE, "")
            .apply();
    }

    private void postSuccessQueueNotification(int completed, int total, int failed) {
        if (notificationManager == null) return;
        PendingIntent contentIntent = PendingIntent.getActivity(
            this, 1, buildOpenSheetIntent(),
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );
        String body;
        if (failed == 0) {
            body = "Alle " + completed + " Regionen erfolgreich gespeichert.";
        } else {
            body = completed + " von " + total + " Regionen gespeichert (" + failed + " Fehler).";
        }
        Notification notification = new NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("Offline-Karten bereit")
            .setContentText(body)
            .setStyle(new NotificationCompat.BigTextStyle().bigText(body))
            .setSmallIcon(getApplicationInfo().icon)
            .setAutoCancel(true)
            .setOngoing(false)
            .setOnlyAlertOnce(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setCategory(NotificationCompat.CATEGORY_STATUS)
            .setContentIntent(contentIntent)
            .build();
        try { notificationManager.notify(NOTIFICATION_ID + 1, notification); } catch (SecurityException ignored) {}
    }

    private void postFinalQueueNotification(String reason, int completed, int total) {
        if (notificationManager == null) return;
        PendingIntent contentIntent = PendingIntent.getActivity(
            this, 2, buildOpenSheetIntent(),
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );
        boolean isCancel = "Abgebrochen".equalsIgnoreCase(reason);
        String title = isCancel ? "Offline-Karten: Abgebrochen" : "Offline-Karten: Fehler";
        String body = isCancel
            ? (completed + " von " + total + " Regionen gespeichert · Abbruch sauber aufgeräumt")
            : (reason + " · " + completed + " von " + total + " Regionen gespeichert");
        Notification notification = new NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(new NotificationCompat.BigTextStyle().bigText(body))
            .setSmallIcon(getApplicationInfo().icon)
            .setAutoCancel(true)
            .setOngoing(false)
            .setOnlyAlertOnce(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setCategory(NotificationCompat.CATEGORY_STATUS)
            .setContentIntent(contentIntent)
            .build();
        try { notificationManager.notify(NOTIFICATION_ID + 2, notification); } catch (SecurityException ignored) {}
    }

    private Notification buildNotification(String phase, int downloaded, int total) {
        return buildNotification(phase, downloaded, total, 0);
    }

    private Notification buildNotification(String phase, int downloaded, int total, int failed) {
        PendingIntent contentIntent = PendingIntent.getActivity(
            this, 0, buildOpenSheetIntent(),
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );

        Intent cancelIntent = new Intent(this, OfflineMapCancelReceiver.class);
        cancelIntent.setAction(OfflineMapCancelReceiver.ACTION_CANCEL);
        PendingIntent cancelPending = PendingIntent.getBroadcast(
            this, 0, cancelIntent,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );

        String regionName = currentTask != null ? currentTask.regionName : "Karte";
        String styleLabel = currentTask != null ? currentTask.styleLabel : "";
        int queueSize = currentQueue.size();
        String queuePrefix = queueSize > 1 ? ("(" + (currentQueueIndex + 1) + "/" + queueSize + ") ") : "";
        String title = queuePrefix + "Karte wird geladen: " + regionName;

        String text;
        if ("style".equals(phase)) {
            text = "Stil-Daten werden geladen…";
        } else {
            int processed = Math.min(Math.max(0, total), Math.max(0, downloaded) + Math.max(0, failed));
            int missing = Math.max(0, total - processed);
            text = processed + " / " + Math.max(total, processed) + " Kacheln"
                + " (OK " + Math.max(0, downloaded)
                + ", Fehler " + Math.max(0, failed)
                + ", offen " + missing + ")";
        }
        if (styleLabel != null && !styleLabel.isEmpty()) text = text + " · " + styleLabel;

        NotificationCompat.Builder builder = new NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle(title)
            .setContentText(text)
            .setStyle(new NotificationCompat.BigTextStyle().bigText(text))
            .setSmallIcon(getApplicationInfo().icon)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setCategory(NotificationCompat.CATEGORY_PROGRESS)
            .setContentIntent(contentIntent)
            .addAction(android.R.drawable.ic_menu_close_clear_cancel, "Abbrechen", cancelPending);

        if ("style".equals(phase) || total <= 0) {
            builder.setProgress(0, 0, true);
        } else {
            builder.setProgress(total, Math.min(Math.max(0, downloaded) + Math.max(0, failed), total), false);
        }
        return builder.build();
    }

    private Intent buildOpenSheetIntent() {
        Intent launchIntent = getPackageManager().getLaunchIntentForPackage(getPackageName());
        if (launchIntent == null) {
            launchIntent = new Intent(Intent.ACTION_MAIN);
            launchIntent.setPackage(getPackageName());
        }
        launchIntent.setAction(Intent.ACTION_VIEW);
        launchIntent.addFlags(Intent.FLAG_ACTIVITY_REORDER_TO_FRONT | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        launchIntent.putExtra("openOfflineSheet", true);
        return launchIntent;
    }

    private void sendBroadcastEvent(String eventType, String regionId, String regionName, int downloaded, int total, int failed, String phase, int queueIndex, int queueTotal, JSONObject regionRecord, List<String> completedRegionIds) {
        sendBroadcastEvent(eventType, regionId, regionName, downloaded, total, failed, phase, queueIndex, queueTotal, regionRecord, completedRegionIds, "");
    }

    private void sendBroadcastEvent(String eventType, String regionId, String regionName, int downloaded, int total, int failed, String phase, int queueIndex, int queueTotal, JSONObject regionRecord, List<String> completedRegionIds, String message) {
        Intent broadcast = new Intent(BROADCAST_PROGRESS);
        broadcast.setPackage(getPackageName());
        broadcast.putExtra(BROADCAST_EVENT_TYPE, eventType);
        broadcast.putExtra(BROADCAST_REGION_ID, regionId == null ? "" : regionId);
        broadcast.putExtra(BROADCAST_REGION_NAME, regionName == null ? "" : regionName);
        broadcast.putExtra(BROADCAST_DOWNLOADED, downloaded);
        broadcast.putExtra(BROADCAST_TOTAL, total);
        broadcast.putExtra(BROADCAST_FAILED, failed);
        int processed = Math.min(Math.max(0, total), Math.max(0, downloaded) + Math.max(0, failed));
        broadcast.putExtra(BROADCAST_PROCESSED, processed);
        broadcast.putExtra(BROADCAST_MISSING, Math.max(0, total - processed));
        broadcast.putExtra(BROADCAST_WORKERS, Math.max(0, adaptiveWorkerCount.get()));
        broadcast.putExtra(BROADCAST_PHASE, phase);
        broadcast.putExtra(BROADCAST_QUEUE_INDEX, queueIndex);
        broadcast.putExtra(BROADCAST_QUEUE_TOTAL, queueTotal);
        if (message != null && !message.isEmpty()) broadcast.putExtra(BROADCAST_MESSAGE, message);
        if (regionRecord != null) broadcast.putExtra(BROADCAST_REGION_RECORD, regionRecord.toString());
        if (completedRegionIds != null) {
            JSONArray arr = new JSONArray();
            for (String r : completedRegionIds) arr.put(r);
            broadcast.putExtra(BROADCAST_COMPLETED_REGION_IDS, arr.toString());
        }
        try { sendBroadcast(broadcast); } catch (Exception ignored) {}
    }

    private void ensureNotificationChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O || notificationManager == null) return;
        NotificationChannel channel = new NotificationChannel(
            CHANNEL_ID,
            "Offline-Karten-Download",
            NotificationManager.IMPORTANCE_LOW
        );
        channel.setDescription("Fortschritt beim Herunterladen von Karten-Regionen.");
        channel.setSound(null, null);
        notificationManager.createNotificationChannel(channel);
    }

    private void acquireWakeLock() {
        if (wakeLock != null && wakeLock.isHeld()) return;
        PowerManager powerManager = (PowerManager) getSystemService(Context.POWER_SERVICE);
        if (powerManager == null) return;
        wakeLock = powerManager.newWakeLock(
            PowerManager.PARTIAL_WAKE_LOCK,
            getPackageName() + ":OfflineMapDownloadService"
        );
        wakeLock.setReferenceCounted(false);
        try { wakeLock.acquire(120L * 60L * 1000L); } catch (SecurityException ignored) { wakeLock = null; }
    }

    private void releaseWakeLock() {
        if (wakeLock != null && wakeLock.isHeld()) {
            try { wakeLock.release(); } catch (RuntimeException ignored) {}
        }
        wakeLock = null;
    }

    private static String nonEmpty(String value, String fallback) {
        if (value == null) return fallback;
        String trimmed = value.trim();
        return trimmed.isEmpty() ? fallback : trimmed;
    }

    private static String readTextFile(File file) {
        if (file == null || !file.exists()) return null;
        try {
            FileInputStream fis = new FileInputStream(file);
            try {
                ByteArrayOutputStream out = new ByteArrayOutputStream((int) Math.max(2048, file.length()));
                byte[] buffer = new byte[16 * 1024];
                int read;
                while ((read = fis.read(buffer)) > 0) out.write(buffer, 0, read);
                return out.toString(StandardCharsets.UTF_8.name());
            } finally {
                try { fis.close(); } catch (Exception ignored) {}
            }
        } catch (Exception e) {
            Log.e(TAG, "Datei konnte nicht gelesen werden: " + file.getAbsolutePath(), e);
            return null;
        }
    }

    private static List<RegionTask> parseQueue(String json) throws Exception {
        List<RegionTask> tasks = new ArrayList<>();
        JSONArray arr = new JSONArray(json);
        for (int i = 0; i < arr.length(); i += 1) {
            JSONObject obj = arr.getJSONObject(i);
            RegionTask t = new RegionTask();
            t.regionId = obj.optString("regionId", "");
            t.regionName = obj.optString("regionName", "Karte");
            t.styleLabel = obj.optString("styleLabel", "");
            t.urlsFilePath = obj.optString("urlsFilePath", "");
            t.jobId = obj.optString("jobId", "");
            t.regionRecord = obj.optJSONObject("regionRecord");
            if (!t.regionId.isEmpty() && !t.urlsFilePath.isEmpty()) tasks.add(t);
        }
        return tasks;
    }

    private static class RegionTask {
        String regionId;
        String regionName;
        String styleLabel;
        String urlsFilePath;
        String jobId = "";
        JSONObject regionRecord;
    }

    private static class UrlTask {
        final String url;
        final boolean required;

        UrlTask(String url, boolean required) {
            this.url = url;
            this.required = required;
        }
    }

    private static class RegionOutcome {
        boolean ready = false;
        String status = "fortsetzbar";
        JSONObject record = null;
    }
}
