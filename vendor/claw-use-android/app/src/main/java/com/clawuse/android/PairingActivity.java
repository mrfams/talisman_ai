package com.clawuse.android;

import android.Manifest;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.provider.Settings;
import android.text.InputType;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

import androidx.appcompat.app.AppCompatActivity;

import org.json.JSONObject;

import java.net.URI;

/**
 * One screen: pair this phone, enable the two Android services, and see whether
 * the outbound companion is alive. No token is displayed; it is returned once
 * to this app and stored in Keystore-backed preferences.
 */
public class PairingActivity extends AppCompatActivity {
    private static final String DEFAULT_SERVER = "https://talisman-agent.vercel.app";
    private TalismanStore store;
    private EditText serverInput;
    private EditText codeInput;
    private TextView status;
    private Button pairButton;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        store = TalismanStore.get(this);
        setContentView(buildUi());
        serverInput.setText(store.server() != null ? store.server() : DEFAULT_SERVER);
        if (Build.VERSION.SDK_INT >= 33
                && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)
                != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, 41);
        }
    }

    @Override
    protected void onResume() {
        super.onResume();
        updateStatus();
    }

    private ViewGroup buildUi() {
        ScrollView scroll = new ScrollView(this);
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setPadding(dp(24), dp(28), dp(24), dp(28));
        scroll.addView(root);

        TextView title = new TextView(this);
        title.setText("Talisman Companion");
        title.setTextSize(26);
        title.setTypeface(null, android.graphics.Typeface.BOLD);
        root.addView(title);

        TextView intro = new TextView(this);
        intro.setText("This phone does the work. Talisman only queues commands; it never connects into your phone. "
                + "Pairing gives this app a device token, not your password.");
        intro.setTextSize(14);
        intro.setPadding(0, dp(10), 0, dp(18));
        root.addView(intro);

        serverInput = new EditText(this);
        serverInput.setHint("https://talisman-agent.vercel.app");
        serverInput.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        serverInput.setSingleLine(true);
        root.addView(serverInput, matchWidth());

        codeInput = new EditText(this);
        codeInput.setHint("Pairing code, e.g. 7K4M-2Q9X");
        codeInput.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_CAP_CHARACTERS);
        codeInput.setSingleLine(true);
        root.addView(codeInput, matchWidth());

        pairButton = new Button(this);
        pairButton.setText(store.isPaired() ? "Pair again" : "Pair this phone");
        pairButton.setOnClickListener(v -> pair());
        root.addView(pairButton, matchWidth());

        status = new TextView(this);
        status.setTextSize(14);
        status.setPadding(0, dp(16), 0, dp(14));
        root.addView(status);

        addAction(root, "1. Enable Accessibility", v -> startActivity(new Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS)));
        addAction(root, "2. Allow notification access", v ->
                startActivity(new Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS)));
        addAction(root, "3. Keep the companion alive (battery)", v -> openBatterySettings());
        addAction(root, "4. Allow restricted settings (Android 13+)", v -> openAppDetails());
        addAction(root, "Start companion", v -> startCompanion());
        addAction(root, "Stop companion", v -> {
            TalismanAgentService.stop(this);
            updateStatus();
        });
        addAction(root, "Unpair this phone", v -> unpair());

        TextView note = new TextView(this);
        note.setText("Android may hide the Accessibility toggle for sideloaded apps until you open App info → ⋯ → Allow restricted settings. "
                + "Talisman refuses banking, password-manager and authenticator apps, and never stores your PIN or password.");
        note.setTextSize(12);
        note.setPadding(0, dp(20), 0, 0);
        root.addView(note);
        return scroll;
    }

    private void addAction(LinearLayout root, String label, android.view.View.OnClickListener listener) {
        Button button = new Button(this);
        button.setText(label);
        button.setAllCaps(false);
        button.setOnClickListener(listener);
        root.addView(button, matchWidth());
    }

    private LinearLayout.LayoutParams matchWidth() {
        return new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }

    private void pair() {
        final String server = serverInput.getText().toString().trim();
        final String code = codeInput.getText().toString().trim();
        if (!validServer(server)) {
            status.setText("Use https://… or http://localhost for a local Talisman.");
            return;
        }
        if (code.length() < 8) {
            status.setText("Enter the pairing code from Talisman → Devices.");
            return;
        }
        pairButton.setEnabled(false);
        status.setText("Claiming this phone…");
        new Thread(() -> {
            String error = null;
            try {
                JSONObject body = new JSONObject()
                        .put("code", code)
                        .put("platform", "android")
                        .put("model", Build.MODEL)
                        .put("os_version", Build.VERSION.RELEASE)
                        .put("app_version", AgentHttp.APP_VERSION)
                        .put("capabilities", new JSONObject()
                                .put("observe", true)
                                .put("act", true)
                                .put("flow", true)
                                .put("apps", true)
                                .put("status", true));
                JSONObject result = AgentHttp.json(server, null, "POST", "/api/phone/pair/claim", body, 20_000);
                String token = result == null ? "" : result.optString("token", "");
                String deviceId = result == null ? "" : result.optString("deviceId", "");
                if (token.isEmpty() || deviceId.isEmpty()) throw new IllegalStateException("empty token");
                store.savePairing(server, token, deviceId, result.optString("name", "Android phone"));
                BridgeService.start(this);
                TalismanAgentService.start(this);
            } catch (AgentHttp.HttpError http) {
                error = httpMessage(http);
            } catch (Exception exception) {
                error = "Could not pair: " + exception.getMessage();
            }
            final String message = error;
            runOnUiThread(() -> {
                pairButton.setEnabled(true);
                if (message == null) {
                    codeInput.setText("");
                    status.setText("Paired. Turn on Accessibility, then use the phone from Talisman.");
                    Toast.makeText(this, "Phone paired", Toast.LENGTH_SHORT).show();
                } else {
                    status.setText(message);
                }
                updateStatus();
            });
        }, "talisman-pair").start();
    }

    private void startCompanion() {
        if (!store.isPaired()) {
            status.setText("Pair this phone first.");
            return;
        }
        store.setEnabled(true);
        BridgeService.start(this);
        TalismanAgentService.start(this);
        updateStatus();
    }

    private void unpair() {
        TalismanAgentService.stop(this);
        BridgeService.stop(this);
        store.clear();
        updateStatus();
        Toast.makeText(this, "Unpaired", Toast.LENGTH_SHORT).show();
    }

    private void updateStatus() {
        if (status == null) return;
        if (!store.isPaired()) {
            status.setText("Not paired.");
            return;
        }
        boolean a11y = AccessibilityBridge.isRunning();
        boolean agent = TalismanAgentService.isRunning();
        status.setText((agent ? "● Companion running" : "○ Companion stopped")
                + "\n" + (a11y ? "● Accessibility connected" : "○ Accessibility off")
                + "\nPaired as " + store.deviceName());
    }

    private String httpMessage(AgentHttp.HttpError error) {
        try {
            JSONObject body = new JSONObject(error.body);
            String message = body.optString("error", "");
            if (!message.isEmpty()) return message;
        } catch (Exception ignored) {
            // Fall through to a status message.
        }
        return "Pairing failed (HTTP " + error.status + ")";
    }

    private boolean validServer(String server) {
        try {
            URI uri = URI.create(server);
            String scheme = uri.getScheme();
            String host = uri.getHost();
            if (scheme == null || host == null) return false;
            if ("https".equalsIgnoreCase(scheme)) return true;
            if (!"http".equalsIgnoreCase(scheme)) return false;
            return host.equals("localhost") || host.equals("127.0.0.1") || host.equals("10.0.2.2");
        } catch (Exception e) {
            return false;
        }
    }

    private void openBatterySettings() {
        try {
            Intent intent = new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS);
            intent.setData(Uri.parse("package:" + getPackageName()));
            startActivity(intent);
        } catch (Exception e) {
            startActivity(new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS));
        }
    }

    private void openAppDetails() {
        Intent intent = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS);
        intent.setData(Uri.parse("package:" + getPackageName()));
        startActivity(intent);
    }
}
