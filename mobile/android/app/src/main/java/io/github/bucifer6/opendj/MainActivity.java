package io.github.bucifer6.opendj;

import android.content.Intent;
import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // app-local plugins must be registered before the bridge starts
        registerPlugin(OpenDJAudioPlugin.class);
        super.onCreate(savedInstanceState);
    }

    @Override
    public void onDestroy() {
        // the app is closing: no "playing" notification may outlive it
        stopService(new Intent(this, PlaybackService.class));
        super.onDestroy();
    }
}
