package de.tracking.mobile.gps;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.location.Location;
import android.os.Build;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;

import androidx.core.app.NotificationCompat;

import com.google.android.gms.location.FusedLocationProviderClient;
import com.google.android.gms.location.LocationCallback;
import com.google.android.gms.location.LocationRequest;
import com.google.android.gms.location.LocationResult;
import com.google.android.gms.location.LocationServices;
import com.google.android.gms.location.Priority;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.DataInputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.URI;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public class NativeGpsUploadService extends Service {
    public static final String ACTION_FLUSH_UPLOAD_QUEUE = "de.tracking.mobile.gps.FLUSH_UPLOAD_QUEUE";
    public static final String PREFS_NAME = "native_gps_upload";
    public static final String KEY_ENABLED = "enabled";
    public static final String KEY_SERVER_URL = "serverUrl";
    public static final String KEY_DEVICE_KEY = "deviceKey";
    public static final String KEY_TRACKING = "tracking";
    public static final String KEY_MQTT_HOST = "mqttHost";
    public static final String KEY_MQTT_PORT = "mqttPort";
    public static final String KEY_MQTT_TOPIC_PREFIX = "mqttTopicPrefix";
    public static final String KEY_TRACK_ID = "trackId";
    public static final String KEY_SEQUENCE = "sequenceNumber";
    public static final String KEY_ROUTE_SEGMENT_ID = "routeSegmentId";
    public static final String KEY_ROUTE_BREAK_PENDING = "routeBreakPending";
    public static final String KEY_ROUTE_LAST_LAT = "routeLastLat";
    public static final String KEY_ROUTE_LAST_LON = "routeLastLon";
    public static final String KEY_ROUTE_LAST_TIME = "routeLastTime";
    public static final String KEY_ROUTE_LAST_HEADING = "routeLastHeading";
    public static final String KEY_ROUTE_LAST_SPEED = "routeLastSpeed";
    public static final String KEY_HEADING_MAP_BEARING_DEADBAND_DEG = "headingMapBearingDeadbandDeg";
    public static final String KEY_QUEUE = "mqttQueue";
    public static final String KEY_LOCAL_ROUTE = "localRoute";
    public static final String KEY_IDLE_SEC = "idleSec";
    public static final String KEY_MOVING_SEC = "movingSec";
    public static final String KEY_INTERVAL_MIN = "intervalMin";
    public static final String KEY_MIN_MOVE_M = "minMoveM";
    public static final String KEY_MAX_ACCURACY_M = "maxAccuracyM";
    public static final String KEY_WALKING_SPEED_KMH = "walkingSpeedKmh";
    public static final String KEY_MOVING_SPEED_KMH = "movingSpeedKmh";
    public static final String KEY_STATIONARY_RADIUS_M = "stationaryRadiusM";
    public static final String KEY_STATIONARY_MAX_RADIUS_M = "stationaryMaxRadiusM";
    public static final String KEY_CONFIRM_POINTS = "confirmPoints";
    public static final String KEY_SPEED_JUMP_KMH = "speedJumpKmh";
    public static final String KEY_DRIVE_ENTER_SPEED_KMH = "driveEnterSpeedKmh";
    public static final String KEY_DRIVE_EXIT_SPEED_KMH = "driveExitSpeedKmh";
    public static final String KEY_DRIVE_CONFIRM_FIXES = "driveConfirmFixes";
    public static final String KEY_DRIVE_EXIT_HOLD_MS = "driveExitHoldMs";
    public static final String KEY_DRIVE_MIN_MOVE_M = "driveMinMoveM";
    public static final String KEY_PAUSED = "paused";
    public static final String KEY_SERVER_UPLOAD = "serverUploadEnabled";
    public static final String KEY_SERVER_LIVE_HEADING = "serverLiveHeadingEnabled";
    public static final String KEY_LAST_ROUTE_SEND_MS = "lastRouteSendMs";
    public static final String KEY_LAST_KEEPALIVE_SEND_MS = "lastKeepaliveSendMs";
    public static final String KEY_COMPASS_HEADING = "compassHeading";
    public static final String KEY_COMPASS_HEADING_AT_MS = "compassHeadingAtMs";
    public static final long COMPASS_MAX_AGE_MS = 8000L;

    private static final int NOTIFICATION_ID = 28352;
    private static final int LIVE_NOTIFICATION_ID = 28353;
    private static final String CHANNEL_ID = "native_gps_upload_channel";
    private static final double STATIONARY_SPEED_KMH = 1.2;

    private FusedLocationProviderClient fusedClient;
    private LocationCallback locationCallback;
    private final ExecutorService uploadExecutor = Executors.newSingleThreadExecutor();

    private long lastSendMs = 0;
    private long lastRouteSendMs = 0;
    private long lastKeepaliveSendMs = 0;
    private Double lastLat = null;
    private Double lastLon = null;
    private Double stableLat = null;
    private Double stableLon = null;
    private Float stableAccuracy = null;
    private Float stableBearing = null;
    private Long stableTimeMs = null;
    private Float lastAcceptedSpeedKmh = null;
    private int stationaryExitCount = 0;
    private boolean driveModeActive = false;
    private int driveConfirmStreak = 0;
    private long driveExitSinceMs = 0;
    private Double lastMovementHoldHeading = null;
    private PowerManager.WakeLock wakeLock = null;

    private static class EffectiveHeading {
        final Double value;
        final String source;
        final String mode;

        EffectiveHeading(Double value, String source, String mode) {
            this.value = value;
            this.source = source;
            this.mode = mode;
        }
    }

    private static class RouteDecision {
        final boolean accept;
        final boolean breakBefore;

        RouteDecision(boolean accept, boolean breakBefore) {
            this.accept = accept;
            this.breakBefore = breakBefore;
        }
    }

    @Override
    public void onCreate() {
        super.onCreate();
        fusedClient = LocationServices.getFusedLocationProviderClient(this);
        ensureNotificationChannel();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        SharedPreferences prefs = getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
        if (intent != null && ACTION_FLUSH_UPLOAD_QUEUE.equals(intent.getAction())) {
            uploadExecutor.execute(() -> flushUploadQueue(prefs));
            return START_NOT_STICKY;
        }
        boolean shouldRun = prefs.getBoolean(KEY_ENABLED, false) &&
            (prefs.getBoolean(KEY_TRACKING, false) || prefs.getBoolean(KEY_SERVER_UPLOAD, false));
        if (!shouldRun) {
            cancelExtraNotifications();
            releaseWakeLock();
            stopSelf();
            return START_NOT_STICKY;
        }
        prefs.edit().putBoolean(KEY_PAUSED, false).apply();
        startForeground(NOTIFICATION_ID, buildNotification(prefs));
        syncExtraNotifications(prefs);
        acquireWakeLock();
        startLocationUpdates();
        return START_STICKY;
    }

    @Override
    public void onTaskRemoved(Intent rootIntent) {
        SharedPreferences prefs = getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
        prefs.edit().putBoolean(KEY_PAUSED, false).apply();
        if (prefs.getBoolean(KEY_ENABLED, false) &&
            (prefs.getBoolean(KEY_TRACKING, false) || prefs.getBoolean(KEY_SERVER_UPLOAD, false))) {
            Intent restart = new Intent(getApplicationContext(), NativeGpsUploadService.class);
            try {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    startForegroundService(restart);
                } else {
                    startService(restart);
                }
            } catch (Exception ignored) {}
        }
        super.onTaskRemoved(rootIntent);
    }

    @Override
    public void onDestroy() {
        stopLocationUpdates();
        cancelExtraNotifications();
        releaseWakeLock();
        uploadExecutor.shutdownNow();
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    private void ensureNotificationChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager == null) return;
        NotificationChannel channel = new NotificationChannel(
            CHANNEL_ID,
            "GPS Hintergrund-Upload",
            NotificationManager.IMPORTANCE_LOW
        );
        channel.setSound(null, null);
        manager.createNotificationChannel(channel);
    }

    private Notification buildNotification(SharedPreferences prefs) {
        boolean tracking = prefs.getBoolean(KEY_TRACKING, false);
        boolean uploadEnabled = prefs.getBoolean(KEY_SERVER_UPLOAD, true);
        Intent launchIntent = getPackageManager().getLaunchIntentForPackage(getPackageName());
        PendingIntent pendingIntent = null;
        if (launchIntent != null) {
            launchIntent.addFlags(Intent.FLAG_ACTIVITY_REORDER_TO_FRONT);
            pendingIntent = PendingIntent.getActivity(
                this,
                0,
                launchIntent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
            );
        }
        String title;
        String text;
        if (tracking && uploadEnabled) {
            title = "Tracking lokal aktiv + Live-Übertragung aktiv";
            text = "Route wird lokal aufgezeichnet und Live-Punkte werden übertragen";
        } else if (tracking) {
            title = "Tracking lokal aktiv";
            text = "Route wird lokal aufgezeichnet";
        } else if (uploadEnabled) {
            title = "Live-Übertragung aktiv";
            text = "Live-Standort wird im Hintergrund übertragen";
        } else {
            title = "GPS Dienst bereit";
            text = "Keine Hintergrundübertragung aktiv";
        }
        NotificationCompat.Builder builder = new NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle(title)
            .setContentText(text)
            .setSmallIcon(getApplicationInfo().icon)
            .setOngoing(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setCategory(NotificationCompat.CATEGORY_SERVICE);
        if (pendingIntent != null) builder.setContentIntent(pendingIntent);
        return builder.build();
    }

    private Notification buildLiveNotification() {
        return new NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("Live-Ãœbertragung aktiv")
            .setContentText("Live-Standort wird im Hintergrund Ã¼bertragen")
            .setSmallIcon(getApplicationInfo().icon)
            .setOngoing(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .build();
    }

    private void syncExtraNotifications(SharedPreferences prefs) {
        boolean tracking = prefs.getBoolean(KEY_TRACKING, false);
        boolean uploadEnabled = prefs.getBoolean(KEY_SERVER_UPLOAD, false);
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager == null) return;
        if (tracking && uploadEnabled) {
            try {
                manager.notify(LIVE_NOTIFICATION_ID, buildLiveTransferNotification());
            } catch (SecurityException ignored) {}
        } else {
            manager.cancel(LIVE_NOTIFICATION_ID);
        }
    }

    private Notification buildLiveTransferNotification() {
        return new NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("Live-Uebertragung aktiv")
            .setContentText("Live-Standort wird im Hintergrund uebertragen")
            .setSmallIcon(getApplicationInfo().icon)
            .setOngoing(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .build();
    }

    private void cancelExtraNotifications() {
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager != null) manager.cancel(LIVE_NOTIFICATION_ID);
    }

    private void acquireWakeLock() {
        if (wakeLock != null && wakeLock.isHeld()) return;
        PowerManager powerManager = (PowerManager) getSystemService(Context.POWER_SERVICE);
        if (powerManager == null) return;
        wakeLock = powerManager.newWakeLock(
            PowerManager.PARTIAL_WAKE_LOCK,
            getPackageName() + ":NativeGpsUploadService"
        );
        wakeLock.setReferenceCounted(false);
        try {
            wakeLock.acquire();
        } catch (SecurityException ignored) {
            wakeLock = null;
        }
    }

    private void releaseWakeLock() {
        if (wakeLock != null && wakeLock.isHeld()) {
            wakeLock.release();
        }
        wakeLock = null;
    }

    private void startLocationUpdates() {
        stopLocationUpdates();
        SharedPreferences prefs = getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
        long movingMs = Math.max(200L, Math.round(doublePref(prefs, KEY_MOVING_SEC, 0.5, 0.2, 60.0) * 1000.0));
        LocationRequest request = new LocationRequest.Builder(Priority.PRIORITY_HIGH_ACCURACY, movingMs)
            .setMinUpdateIntervalMillis(movingMs)
            .setMinUpdateDistanceMeters(0f)
            .setMaxUpdateDelayMillis(movingMs)
            .build();
        locationCallback = new LocationCallback() {
            @Override
            public void onLocationResult(LocationResult locationResult) {
                Location location = locationResult.getLastLocation();
                if (location != null) handleLocation(location);
            }
        };
        try {
            fusedClient.requestLocationUpdates(request, locationCallback, Looper.getMainLooper());
        } catch (SecurityException ignored) {}
    }

    private void stopLocationUpdates() {
        if (fusedClient != null && locationCallback != null) {
            fusedClient.removeLocationUpdates(locationCallback);
        }
        locationCallback = null;
    }

    private void handleLocation(Location location) {
        SharedPreferences prefs = getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
        if (!prefs.getBoolean(KEY_ENABLED, false)) return;
        boolean tracking = prefs.getBoolean(KEY_TRACKING, false);
        boolean uploadEnabled = prefs.getBoolean(KEY_SERVER_UPLOAD, false);
        if (!tracking && !uploadEnabled) return;
        if (!liveLocationAccepted(location)) return;
        lastRouteSendMs = prefs.getLong(KEY_LAST_ROUTE_SEND_MS, lastRouteSendMs);
        lastKeepaliveSendMs = prefs.getLong(KEY_LAST_KEEPALIVE_SEND_MS, lastKeepaliveSendMs);

        Location stableLocation = stabilizeLocation(location, prefs);
        if (stableLocation == null) return;
        if (tracking) {
            RouteDecision decision = routePointDecision(stableLocation, prefs);
            if (decision.accept) {
                uploadExecutor.execute(() -> publishLocation(stableLocation, prefs, decision));
            }
        }
        if (uploadEnabled) {
            Location uploadLocation = stableLocation;
            uploadExecutor.execute(() -> tickServerUpload(uploadLocation, prefs));
        }
    }

    private long routeSendIntervalMs(SharedPreferences prefs) {
        double intervalMin = doublePref(prefs, KEY_INTERVAL_MIN, 0.0, 0.0, 1440.0);
        if (intervalMin > 0.0) return (long) (intervalMin * 60.0 * 1000.0);
        return Math.max(200L, Math.round(doublePref(prefs, KEY_MOVING_SEC, 0.5, 0.2, 60.0) * 1000.0));
    }

    private long keepaliveSendIntervalMs(SharedPreferences prefs) {
        double intervalMin = doublePref(prefs, KEY_INTERVAL_MIN, 0.0, 0.0, 1440.0);
        if (intervalMin > 0.0) return (long) (intervalMin * 60.0 * 1000.0);
        return Math.max(1000L, Math.round(doublePref(prefs, KEY_IDLE_SEC, 2.0, 1.0, 3600.0) * 1000.0));
    }

    private boolean isRouteSendDue(SharedPreferences prefs) {
        long intervalMs = routeSendIntervalMs(prefs);
        return lastRouteSendMs <= 0 || System.currentTimeMillis() - lastRouteSendMs >= intervalMs;
    }

    private boolean isKeepaliveSendDue(SharedPreferences prefs) {
        long intervalMs = keepaliveSendIntervalMs(prefs);
        return lastKeepaliveSendMs <= 0 || System.currentTimeMillis() - lastKeepaliveSendMs >= intervalMs;
    }

    private void tickServerUpload(Location stableLocation, SharedPreferences prefs) {
        if (!prefs.getBoolean(KEY_SERVER_UPLOAD, false) || stableLocation == null) return;
        if (prefs.getBoolean(KEY_SERVER_LIVE_HEADING, false) && !prefs.getBoolean(KEY_TRACKING, false)) return;
        String deviceKey = prefs.getString(KEY_DEVICE_KEY, "");
        if (deviceKey.isEmpty()) return;
        try {
            String topic = mqttTopic(prefs, deviceKey);
            if (topic.isEmpty()) return;
            JSONArray queue = readMqttQueue(prefs);
            if (queue.length() > 0) {
                if (!isRouteSendDue(prefs)) return;
                JSONObject payload = queue.optJSONObject(0);
                if (payload == null) return;
                if (publishMqtt(prefs, topic, payload.toString(), payload.optLong("sequenceNumber", 1L))) {
                    JSONArray remaining = new JSONArray();
                    for (int i = 1; i < queue.length(); i += 1) {
                        remaining.put(queue.opt(i));
                    }
                    writeMqttQueue(prefs, remaining);
                    lastRouteSendMs = System.currentTimeMillis();
                    lastSendMs = lastRouteSendMs;
                    prefs.edit().putLong(KEY_LAST_ROUTE_SEND_MS, lastRouteSendMs).apply();
                }
                return;
            }
            if (!isKeepaliveSendDue(prefs)) return;
            JSONObject payload = livePayloadJson(stableLocation, deviceKey, prefs);
            if (publishMqtt(prefs, topic, payload.toString(), payload.optLong("timestamp", System.currentTimeMillis()))) {
                lastKeepaliveSendMs = System.currentTimeMillis();
                lastSendMs = lastKeepaliveSendMs;
                prefs.edit().putLong(KEY_LAST_KEEPALIVE_SEND_MS, lastKeepaliveSendMs).apply();
                lastLat = stableLocation.getLatitude();
                lastLon = stableLocation.getLongitude();
            }
        } catch (Exception ignored) {}
    }

    private void flushUploadQueue(SharedPreferences prefs) {
        String deviceKey = prefs.getString(KEY_DEVICE_KEY, "");
        if (deviceKey.isEmpty() || !prefs.getBoolean(KEY_SERVER_UPLOAD, false)) return;
        String topic = mqttTopic(prefs, deviceKey);
        if (topic.isEmpty()) return;
        JSONArray queue = readMqttQueue(prefs);
        while (queue.length() > 0) {
            JSONObject payload = queue.optJSONObject(0);
            if (payload == null) break;
            if (!publishMqtt(prefs, topic, payload.toString(), payload.optLong("sequenceNumber", 1L))) break;
            JSONArray remaining = new JSONArray();
            for (int i = 1; i < queue.length(); i += 1) {
                remaining.put(queue.opt(i));
            }
            queue = remaining;
            writeMqttQueue(prefs, queue);
            lastRouteSendMs = System.currentTimeMillis();
        }
        prefs.edit().putLong(KEY_LAST_ROUTE_SEND_MS, lastRouteSendMs).apply();
    }

    private boolean liveLocationAccepted(Location location) {
        if (location == null) return false;
        double lat = location.getLatitude();
        double lon = location.getLongitude();
        return !Double.isNaN(lat) && !Double.isNaN(lon)
            && Math.abs(lat) <= 90.0 && Math.abs(lon) <= 180.0;
    }

    private Location stabilizeLocation(Location location, SharedPreferences prefs) {
        double maxAccuracyM = doublePref(prefs, KEY_MAX_ACCURACY_M, 20.0, 5.0, 100.0);
        if (stableLat == null || stableLon == null) {
            if (location.hasAccuracy() && location.getAccuracy() > maxAccuracyM) return null;
            stableLat = location.getLatitude();
            stableLon = location.getLongitude();
            stableAccuracy = location.hasAccuracy() ? location.getAccuracy() : null;
            stableBearing = location.hasBearing() ? location.getBearing() : null;
            stableTimeMs = location.getTime() > 0 ? location.getTime() : System.currentTimeMillis();
            return location;
        }
        double accuracy = location.hasAccuracy() ? location.getAccuracy() : 0.0;
        double minMoveM = doublePref(prefs, KEY_MIN_MOVE_M, 1.0, 0.2, 20.0);
        double walkingSpeed = doublePref(prefs, KEY_WALKING_SPEED_KMH, 1.6, 0.5, 8.0);
        double movingSpeed = doublePref(prefs, KEY_MOVING_SPEED_KMH, 3.0, walkingSpeed, 30.0);
        int confirmPoints = intPref(prefs, KEY_CONFIRM_POINTS, 3, 1, 8);
        double driftRadius = Math.max(
            doublePref(prefs, KEY_STATIONARY_RADIUS_M, 18.0, 3.0, 80.0),
            Math.min(doublePref(prefs, KEY_STATIONARY_MAX_RADIUS_M, 80.0, 3.0, 150.0), accuracy * 1.5)
        );
        double distance = distanceMeters(stableLat, stableLon, location.getLatitude(), location.getLongitude());
        double speedKmh = location.hasSpeed() ? (location.getSpeed() <= 60f ? location.getSpeed() * 3.6 : location.getSpeed()) : -1.0;
        long pointTimeMs = location.getTime() > 0 ? location.getTime() : System.currentTimeMillis();
        double dtSeconds = Math.max(0.2, (pointTimeMs - (stableTimeMs != null ? stableTimeMs : pointTimeMs)) / 1000.0);
        double inferredSpeedKmh = dtSeconds < 20.0 ? distance / dtSeconds * 3.6 : -1.0;
        if (speedKmh < walkingSpeed && inferredSpeedKmh >= walkingSpeed && distance >= Math.min(minMoveM, 0.8)) {
            speedKmh = inferredSpeedKmh;
            location.setSpeed((float) (speedKmh / 3.6));
        }
        if (speedKmh >= walkingSpeed && distance >= Math.min(minMoveM, 0.8)) {
            location.setBearing((float) bearingDegrees(stableLat, stableLon, location.getLatitude(), location.getLongitude()));
        }
        if (location.hasAccuracy() && location.getAccuracy() > maxAccuracyM) return fixedStationaryLocation(location);
        boolean speedMotionCandidate = speedKmh >= walkingSpeed && distance >= Math.min(minMoveM, 0.8);
        boolean movingNow = distance > driftRadius || (speedKmh >= movingSpeed && distance >= 1.5)
            || (speedMotionCandidate && stationaryExitCount + 1 >= confirmPoints);
        if (!movingNow && distance <= driftRadius && !speedMotionCandidate) {
            stationaryExitCount = 0;
            maybeAdoptBetterStationaryLocation(location, driftRadius, distance);
            return fixedStationaryLocation(location);
        }
        if (!movingNow && ++stationaryExitCount < confirmPoints) {
            return fixedStationaryLocation(location);
        }
        if (movingNow && (lastAcceptedSpeedKmh == null || lastAcceptedSpeedKmh <= walkingSpeed)
            && distance <= Math.max(35.0, driftRadius * 1.5)
            && ++stationaryExitCount < confirmPoints) {
            return fixedStationaryLocation(location);
        }
        stationaryExitCount = 0;
        stableLat = location.getLatitude();
        stableLon = location.getLongitude();
        stableAccuracy = location.hasAccuracy() ? location.getAccuracy() : null;
        stableBearing = location.hasBearing() ? location.getBearing() : null;
        stableTimeMs = pointTimeMs;
        return smoothedMovingLocation(location, speedKmh, prefs);
    }

    private Location fixedStationaryLocation(Location location) {
        Location fixed = new Location(location);
        fixed.setLatitude(stableLat);
        fixed.setLongitude(stableLon);
        fixed.setSpeed(0f);
        lastAcceptedSpeedKmh = 0f;
        if (stableAccuracy != null) fixed.setAccuracy(stableAccuracy);
        if (location.hasBearing()) stableBearing = location.getBearing();
        if (stableBearing != null) fixed.setBearing(stableBearing);
        return fixed;
    }

    private Location smoothedMovingLocation(Location location, double speedKmh, SharedPreferences prefs) {
        if (speedKmh < 0) return location;
        double previous = lastAcceptedSpeedKmh != null ? lastAcceptedSpeedKmh : 0.0;
        double speedJump = doublePref(prefs, KEY_SPEED_JUMP_KMH, 8.0, 2.0, 60.0);
        double smoothed = speedKmh > previous + speedJump ? previous + (speedKmh - previous) * 0.35 : speedKmh;
        Location result = new Location(location);
        result.setSpeed((float) (smoothed / 3.6));
        lastAcceptedSpeedKmh = (float) smoothed;
        return result;
    }

    private void maybeAdoptBetterStationaryLocation(Location location, double driftRadius, double distance) {
        if (location.hasBearing()) stableBearing = location.getBearing();
        if (!location.hasAccuracy()) return;
        if ((stableAccuracy == null || location.getAccuracy() + 1f < stableAccuracy)
            && distance <= Math.max(5.0, driftRadius * 0.5)) {
            stableLat = location.getLatitude();
            stableLon = location.getLongitude();
            stableAccuracy = location.getAccuracy();
        }
    }

    private double doublePref(SharedPreferences prefs, String key, double fallback, double min, double max) {
        Object raw = prefs.getAll().get(key);
        double value = raw instanceof Number ? ((Number) raw).doubleValue() : fallback;
        return Math.min(max, Math.max(min, value));
    }

    private int intPref(SharedPreferences prefs, String key, int fallback, int min, int max) {
        return (int) Math.round(doublePref(prefs, key, fallback, min, max));
    }

    private static double distanceMeters(double latA, double lonA, double latB, double lonB) {
        double earthRadiusM = 6371000.0;
        double dLat = Math.toRadians(latB - latA);
        double dLon = Math.toRadians(lonB - lonA);
        double a = Math.sin(dLat / 2) * Math.sin(dLat / 2)
            + Math.cos(Math.toRadians(latA)) * Math.cos(Math.toRadians(latB))
            * Math.sin(dLon / 2) * Math.sin(dLon / 2);
        return 2 * earthRadiusM * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    }

    private static double bearingDegrees(double latA, double lonA, double latB, double lonB) {
        double dLon = Math.toRadians(lonB - lonA);
        double y = Math.sin(dLon) * Math.cos(Math.toRadians(latB));
        double x = Math.cos(Math.toRadians(latA)) * Math.sin(Math.toRadians(latB))
            - Math.sin(Math.toRadians(latA)) * Math.cos(Math.toRadians(latB)) * Math.cos(dLon);
        return (Math.toDegrees(Math.atan2(y, x)) + 360.0) % 360.0;
    }

    private static double headingDelta(double a, double b) {
        double d = Math.abs(a - b) % 360.0;
        return d > 180.0 ? 360.0 - d : d;
    }

    private void updateDriveModeState(double speedKmh, double distanceM, long timestampMs, SharedPreferences prefs) {
        double enterSpeed = doublePref(prefs, KEY_DRIVE_ENTER_SPEED_KMH, 10.0, 5.0, 40.0);
        double exitSpeed = doublePref(prefs, KEY_DRIVE_EXIT_SPEED_KMH, 6.0, 3.0, 30.0);
        double minMove = doublePref(prefs, KEY_DRIVE_MIN_MOVE_M, 1.0, 0.2, 20.0);
        int confirmFixes = intPref(prefs, KEY_DRIVE_CONFIRM_FIXES, 3, 2, 6);
        long exitHoldMs = (long) doublePref(prefs, KEY_DRIVE_EXIT_HOLD_MS, 4000.0, 1000.0, 15000.0);
        if (speedKmh >= enterSpeed && distanceM >= minMove) {
            driveConfirmStreak += 1;
            driveExitSinceMs = 0;
            if (driveConfirmStreak >= confirmFixes) {
                driveModeActive = true;
            }
            return;
        }
        if (speedKmh < exitSpeed) {
            driveConfirmStreak = 0;
            if (driveModeActive) {
                if (driveExitSinceMs <= 0) {
                    driveExitSinceMs = timestampMs;
                } else if (timestampMs - driveExitSinceMs >= exitHoldMs) {
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

    private String resolveMovementMode(double speedKmh, double distanceM, boolean movingNow, SharedPreferences prefs) {
        if (driveModeActive) return "drive";
        double walkingSpeed = doublePref(prefs, KEY_WALKING_SPEED_KMH, 1.6, 0.5, 8.0);
        double minMove = Math.min(doublePref(prefs, KEY_MIN_MOVE_M, 1.0, 0.2, 20.0), 0.8);
        if (movingNow || (speedKmh >= walkingSpeed && distanceM >= minMove)) {
            return "walk";
        }
        return "stationary";
    }

    private Double readFreshCompassHeading(SharedPreferences prefs) {
        long timestamp = prefs.getLong(KEY_COMPASS_HEADING_AT_MS, 0L);
        if (timestamp <= 0) return null;
        if (System.currentTimeMillis() - timestamp > COMPASS_MAX_AGE_MS) return null;
        long bits = prefs.getLong(KEY_COMPASS_HEADING, Double.doubleToLongBits(Double.NaN));
        double heading = Double.longBitsToDouble(bits);
        if (Double.isNaN(heading)) return null;
        return heading;
    }

    private EffectiveHeading resolveEffectiveHeading(Location location, SharedPreferences prefs) {
        Double compassHeading = readFreshCompassHeading(prefs);
        if (location == null || stableLat == null || stableLon == null) {
            if (location != null && location.hasBearing()) {
                return new EffectiveHeading((double) location.getBearing(), "gps", "walk");
            }
            if (compassHeading != null) {
                return new EffectiveHeading(compassHeading, "compass", "stationary");
            }
            return new EffectiveHeading(lastMovementHoldHeading, "hold", "stationary");
        }
        double distanceM = distanceMeters(stableLat, stableLon, location.getLatitude(), location.getLongitude());
        double speedKmh = speedKmh(location);
        if (speedKmh <= 0 && stableTimeMs != null) {
            long pointTimeMs = location.getTime() > 0 ? location.getTime() : System.currentTimeMillis();
            double dtSeconds = Math.max(0.2, (pointTimeMs - stableTimeMs) / 1000.0);
            if (dtSeconds < 20.0 && distanceM > 0) {
                double inferredSpeedKmh = distanceM / dtSeconds * 3.6;
                double walkingSpeed = doublePref(prefs, KEY_WALKING_SPEED_KMH, 1.6, 0.5, 8.0);
                if (inferredSpeedKmh >= walkingSpeed) {
                    speedKmh = inferredSpeedKmh;
                }
            }
        }
        long pointTimeMs = location.getTime() > 0 ? location.getTime() : System.currentTimeMillis();
        updateDriveModeState(speedKmh, distanceM, pointTimeMs, prefs);
        double minMove = Math.min(doublePref(prefs, KEY_MIN_MOVE_M, 1.0, 0.2, 20.0), 0.8);
        double walkingSpeed = doublePref(prefs, KEY_WALKING_SPEED_KMH, 1.6, 0.5, 8.0);
        boolean movingNow = distanceM >= minMove && speedKmh >= walkingSpeed;
        String mode = resolveMovementMode(speedKmh, distanceM, movingNow, prefs);
        Double moveHeading = distanceM >= minMove
            ? bearingDegrees(stableLat, stableLon, location.getLatitude(), location.getLongitude())
            : null;
        Double gpsBearing = location.hasBearing() ? (double) location.getBearing() : null;
        Double value = null;
        String source = "hold";
        if ("drive".equals(mode)) {
            if (moveHeading != null) {
                value = moveHeading;
                source = "movement";
            } else if (gpsBearing != null) {
                value = gpsBearing;
                source = "gps";
            } else if (lastMovementHoldHeading != null) {
                value = lastMovementHoldHeading;
                source = "hold";
            }
        } else if ("walk".equals(mode)) {
            if (moveHeading != null) {
                value = moveHeading;
                source = "movement";
            } else if (gpsBearing != null) {
                value = gpsBearing;
                source = "gps";
            } else if (compassHeading != null) {
                value = compassHeading;
                source = "compass";
            } else if (lastMovementHoldHeading != null) {
                value = lastMovementHoldHeading;
                source = "hold";
            }
        } else if (compassHeading != null) {
            value = compassHeading;
            source = "compass";
        } else if (lastMovementHoldHeading != null) {
            value = lastMovementHoldHeading;
            source = "hold";
        }
        if (value != null && ("movement".equals(source) || "gps".equals(source))) {
            lastMovementHoldHeading = value;
            location.setBearing(value.floatValue());
        }
        return new EffectiveHeading(value, source, mode);
    }

    private void putHeadingFields(JSONObject point, Location location, SharedPreferences prefs) throws Exception {
        EffectiveHeading effective = resolveEffectiveHeading(location, prefs);
        if (effective.value != null) {
            point.put("heading", effective.value);
        } else {
            point.put("heading", JSONObject.NULL);
        }
        point.put("headingSource", effective.source);
        point.put("headingMode", effective.mode);
        point.put("driveModeActive", driveModeActive);
    }

    private double speedKmh(Location location) {
        if (!location.hasSpeed()) return 0.0;
        return location.getSpeed() <= 60f ? location.getSpeed() * 3.6 : location.getSpeed();
    }

    private double routeDistanceTargetMeters(Location location, SharedPreferences prefs, boolean headingChanged) {
        double minMove = doublePref(prefs, KEY_MIN_MOVE_M, 1.0, 0.2, 20.0);
        double speed = speedKmh(location);
        if (speed < 7.0) return Math.max(minMove, headingChanged ? 0.4 : 0.9);
        if (speed < 15.0) return Math.max(minMove, headingChanged ? 0.8 : 1.4);
        if (speed < 30.0) return Math.max(minMove, headingChanged ? 1.2 : 2.4);
        if (speed < 50.0) return Math.max(minMove, headingChanged ? 2.0 : 4.0);
        return Math.max(minMove, headingChanged ? 4.0 : 8.0);
    }

    private RouteDecision routePointDecision(Location location, SharedPreferences prefs) {
        double maxAccuracyM = doublePref(prefs, KEY_MAX_ACCURACY_M, 20.0, 5.0, 100.0);
        if (location.hasAccuracy() && location.getAccuracy() > maxAccuracyM) return new RouteDecision(false, false);
        boolean hasPrevious = prefs.contains(KEY_ROUTE_LAST_LAT) && prefs.contains(KEY_ROUTE_LAST_LON);
        boolean breakBefore = prefs.getBoolean(KEY_ROUTE_BREAK_PENDING, false);
        if (!hasPrevious || breakBefore) return new RouteDecision(true, breakBefore);

        double prevLat = Double.longBitsToDouble(prefs.getLong(KEY_ROUTE_LAST_LAT, 0L));
        double prevLon = Double.longBitsToDouble(prefs.getLong(KEY_ROUTE_LAST_LON, 0L));
        long prevTime = prefs.getLong(KEY_ROUTE_LAST_TIME, 0L);
        double prevHeading = Double.longBitsToDouble(prefs.getLong(KEY_ROUTE_LAST_HEADING, Double.doubleToLongBits(Double.NaN)));
        double prevSpeed = Double.longBitsToDouble(prefs.getLong(KEY_ROUTE_LAST_SPEED, Double.doubleToLongBits(0.0)));
        double distance = distanceMeters(prevLat, prevLon, location.getLatitude(), location.getLongitude());
        long currentTime = location.getTime() > 0 ? location.getTime() : System.currentTimeMillis();
        double elapsedSeconds = prevTime > 0 && currentTime > prevTime ? (currentTime - prevTime) / 1000.0 : 0.0;
        if (elapsedSeconds > 0.0 && elapsedSeconds < 0.25) return new RouteDecision(false, false);
        double speedJump = doublePref(prefs, KEY_SPEED_JUMP_KMH, 8.0, 2.0, 60.0);
        if (elapsedSeconds > 0.0 && distance / elapsedSeconds * 3.6 > Math.max(80.0, prevSpeed + speedJump * 6.0)) {
            return new RouteDecision(false, false);
        }

        double walkingSpeed = doublePref(prefs, KEY_WALKING_SPEED_KMH, 1.6, 0.5, 8.0);
        double pointSpeed = speedKmh(location);
        if (pointSpeed < walkingSpeed) {
            double accuracy = location.hasAccuracy() ? location.getAccuracy() : 0.0;
            double stationaryLimit = Math.max(
                doublePref(prefs, KEY_MIN_MOVE_M, 1.0, 0.2, 20.0),
                Math.min(doublePref(prefs, KEY_STATIONARY_RADIUS_M, 18.0, 3.0, 80.0), accuracy * 1.3)
            );
            if (distance < stationaryLimit) return new RouteDecision(false, false);
        }

        double moveHeading = distance >= Math.max(0.8, doublePref(prefs, KEY_MIN_MOVE_M, 1.0, 0.2, 20.0))
            ? bearingDegrees(prevLat, prevLon, location.getLatitude(), location.getLongitude())
            : (location.hasBearing() ? location.getBearing() : prevHeading);
        double currentHeading = location.hasBearing() ? location.getBearing() : moveHeading;
        double referenceHeading = Double.isNaN(prevHeading) ? moveHeading : prevHeading;
        double deadband = doublePref(prefs, KEY_HEADING_MAP_BEARING_DEADBAND_DEG, 6.0, 1.0, 10.0);
        boolean headingChanged = headingDelta(referenceHeading, currentHeading) >= Math.max(10.0, deadband * 1.6);
        double targetDistance = routeDistanceTargetMeters(location, prefs, headingChanged);
        boolean keepAlive = prevTime > 0 && currentTime - prevTime >= 5L * 60L * 1000L
            && distance >= Math.max(doublePref(prefs, KEY_MIN_MOVE_M, 1.0, 0.2, 20.0), targetDistance * 0.5);
        return new RouteDecision(distance >= targetDistance || keepAlive, false);
    }

    private void rememberRoutePoint(SharedPreferences prefs, Location location, JSONObject payload) {
        prefs.edit()
            .putLong(KEY_ROUTE_LAST_LAT, Double.doubleToLongBits(location.getLatitude()))
            .putLong(KEY_ROUTE_LAST_LON, Double.doubleToLongBits(location.getLongitude()))
            .putLong(KEY_ROUTE_LAST_TIME, location.getTime() > 0 ? location.getTime() : System.currentTimeMillis())
            .putLong(KEY_ROUTE_LAST_HEADING, Double.doubleToLongBits(location.hasBearing() ? location.getBearing() : Double.NaN))
            .putLong(KEY_ROUTE_LAST_SPEED, Double.doubleToLongBits(speedKmh(location)))
            .putBoolean(KEY_ROUTE_BREAK_PENDING, false)
            .apply();
    }

    private void publishLocation(Location location, SharedPreferences prefs, RouteDecision decision) {
        String deviceKey = prefs.getString(KEY_DEVICE_KEY, "");
        if (deviceKey.isEmpty()) return;
        try {
            JSONObject payload = trackPayloadJson(location, prefs, deviceKey, decision);
            rememberRoutePoint(prefs, location, payload);
            appendLocalRoutePoint(prefs, payload);
            enqueueMqttPayload(prefs, payload);
            if (!prefs.getBoolean(KEY_SERVER_UPLOAD, true)) return;
        } catch (Exception ignored) {}
    }

    private void publishLiveLocation(Location location, SharedPreferences prefs) {
        tickServerUpload(location, prefs);
    }

    private JSONObject trackPayloadJson(Location location, SharedPreferences prefs, String deviceKey, RouteDecision decision) throws Exception {
        JSONObject point = new JSONObject();
        point.put("lat", location.getLatitude());
        point.put("lon", location.getLongitude());
        point.put("timestamp", location.getTime() > 0 ? location.getTime() : System.currentTimeMillis());
        point.put("speed", location.hasSpeed()
            ? (location.getSpeed() <= 60f ? location.getSpeed() * 3.6 : location.getSpeed())
            : JSONObject.NULL);
        putHeadingFields(point, location, prefs);
        point.put("accuracy", location.hasAccuracy() ? location.getAccuracy() : JSONObject.NULL);
        point.put("source", "mobile_app");
        point.put("trackId", ensureTrackId(prefs, deviceKey));
        point.put("sequenceNumber", nextSequenceNumber(prefs));
        point.put("routePoint", true);
        point.put("final", true);
        point.put("liveSample", false);
        point.put("segmentId", prefs.getLong(KEY_ROUTE_SEGMENT_ID, 0L));
        if (decision != null && decision.breakBefore) point.put("breakBefore", true);
        return point;
    }

    private JSONObject livePayloadJson(Location location, String deviceKey, SharedPreferences prefs) throws Exception {
        long timestamp = location.getTime() > 0 ? location.getTime() : System.currentTimeMillis();
        JSONObject point = new JSONObject();
        point.put("lat", location.getLatitude());
        point.put("lon", location.getLongitude());
        point.put("timestamp", timestamp);
        point.put("speed", location.hasSpeed()
            ? (location.getSpeed() <= 60f ? location.getSpeed() * 3.6 : location.getSpeed())
            : JSONObject.NULL);
        putHeadingFields(point, location, prefs);
        point.put("accuracy", location.hasAccuracy() ? location.getAccuracy() : JSONObject.NULL);
        point.put("source", "mobile_app");
        point.put("trackId", JSONObject.NULL);
        point.put("sequenceNumber", timestamp);
        point.put("routePoint", false);
        point.put("final", false);
        point.put("liveSample", true);
        return point;
    }

    private String mqttTopic(SharedPreferences prefs, String deviceKey) {
        String prefix = prefs.getString(KEY_MQTT_TOPIC_PREFIX, "mobile_app");
        String[] parts = deviceKey.split("/", 2);
        String user = sanitizeTopicPart(parts.length > 0 ? parts[0] : "mobile", "mobile");
        String device = sanitizeTopicPart(parts.length > 1 ? parts[1] : "phone", "phone");
        return sanitizeTopicPart(prefix, "mobile_app") + "/" + user + "/" + device;
    }

    private static String sanitizeTopicPart(String value, String fallback) {
        String cleaned = value == null ? "" : value.trim().toLowerCase().replaceAll("[^a-z0-9._-]", "-");
        cleaned = cleaned.replaceAll("^-+|-+$", "");
        return cleaned.isEmpty() ? fallback : cleaned;
    }

    private String ensureTrackId(SharedPreferences prefs, String deviceKey) {
        String trackId = prefs.getString(KEY_TRACK_ID, "");
        if (trackId != null && !trackId.trim().isEmpty()) return trackId.trim();
        String created = deviceKey.replaceAll("[^a-zA-Z0-9._/-]", "-") + "-" + System.currentTimeMillis();
        prefs.edit().putString(KEY_TRACK_ID, created).putLong(KEY_SEQUENCE, 0L).apply();
        return created;
    }

    private long nextSequenceNumber(SharedPreferences prefs) {
        long next = prefs.getLong(KEY_SEQUENCE, 0L) + 1L;
        prefs.edit().putLong(KEY_SEQUENCE, next).apply();
        return next;
    }

    private JSONArray readMqttQueue(SharedPreferences prefs) {
        try {
            return new JSONArray(prefs.getString(KEY_QUEUE, "[]"));
        } catch (Exception error) {
            return new JSONArray();
        }
    }

    private void writeMqttQueue(SharedPreferences prefs, JSONArray queue) {
        JSONArray trimmed = new JSONArray();
        int start = Math.max(0, queue.length() - 500);
        for (int i = start; i < queue.length(); i += 1) {
            trimmed.put(queue.opt(i));
        }
        prefs.edit().putString(KEY_QUEUE, trimmed.toString()).apply();
    }

    private JSONArray readLocalRoute(SharedPreferences prefs) {
        try {
            return new JSONArray(prefs.getString(KEY_LOCAL_ROUTE, "[]"));
        } catch (Exception error) {
            return new JSONArray();
        }
    }

    private void writeLocalRoute(SharedPreferences prefs, JSONArray route) {
        JSONArray trimmed = new JSONArray();
        int start = Math.max(0, route.length() - 2000);
        for (int i = start; i < route.length(); i += 1) {
            trimmed.put(route.opt(i));
        }
        prefs.edit().putString(KEY_LOCAL_ROUTE, trimmed.toString()).apply();
    }

    private boolean sameRoutePoint(JSONObject a, JSONObject b) {
        if (a == null || b == null) return false;
        String trackId = a.optString("trackId", "");
        long sequence = a.optLong("sequenceNumber", Long.MIN_VALUE);
        if (!trackId.isEmpty() && trackId.equals(b.optString("trackId", ""))
            && sequence != Long.MIN_VALUE && sequence == b.optLong("sequenceNumber", Long.MIN_VALUE)) {
            return true;
        }
        return a.optLong("timestamp", Long.MIN_VALUE) == b.optLong("timestamp", Long.MIN_VALUE)
            && Double.compare(a.optDouble("lat", Double.NaN), b.optDouble("lat", Double.NaN)) == 0
            && Double.compare(a.optDouble("lon", Double.NaN), b.optDouble("lon", Double.NaN)) == 0;
    }

    private void appendLocalRoutePoint(SharedPreferences prefs, JSONObject payload) {
        if (payload == null || !payload.optBoolean("routePoint", false) || !payload.optBoolean("final", false)) return;
        JSONArray route = readLocalRoute(prefs);
        JSONObject last = route.length() > 0 ? route.optJSONObject(route.length() - 1) : null;
        if (sameRoutePoint(last, payload)) return;
        route.put(payload);
        writeLocalRoute(prefs, route);
    }

    private void enqueueMqttPayload(SharedPreferences prefs, JSONObject payload) {
        if (payload == null || !payload.optBoolean("routePoint", false) || !payload.optBoolean("final", false)) return;
        JSONArray queue = readMqttQueue(prefs);
        String trackId = payload.optString("trackId", "");
        long sequence = payload.optLong("sequenceNumber", Long.MIN_VALUE);
        long timestamp = payload.optLong("timestamp", Long.MIN_VALUE);
        double lat = payload.optDouble("lat", Double.NaN);
        double lon = payload.optDouble("lon", Double.NaN);
        for (int i = 0; i < queue.length(); i += 1) {
            JSONObject queued = queue.optJSONObject(i);
            if (queued == null) continue;
            boolean sameSequence = !trackId.isEmpty() && trackId.equals(queued.optString("trackId", ""))
                && sequence != Long.MIN_VALUE && sequence == queued.optLong("sequenceNumber", Long.MIN_VALUE);
            boolean samePoint = timestamp != Long.MIN_VALUE && timestamp == queued.optLong("timestamp", Long.MIN_VALUE)
                && Double.compare(lat, queued.optDouble("lat", Double.NaN)) == 0
                && Double.compare(lon, queued.optDouble("lon", Double.NaN)) == 0;
            if (sameSequence || samePoint) return;
        }
        queue.put(payload);
        writeMqttQueue(prefs, queue);
    }

    private void flushQueuedPoints(SharedPreferences prefs, String topic) {
        JSONArray queue = readMqttQueue(prefs);
        if (queue.length() == 0) return;
        JSONArray remaining = new JSONArray();
        boolean failed = false;
        for (int i = 0; i < queue.length(); i += 1) {
            JSONObject payload = queue.optJSONObject(i);
            if (payload == null) continue;
            if (!failed && publishMqtt(prefs, topic, payload.toString(), payload.optLong("sequenceNumber", i + 1L))) {
                continue;
            }
            failed = true;
            remaining.put(payload);
        }
        writeMqttQueue(prefs, remaining);
    }

    private boolean publishMqtt(SharedPreferences prefs, String topic, String body, long sequenceNumber) {
        String host = mqttHost(prefs);
        int port = (int) doublePref(prefs, KEY_MQTT_PORT, 1883.0, 1.0, 65535.0);
        if (host.isEmpty() || topic.isEmpty()) return false;
        try (Socket socket = new Socket()) {
            socket.connect(new InetSocketAddress(host, port), 8000);
            socket.setSoTimeout(8000);
            OutputStream output = socket.getOutputStream();
            DataInputStream input = new DataInputStream(socket.getInputStream());
            output.write(connectPacket(prefs));
            output.flush();
            if (!readConnack(input)) return false;
            int packetId = (int) (Math.abs(sequenceNumber) % 65535L);
            if (packetId == 0) packetId = 1;
            output.write(publishPacket(topic, body, packetId));
            output.flush();
            if (!readPuback(input, packetId)) return false;
            output.write(new byte[] { (byte) 0xE0, 0x00 });
            output.flush();
            return true;
        } catch (Exception error) {
            return false;
        }
    }

    private String mqttHost(SharedPreferences prefs) {
        String host = prefs.getString(KEY_MQTT_HOST, "");
        if (host != null && !host.trim().isEmpty()) return host.trim();
        try {
            URI uri = new URI(prefs.getString(KEY_SERVER_URL, ""));
            return uri.getHost() != null ? uri.getHost() : "";
        } catch (Exception error) {
            return "";
        }
    }

    private byte[] connectPacket(SharedPreferences prefs) throws IOException {
        String deviceKey = prefs.getString(KEY_DEVICE_KEY, "mobile/phone");
        String clientId = "mobile_app_" + sanitizeTopicPart(deviceKey, "phone") + "_" + System.currentTimeMillis();
        ByteArrayOutputStream variable = new ByteArrayOutputStream();
        writeUtf(variable, "MQTT");
        variable.write(4);
        variable.write(2);
        variable.write(0);
        variable.write(60);
        writeUtf(variable, clientId);
        return fixedHeaderPacket(0x10, variable.toByteArray());
    }

    private byte[] publishPacket(String topic, String body, int packetId) throws IOException {
        ByteArrayOutputStream variable = new ByteArrayOutputStream();
        writeUtf(variable, topic);
        variable.write((packetId >> 8) & 0xFF);
        variable.write(packetId & 0xFF);
        variable.write(body.getBytes(StandardCharsets.UTF_8));
        return fixedHeaderPacket(0x32, variable.toByteArray());
    }

    private static byte[] fixedHeaderPacket(int header, byte[] payload) throws IOException {
        ByteArrayOutputStream packet = new ByteArrayOutputStream();
        packet.write(header);
        writeRemainingLength(packet, payload.length);
        packet.write(payload);
        return packet.toByteArray();
    }

    private static void writeUtf(ByteArrayOutputStream out, String value) throws IOException {
        byte[] bytes = String.valueOf(value).getBytes(StandardCharsets.UTF_8);
        out.write((bytes.length >> 8) & 0xFF);
        out.write(bytes.length & 0xFF);
        out.write(bytes);
    }

    private static void writeRemainingLength(ByteArrayOutputStream out, int length) {
        int value = length;
        do {
            int encodedByte = value % 128;
            value = value / 128;
            if (value > 0) encodedByte = encodedByte | 128;
            out.write(encodedByte);
        } while (value > 0);
    }

    private static int readRemainingLength(DataInputStream input) throws IOException {
        int multiplier = 1;
        int value = 0;
        int encodedByte;
        do {
            encodedByte = input.readUnsignedByte();
            value += (encodedByte & 127) * multiplier;
            multiplier *= 128;
            if (multiplier > 128 * 128 * 128) throw new IOException("Invalid MQTT remaining length");
        } while ((encodedByte & 128) != 0);
        return value;
    }

    private static boolean readConnack(DataInputStream input) throws IOException {
        if (input.readUnsignedByte() != 0x20) return false;
        int remaining = readRemainingLength(input);
        if (remaining < 2) return false;
        int flags = input.readUnsignedByte();
        int code = input.readUnsignedByte();
        for (int i = 2; i < remaining; i += 1) input.readUnsignedByte();
        return flags == 0 && code == 0;
    }

    private static boolean readPuback(DataInputStream input, int packetId) throws IOException {
        if (input.readUnsignedByte() != 0x40) return false;
        int remaining = readRemainingLength(input);
        if (remaining < 2) return false;
        int ackId = (input.readUnsignedByte() << 8) | input.readUnsignedByte();
        for (int i = 2; i < remaining; i += 1) input.readUnsignedByte();
        return ackId == packetId;
    }
}
