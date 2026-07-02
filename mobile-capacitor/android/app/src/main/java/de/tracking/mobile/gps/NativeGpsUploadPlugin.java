package de.tracking.mobile.gps;

import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.content.IntentSender;
import android.content.SharedPreferences;
import android.content.res.AssetFileDescriptor;
import android.media.AudioAttributes;
import android.media.MediaPlayer;
import android.os.Build;
import android.provider.Settings;
import android.util.Log;
import android.view.HapticFeedbackConstants;
import android.view.View;

import com.google.android.gms.common.api.ResolvableApiException;
import com.google.android.gms.location.LocationRequest;
import com.google.android.gms.location.LocationServices;
import com.google.android.gms.location.LocationSettingsRequest;
import com.google.android.gms.location.Priority;
import com.google.android.gms.location.SettingsClient;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.util.Collections;
import java.util.HashSet;
import java.util.Set;

import de.tracking.mobile.R;

@CapacitorPlugin(name = "NativeGpsUpload")
public class NativeGpsUploadPlugin extends Plugin {
    private static final String TAG = "NativeGpsUpload";
    private static final int REQUEST_LOCATION_SETTINGS_RESOLUTION = 1401;
    private final Set<MediaPlayer> serverUploadFeedbackPlayers = Collections.synchronizedSet(new HashSet<MediaPlayer>());

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

        SharedPreferences prefs = getContext().getSharedPreferences(
            NativeGpsUploadService.PREFS_NAME,
            Context.MODE_PRIVATE
        );
        boolean wasTracking = prefs.getBoolean(NativeGpsUploadService.KEY_TRACKING, false);
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
    public void setCompassHeading(PluginCall call) {
        Object headingRaw = call.getData() != null ? call.getData().opt("headingDeg") : null;
        Object timestampRaw = call.getData() != null ? call.getData().opt("timestampMs") : null;
        Double headingDeg = finiteNumber(headingRaw);
        Double timestampMs = finiteNumber(timestampRaw);
        if (headingDeg == null || headingDeg < 0.0 || headingDeg > 360.0) {
            rejectCompassHeading(call, "invalid_heading", headingRaw, timestampRaw);
            return;
        }
        if (timestampMs == null || timestampMs <= 0.0) {
            rejectCompassHeading(call, "invalid_timestamp", headingRaw, timestampRaw);
            return;
        }
        double normalizedHeading = headingDeg == 360.0 ? 0.0 : headingDeg;
        long timestampLong = Math.round(timestampMs);
        if (timestampLong <= 0L) {
            rejectCompassHeading(call, "invalid_timestamp", headingRaw, timestampRaw);
            return;
        }
        SharedPreferences prefs = getContext().getSharedPreferences(
            NativeGpsUploadService.PREFS_NAME,
            Context.MODE_PRIVATE
        );
        prefs.edit()
            .putFloat(NativeGpsUploadService.KEY_COMPASS_HEADING, (float) normalizedHeading)
            .putLong(NativeGpsUploadService.KEY_COMPASS_HEADING_AT_MS, timestampLong)
            .apply();
        Log.i(TAG, "NativeGpsUpload compassHeading saved source=method heading=" + normalizedHeading + " timestampMs=" + timestampLong);
        call.resolve();
    }

    private static Double finiteNumber(Object raw) {
        if (!(raw instanceof Number)) return null;
        double value = ((Number) raw).doubleValue();
        return Double.isNaN(value) || Double.isInfinite(value) ? null : value;
    }

