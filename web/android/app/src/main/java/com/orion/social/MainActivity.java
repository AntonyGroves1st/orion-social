package com.orion.social;

import android.os.Bundle;
import android.view.WindowManager;
import android.webkit.WebView;

import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeActivity;

/**
 * Live rooms: keep WebView timers / WebRTC warm when the user taps Home briefly,
 * so returning does not tear down the mesh for every peer.
 */
public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(OrionAudioPlugin.class);
        super.onCreate(savedInstanceState);
    }

    @Override
    public void onPause() {
        super.onPause();
        if (OrionAudioPlugin.isKeepLiveSession()) {
            resumeWebViewForLive();
            try {
                getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            } catch (Exception ignored) {
                /* ignore */
            }
        }
    }

    @Override
    public void onResume() {
        super.onResume();
        if (OrionAudioPlugin.isKeepLiveSession()) {
            resumeWebViewForLive();
            try {
                getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            } catch (Exception ignored) {
                /* ignore */
            }
        }
    }

    private void resumeWebViewForLive() {
        try {
            Bridge bridge = getBridge();
            if (bridge == null) return;
            WebView webView = bridge.getWebView();
            if (webView == null) return;
            webView.onResume();
            webView.resumeTimers();
        } catch (Exception ignored) {
            /* ignore */
        }
    }
}
