package de.tracking.mobile;

import android.content.Intent;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.webkit.WebSettings;
import androidx.core.view.WindowCompat;
import com.getcapacitor.BridgeActivity;
import de.tracking.mobile.gps.NativeGpsUploadPlugin;
import de.tracking.mobile.offlinemap.OfflineMapDownloadPlugin;
import de.tracking.mobile.offlinemap.OfflineMapWebViewClient;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(NativeGpsUploadPlugin.class);
        registerPlugin(OfflineMapDownloadPlugin.class);
        super.onCreate(savedInstanceState);
        WindowCompat.setDecorFitsSystemWindows(getWindow(), false);
        if (getBridge() != null && getBridge().getWebView() != null) {
            try {
                getBridge().getWebView().getSettings().setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
                getBridge().getWebView().setWebViewClient(new OfflineMapWebViewClient(getBridge()));
            } catch (Exception ignored) {}
        }
        handleSheetIntent(getIntent(), 350L);
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        handleSheetIntent(intent, 50L);
    }

    private void handleSheetIntent(Intent intent, long delayMs) {
        if (intent == null) return;
        if (intent.getBooleanExtra("openOfflineSheet", false)) {
            new Handler(Looper.getMainLooper()).postDelayed(new Runnable() {
                @Override
                public void run() {
                    OfflineMapDownloadPlugin.notifyOpenSheetFromIntent();
                }
            }, delayMs);
        }
    }
}
