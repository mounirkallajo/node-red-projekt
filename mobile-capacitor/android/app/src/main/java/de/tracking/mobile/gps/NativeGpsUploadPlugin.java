package de.tracking.mobile.gps;

import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Build;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "NativeGpsUpload")
public class NativeGpsUploadPlugin extends Plugin {

    private void saveConfig(PluginCall call, boolean enabled) {
        String serverUrl = call.getString("serverUrl", "");
        String deviceKey = call.getString("deviceKey", "");
        boolean tracking = call.getBoolean("tracking", false);
        String mqttHost = call.getString("mqttHost", "");
        int mqttPort = call.getInt("mqttPort", 1883);
        String mqttTopicPrefix = call.getString("mqttTopicPrefix", "mobile_app");
        String trackId = call.getString("trackId", "");
        Double sequenceNumber = call.getDouble("sequenceNumber", -1.0);
        Double segmentId = call.getDouble("segmentId", 0.0);
        boolean breakBefore = call.getBoolean("breakBefore", false);
        double idleSec = call.getDouble("idleSec", 2.0);
        double movingSec = call.getDouble("movingSec", 0.5);
        double intervalMin = call.getDouble("intervalMin", 0.0);
        boolean serverUploadEnabled = call.getBoolean("serverUploadEnabled", true);
        boolean serverLiveHeadingEnabled = call.getBoolean("serverLiveHeadingEnabled", false);

        SharedPreferences prefs = getContext().getSharedPreferences(
            NativeGpsUploadService.PREFS_NAME,
            Context.MODE_PRIVATE
        );
        boolean wasTracking = prefs.getBoolean(NativeGpsUploadService.KEY_TRACKING, false);
        if (tracking) {
            serverLiveHeadingEnabled = false;
        }
        long currentSequenceNumber = prefs.getLong(NativeGpsUploadService.KEY_SEQUENCE, 0L);
        String currentTrackId = prefs.getString(NativeGpsUploadService.KEY_TRACK_ID, "");
        boolean trackChanged = trackId != null && !trackId.trim().isEmpty() && !trackId.equals(currentTrackId);
        long incomingSequenceNumber = sequenceNumber != null && sequenceNumber >= 0 ? sequenceNumber.longValue() : currentSequenceNumber;
        long nextSequenceNumber = trackChanged ? incomingSequenceNumber : Math.max(currentSequenceNumber, incomingSequenceNumber);
        prefs.edit()
            .putBoolean(NativeGpsUploadService.KEY_ENABLED, enabled)
            .putBoolean(NativeGpsUploadService.KEY_PAUSED, false)
            .putString(NativeGpsUploadService.KEY_SERVER_URL, serverUrl)
            .putString(NativeGpsUploadService.KEY_DEVICE_KEY, deviceKey)
            .putBoolean(NativeGpsUploadService.KEY_TRACKING, tracking)
            .putString(NativeGpsUploadService.KEY_MQTT_HOST, mqttHost)
            .putInt(NativeGpsUploadService.KEY_MQTT_PORT, Math.max(1, mqttPort))
            .putString(NativeGpsUploadService.KEY_MQTT_TOPIC_PREFIX, mqttTopicPrefix)
            .putString(NativeGpsUploadService.KEY_TRACK_ID, trackId)
            .putLong(NativeGpsUploadService.KEY_SEQUENCE, nextSequenceNumber)
            .putLong(NativeGpsUploadService.KEY_ROUTE_SEGMENT_ID, segmentId != null ? Math.max(0L, segmentId.longValue()) : 0L)
            .putBoolean(NativeGpsUploadService.KEY_ROUTE_BREAK_PENDING, breakBefore)
            .putFloat(NativeGpsUploadService.KEY_IDLE_SEC, (float) Math.max(1.0, idleSec))
            .putFloat(NativeGpsUploadService.KEY_MOVING_SEC, (float) Math.max(0.2, movingSec))
            .putFloat(NativeGpsUploadService.KEY_INTERVAL_MIN, (float) Math.max(0.0, intervalMin))
            .putFloat(NativeGpsUploadService.KEY_MIN_MOVE_M, call.getDouble("minMoveM", 1.0).floatValue())
            .putFloat(NativeGpsUploadService.KEY_MAX_ACCURACY_M, call.getDouble("maxAccuracyM", 20.0).floatValue())
            .putFloat(NativeGpsUploadService.KEY_WALKING_SPEED_KMH, call.getDouble("walkingSpeedKmh", 1.6).floatValue())
            .putFloat(NativeGpsUploadService.KEY_MOVING_SPEED_KMH, call.getDouble("movingSpeedKmh", 3.0).floatValue())
            .putFloat(NativeGpsUploadService.KEY_STATIONARY_RADIUS_M, call.getDouble("stationaryRadiusM", 18.0).floatValue())
            .putFloat(NativeGpsUploadService.KEY_STATIONARY_MAX_RADIUS_M, call.getDouble("stationaryMaxRadiusM", 80.0).floatValue())
            .putFloat(NativeGpsUploadService.KEY_CONFIRM_POINTS, call.getDouble("confirmPoints", 3.0).floatValue())
            .putFloat(NativeGpsUploadService.KEY_SPEED_JUMP_KMH, call.getDouble("speedJumpKmh", 8.0).floatValue())
            .putFloat(NativeGpsUploadService.KEY_HEADING_MAP_BEARING_DEADBAND_DEG, call.getDouble("headingMapBearingDeadbandDeg", 6.0).floatValue())
            .putFloat(NativeGpsUploadService.KEY_DRIVE_ENTER_SPEED_KMH, call.getDouble("driveEnterSpeedKmh", 10.0).floatValue())
            .putFloat(NativeGpsUploadService.KEY_DRIVE_EXIT_SPEED_KMH, call.getDouble("driveExitSpeedKmh", 6.0).floatValue())
            .putFloat(NativeGpsUploadService.KEY_DRIVE_CONFIRM_FIXES, call.getDouble("driveConfirmFixes", 3.0).floatValue())
            .putFloat(NativeGpsUploadService.KEY_DRIVE_EXIT_HOLD_MS, call.getDouble("driveExitHoldMs", 4000.0).floatValue())
            .putFloat(NativeGpsUploadService.KEY_DRIVE_MIN_MOVE_M, call.getDouble("driveMinMoveM", 1.0).floatValue())
            .putBoolean(NativeGpsUploadService.KEY_SERVER_UPLOAD, serverUploadEnabled)
            .putBoolean(NativeGpsUploadService.KEY_SERVER_LIVE_HEADING, serverLiveHeadingEnabled)
            .apply();
        if (wasTracking && !tracking) {
            Intent flushIntent = new Intent(getContext(), NativeGpsUploadService.class);
            flushIntent.setAction(NativeGpsUploadService.ACTION_FLUSH_UPLOAD_QUEUE);
            try {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    getContext().startForegroundService(flushIntent);
                } else {
                    getContext().startService(flushIntent);
                }
            } catch (Exception ignored) {}
        }
    }

    private void startServiceIfEnabled() {
        SharedPreferences prefs = getContext().getSharedPreferences(
            NativeGpsUploadService.PREFS_NAME,
            Context.MODE_PRIVATE
        );
        boolean shouldRun = prefs.getBoolean(NativeGpsUploadService.KEY_ENABLED, false) &&
            (prefs.getBoolean(NativeGpsUploadService.KEY_TRACKING, false) ||
             prefs.getBoolean(NativeGpsUploadService.KEY_SERVER_UPLOAD, false));
        if (!shouldRun) return;
        Intent intent = new Intent(getContext(), NativeGpsUploadService.class);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            getContext().startForegroundService(intent);
        } else {
            getContext().startService(intent);
        }
    }

    @PluginMethod
    public void start(PluginCall call) {
        saveConfig(call, true);
        startServiceIfEnabled();
        call.resolve();
    }

    @PluginMethod
    public void updateConfig(PluginCall call) {
        saveConfig(call, true);
        startServiceIfEnabled();
        call.resolve();
    }

    @PluginMethod
    public void setPaused(PluginCall call) {
        SharedPreferences prefs = getContext().getSharedPreferences(
            NativeGpsUploadService.PREFS_NAME,
            Context.MODE_PRIVATE
        );
        if (!prefs.getBoolean(NativeGpsUploadService.KEY_ENABLED, false)) {
            call.resolve();
            return;
        }
        prefs.edit()
            .putBoolean(NativeGpsUploadService.KEY_PAUSED, false)
            .apply();
        call.resolve();
    }

    @PluginMethod
    public void stop(PluginCall call) {
        SharedPreferences prefs = getContext().getSharedPreferences(
            NativeGpsUploadService.PREFS_NAME,
            Context.MODE_PRIVATE
        );
        prefs.edit()
            .putBoolean(NativeGpsUploadService.KEY_ENABLED, false)
            .putBoolean(NativeGpsUploadService.KEY_TRACKING, false)
            .putBoolean(NativeGpsUploadService.KEY_SERVER_UPLOAD, false)
            .apply();
        getContext().stopService(new Intent(getContext(), NativeGpsUploadService.class));
        call.resolve();
    }

    @PluginMethod
    public void resetRouteState(PluginCall call) {
        SharedPreferences prefs = getContext().getSharedPreferences(
            NativeGpsUploadService.PREFS_NAME,
            Context.MODE_PRIVATE
        );
        long nextSegmentId = prefs.getLong(NativeGpsUploadService.KEY_ROUTE_SEGMENT_ID, 0L) + 1L;
        prefs.edit()
            .putBoolean(NativeGpsUploadService.KEY_TRACKING, false)
            .remove(NativeGpsUploadService.KEY_TRACK_ID)
            .putLong(NativeGpsUploadService.KEY_SEQUENCE, 0L)
            .putLong(NativeGpsUploadService.KEY_ROUTE_SEGMENT_ID, Math.max(0L, nextSegmentId))
            .putBoolean(NativeGpsUploadService.KEY_ROUTE_BREAK_PENDING, true)
            .remove(NativeGpsUploadService.KEY_ROUTE_LAST_LAT)
            .remove(NativeGpsUploadService.KEY_ROUTE_LAST_LON)
            .remove(NativeGpsUploadService.KEY_ROUTE_LAST_TIME)
            .remove(NativeGpsUploadService.KEY_ROUTE_LAST_HEADING)
            .remove(NativeGpsUploadService.KEY_ROUTE_LAST_SPEED)
            .remove(NativeGpsUploadService.KEY_QUEUE)
            .remove(NativeGpsUploadService.KEY_LOCAL_ROUTE)
            .apply();
        call.resolve();
    }

    @PluginMethod
    public void getBufferedRoute(PluginCall call) {
        SharedPreferences prefs = getContext().getSharedPreferences(
            NativeGpsUploadService.PREFS_NAME,
            Context.MODE_PRIVATE
        );
        String routeJson = prefs.getString(NativeGpsUploadService.KEY_LOCAL_ROUTE, "[]");
        String queueJson = prefs.getString(NativeGpsUploadService.KEY_QUEUE, "[]");
        JSObject result = new JSObject();
        result.put("localRouteJson", routeJson);
        result.put("queueJson", queueJson);
        result.put("tracking", prefs.getBoolean(NativeGpsUploadService.KEY_TRACKING, false));
        result.put("deviceKey", prefs.getString(NativeGpsUploadService.KEY_DEVICE_KEY, ""));
        call.resolve(result);
    }

    @PluginMethod
    public void getStatus(PluginCall call) {
        SharedPreferences prefs = getContext().getSharedPreferences(
            NativeGpsUploadService.PREFS_NAME,
            Context.MODE_PRIVATE
        );
        JSObject result = new JSObject();
        result.put("enabled", prefs.getBoolean(NativeGpsUploadService.KEY_ENABLED, false));
        result.put("deviceKey", prefs.getString(NativeGpsUploadService.KEY_DEVICE_KEY, ""));
        result.put("tracking", prefs.getBoolean(NativeGpsUploadService.KEY_TRACKING, false));
        call.resolve(result);
    }
}
