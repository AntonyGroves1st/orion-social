package com.orion.social;

import android.content.Context;
import android.media.AudioAttributes;
import android.media.AudioDeviceInfo;
import android.media.AudioFocusRequest;
import android.media.AudioManager;
import android.os.Build;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Routes WebRTC / live-room playback to the loudspeaker.
 * Chromium WebView defaults to MODE_IN_COMMUNICATION + earpiece (quiet "in-call" path).
 */
@CapacitorPlugin(name = "OrionAudio")
public class OrionAudioPlugin extends Plugin {
    private AudioFocusRequest focusRequest;
    private boolean liveAudioActive = false;
    /** When true, MainActivity keeps WebView timers running through Home. */
    private static volatile boolean keepLiveSession = false;

    public static boolean isKeepLiveSession() {
        return keepLiveSession;
    }

    @PluginMethod
    public void enableLiveSpeaker(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            try {
                applyLiveSpeaker(true);
                JSObject result = new JSObject();
                result.put("speaker", true);
                result.put("mode", "in_communication");
                call.resolve(result);
            } catch (Exception e) {
                call.reject("enableLiveSpeaker failed: " + e.getMessage(), e);
            }
        });
    }

    @PluginMethod
    public void restoreAudio(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            try {
                applyLiveSpeaker(false);
                call.resolve();
            } catch (Exception e) {
                call.reject("restoreAudio failed: " + e.getMessage(), e);
            }
        });
    }

    /**
     * Keep WebView + screen alive for an active live room (Home must not remount the stage).
     */
    @PluginMethod
    public void setKeepLiveSession(PluginCall call) {
        final boolean enable = Boolean.TRUE.equals(call.getBoolean("enable", false));
        keepLiveSession = enable;
        getActivity().runOnUiThread(() -> {
            try {
                android.view.Window w = getActivity().getWindow();
                if (w != null) {
                    if (enable) {
                        w.addFlags(android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                    } else {
                        w.clearFlags(android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                    }
                }
                call.resolve();
            } catch (Exception e) {
                call.reject("setKeepLiveSession failed: " + e.getMessage(), e);
            }
        });
    }

    @Override
    protected void handleOnResume() {
        super.handleOnResume();
        if (liveAudioActive) {
            try {
                applyLiveSpeaker(true);
            } catch (Exception ignored) {
                /* best-effort re-apply after Android steals the route */
            }
        }
    }

    @Override
    protected void handleOnDestroy() {
        keepLiveSession = false;
        try {
            applyLiveSpeaker(false);
        } catch (Exception ignored) {
            /* ignore */
        }
        super.handleOnDestroy();
    }

    private void applyLiveSpeaker(boolean enable) {
        Context ctx = getContext();
        if (ctx == null) return;

        AudioManager am = (AudioManager) ctx.getSystemService(Context.AUDIO_SERVICE);
        if (am == null) return;

        if (enable) {
            liveAudioActive = true;
            requestFocus(am);
            am.setMode(AudioManager.MODE_IN_COMMUNICATION);
            routeToBuiltinSpeaker(am);
            // Keep legacy path for OEMs that still honor it under WebRTC.
            try {
                am.setSpeakerphoneOn(true);
            } catch (Exception ignored) {
                /* ignore */
            }
        } else {
            liveAudioActive = false;
            try {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                    am.clearCommunicationDevice();
                }
            } catch (Exception ignored) {
                /* ignore */
            }
            try {
                am.setSpeakerphoneOn(false);
            } catch (Exception ignored) {
                /* ignore */
            }
            am.setMode(AudioManager.MODE_NORMAL);
            abandonFocus(am);
        }
    }

    private void routeToBuiltinSpeaker(AudioManager am) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return;
        try {
            for (AudioDeviceInfo device : am.getAvailableCommunicationDevices()) {
                int type = device.getType();
                if (type == AudioDeviceInfo.TYPE_BUILTIN_SPEAKER
                        || type == AudioDeviceInfo.TYPE_BUILTIN_SPEAKER_SAFE) {
                    am.setCommunicationDevice(device);
                    return;
                }
            }
        } catch (Exception ignored) {
            /* fall through to setSpeakerphoneOn */
        }
    }

    private void requestFocus(AudioManager am) {
        AudioAttributes attrs = new AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
                .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                .build();

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            if (focusRequest == null) {
                focusRequest = new AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN)
                        .setAudioAttributes(attrs)
                        .setAcceptsDelayedFocusGain(true)
                        .setOnAudioFocusChangeListener(focusChange -> {
                            if (focusChange == AudioManager.AUDIOFOCUS_GAIN && liveAudioActive) {
                                try {
                                    applyLiveSpeaker(true);
                                } catch (Exception ignored) {
                                    /* ignore */
                                }
                            }
                        })
                        .build();
            }
            am.requestAudioFocus(focusRequest);
        } else {
            am.requestAudioFocus(
                    null,
                    AudioManager.STREAM_VOICE_CALL,
                    AudioManager.AUDIOFOCUS_GAIN
            );
        }
    }

    private void abandonFocus(AudioManager am) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            if (focusRequest != null) {
                am.abandonAudioFocusRequest(focusRequest);
            }
        } else {
            am.abandonAudioFocus(null);
        }
    }
}
