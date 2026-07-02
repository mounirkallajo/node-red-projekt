package de.tracking.mobile.offlinemap;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

public class OfflineMapCancelReceiver extends BroadcastReceiver {

    public static final String ACTION_CANCEL = "de.tracking.mobile.offlinemap.CANCEL";

    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent == null || !ACTION_CANCEL.equals(intent.getAction())) return;
        OfflineMapDownloadPlugin.notifyCancelFromNotification();
    }
}