    private void rejectCompassHeading(PluginCall call, String reason, Object headingRaw, Object timestampRaw) {
        Log.w(TAG, "NativeGpsUpload compassHeading rejected source=method reason=" + reason +
            " headingRaw=" + String.valueOf(headingRaw) +
            " timestampRaw=" + String.valueOf(timestampRaw));
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
    public void playServerUploadToggleFeedback(PluginCall call) {
        boolean enabled = call.getBoolean("enabled", false);
        boolean hapticOk = performServerUploadToggleHaptic();
        boolean soundOk = playServerUploadToggleSound(enabled);
        JSObject result = new JSObject();
        result.put("ok", hapticOk || soundOk);
        result.put("haptic", hapticOk);
        result.put("sound", soundOk);
        result.put("enabled", enabled);
        call.resolve(result);
    }

    private boolean performServerUploadToggleHaptic() {
        Activity activity = getActivity();
        if (activity == null) return false;
        try {
            activity.runOnUiThread(() -> {
                try {
                    View decorView = activity.getWindow() != null ? activity.getWindow().getDecorView() : null;
                    if (decorView != null) {
                        decorView.performHapticFeedback(HapticFeedbackConstants.VIRTUAL_KEY);
                    }
                } catch (Exception ignored) {}
            });
            return true;
        } catch (Exception ignored) {
            return false;
        }
    }

    private boolean playServerUploadToggleSound(boolean enabled) {
        int resId = enabled ? R.raw.server_online : R.raw.server_offline;
        AssetFileDescriptor descriptor = null;
        MediaPlayer player = null;
        try {
            descriptor = getContext().getResources().openRawResourceFd(resId);
            if (descriptor == null) return false;
            player = new MediaPlayer();
            player.setAudioAttributes(new AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_ALARM)
                .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                .build());
            player.setDataSource(
                descriptor.getFileDescriptor(),
                descriptor.getStartOffset(),
                descriptor.getLength()
            );
            player.setVolume(0.45f, 0.45f);
            final MediaPlayer activePlayer = player;
            player.setOnCompletionListener(this::releaseServerUploadFeedbackPlayer);
            player.setOnErrorListener((mp, what, extra) -> {
                releaseServerUploadFeedbackPlayer(mp);
                return true;
            });
            player.prepare();
            serverUploadFeedbackPlayers.add(activePlayer);
            player.start();
            return true;
        } catch (Exception ignored) {
            if (player != null) releaseServerUploadFeedbackPlayer(player);
            return false;
        } finally {
            if (descriptor != null) {
                try { descriptor.close(); } catch (Exception ignored) {}
            }
        }
    }

    private void releaseServerUploadFeedbackPlayer(MediaPlayer player) {
        if (player == null) return;
        try { serverUploadFeedbackPlayers.remove(player); } catch (Exception ignored) {}
        try { player.release(); } catch (Exception ignored) {}
    }

    private void openLocationSettingsFallback(PluginCall call, boolean fallback, String reason) {
        try {
            Intent intent = new Intent(Settings.ACTION_LOCATION_SOURCE_SETTINGS);
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(intent);
            JSObject result = new JSObject();
            result.put("opened", true);
            result.put("fallback", fallback);
            result.put("reason", reason);
            call.resolve(result);
        } catch (Exception error) {
            call.reject("open_location_settings_failed", error);
        }
    }

    @PluginMethod
    public void openLocationSettings(PluginCall call) {
        openLocationSettingsFallback(call, false, "direct");
    }

    @PluginMethod
    public void requestLocationSettingsResolution(PluginCall call) {
        Activity activity = getActivity();
        if (activity == null) {
            openLocationSettingsFallback(call, true, "no_activity");
            return;
        }
        try {
            LocationRequest request = new LocationRequest.Builder(Priority.PRIORITY_HIGH_ACCURACY, 10000L)
                .setMinUpdateIntervalMillis(5000L)
                .build();
            LocationSettingsRequest settingsRequest = new LocationSettingsRequest.Builder()
                .addLocationRequest(request)
                .setAlwaysShow(true)
                .build();
            SettingsClient client = LocationServices.getSettingsClient(activity);
            client.checkLocationSettings(settingsRequest)
                .addOnSuccessListener(activity, response -> {
                    JSObject result = new JSObject();
                    result.put("satisfied", true);
                    result.put("resolutionDialog", false);
                    result.put("fallback", false);
                    call.resolve(result);
                })
                .addOnFailureListener(activity, error -> {
                    if (error instanceof ResolvableApiException) {
                        try {
                            ((ResolvableApiException) error).startResolutionForResult(activity, REQUEST_LOCATION_SETTINGS_RESOLUTION);
                            JSObject result = new JSObject();
                            result.put("satisfied", false);
                            result.put("resolutionDialog", true);
                            result.put("fallback", false);
                            call.resolve(result);
                        } catch (IntentSender.SendIntentException startError) {
                            openLocationSettingsFallback(call, true, "resolution_start_failed");
                        }
                    } else {
                        openLocationSettingsFallback(call, true, "resolution_unavailable");
                    }
                });
        } catch (Exception error) {
            openLocationSettingsFallback(call, true, "resolution_failed");
        }
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
