package io.github.bucifer6.opendj;

import android.content.Intent;
import androidx.core.content.ContextCompat;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Keeps OpenDJ playing with the screen off: the web app calls start() when a deck starts playing (or a recording
 * starts) and stop() when everything is idle (public/js/local/mobile-runtime.js). start() runs PlaybackService, a
 * foreground service of type mediaPlayback, so Android does not suspend or kill the app's process meanwhile.
 */
@CapacitorPlugin(name = "OpenDJAudio")
public class OpenDJAudioPlugin extends Plugin {
    @PluginMethod
    public void start(PluginCall call) {
        try {
            Intent i = new Intent(getContext(), PlaybackService.class);
            i.putExtra(PlaybackService.EXTRA_TITLE, call.getString("title", "OpenDJ is playing"));
            ContextCompat.startForegroundService(getContext(), i);
            call.resolve();
        } catch (Exception e) {
            // e.g. ForegroundServiceStartNotAllowedException when called from the background
            call.reject("Could not start background playback: " + e.getMessage());
        }
    }

    @PluginMethod
    public void stop(PluginCall call) {
        getContext().stopService(new Intent(getContext(), PlaybackService.class));
        call.resolve();
    }
}
