package com.clawuse.android;

import android.accessibilityservice.AccessibilityServiceInfo;
import android.app.KeyguardManager;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
import android.os.BatteryManager;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;
import android.provider.Settings;
import android.util.Base64;
import android.util.Log;
import android.view.accessibility.AccessibilityManager;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.HashSet;
import java.util.List;
import java.util.Set;

/**
 * The phone-side executor.
 *
 * It is deliberately a client: it polls outbound, claims one command, executes
 * it through the vendored accessibility handlers, and posts one result. It never
 * exposes a LAN port to Talisman and never stores a lock credential.
 */
public class TalismanAgentService extends Service {
    private static final String TAG = "TalismanAgent";
    private static final String CHANNEL_ID = "talisman_agent";
    private static final int NOTIFICATION_ID = 7334;
    static final String ACTION_STOP = "app.talisman.companion.STOP_AGENT";

    private static volatile boolean running;

    private volatile boolean stop;
    private Thread pollThread;
    private Thread heartbeatThread;
    private TalismanStore store;
    private LocalBridge bridge;
    private long frameSeq = System.currentTimeMillis();

    static boolean isRunning() {
        return running;
    }

    static void start(Context context) {
        Intent intent = new Intent(context, TalismanAgentService.class);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            context.startForegroundService(intent);
        } else {
            context.startService(intent);
        }
    }

    static void stop(Context context) {
        context.stopService(new Intent(context, TalismanAgentService.class));
    }

    @Override
    public void onCreate() {
        super.onCreate();
        try {
            store = TalismanStore.get(this);
        } catch (RuntimeException e) {
            Log.e(TAG, "Encrypted storage unavailable", e);
            stopSelf();
            return;
        }
        createNotificationChannel();
        startForeground(NOTIFICATION_ID, buildNotification());
        if (!store.isPaired() || !store.isEnabled()) {
            stopSelf();
            return;
        }
        bridge = new LocalBridge(new TokenManager(this).getToken());
        running = true;
        stop = false;
        pollThread = new Thread(this::pollLoop, "talisman-poll");
        pollThread.start();
        heartbeatThread = new Thread(this::heartbeatLoop, "talisman-heartbeat");
        heartbeatThread.start();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && ACTION_STOP.equals(intent.getAction())) {
            store.setEnabled(false);
            stopSelf();
            return START_NOT_STICKY;
        }
        if (store == null || !store.isPaired() || !store.isEnabled()) {
            stopSelf();
            return START_NOT_STICKY;
        }
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        stop = true;
        running = false;
        if (pollThread != null) pollThread.interrupt();
        if (heartbeatThread != null) heartbeatThread.interrupt();
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    private void pollLoop() {
        while (!stop) {
            try {
                JSONObject response = AgentHttp.json(
                        store.server(), store.token(), "POST", "/api/phone/agent/poll", null, 30_000);
                if (response == null) continue;
                JSONObject command = response.optJSONObject("command");
                if (command != null) handle(command);
            } catch (AgentHttp.HttpError error) {
                if (error.status == 401) {
                    Log.w(TAG, "Device token was rejected; stopping");
                    stopSelf();
                    return;
                }
                sleep(3_000);
            } catch (Exception error) {
                Log.w(TAG, "Poll failed: " + error.getMessage());
                sleep(2_000);
            }
        }
    }

    private void handle(JSONObject command) {
        String id = command.optString("id", "");
        String op = command.optString("op", "");
        if (id.isEmpty() || op.isEmpty()) return;
        long started = System.currentTimeMillis();
        try {
            JSONObject args = command.optJSONObject("args");
            if (args == null) args = new JSONObject();
            verifyArgs(command, args, op);
            JSONObject result = execute(op, args);
            postResult(id, "done", result, null, System.currentTimeMillis() - started);
        } catch (AgentFailure failure) {
            postResult(id, "error", null, failure.code, System.currentTimeMillis() - started);
        } catch (Exception error) {
            Log.w(TAG, "Command failed: " + error.getMessage());
            postResult(id, "error", null, "internal", System.currentTimeMillis() - started);
        }
    }

    /**
     * An approved command is bound to the exact arguments the human saw. A
     * changed payload is refused on the phone, not trusted because the server
     * says it is approved.
     */
    private void verifyArgs(JSONObject command, JSONObject args, String op) throws AgentFailure {
        boolean mutating = "act".equals(op) || "flow".equals(op);
        if (!mutating) return;

        String approval = command.optString("approval_id", "");
        String expected = command.optString("args_hash", "");
        // Actions are never executed on the phone without a server-side approval
        // that is bound to these exact arguments. The server checks that the
        // approval is approved before it queues; this is the last line of defense.
        if (approval.isEmpty() || expected.isEmpty()) {
            throw new AgentFailure("approval_required");
        }
        if (!CanonicalJson.hash(args).equals(expected)) {
            throw new AgentFailure("approval_mismatch");
        }
    }

    private JSONObject execute(String op, JSONObject args) throws Exception {
        switch (op) {
            case "observe":
                return observe(args);
            case "act":
                return act(args);
            case "flow":
                return flow(args);
            case "apps":
                return apps(args);
            case "status":
                return status();
            default:
                throw new AgentFailure("unsupported");
        }
    }

    private JSONObject observe(JSONObject args) throws Exception {
        JSONObject state = readyState();
        String pkg = state.optString("foregroundPackage", "");
        SafetyPolicy.requirePackage(pkg);

        JSONObject screen = bridge.screen();
        SafetyPolicy.requirePackage(screen.optString("package", pkg));
        SafetyPolicy.requireNotSecure(screen);

        JSONObject normalized = new JSONObject();
        normalized.put("package", screen.optString("package", pkg));
        JSONArray elements = screen.optJSONArray("elements");
        normalized.put("nodes", elements == null ? new JSONArray() : elements);
        normalized.put("secure", false);

        JSONObject result = new JSONObject();
        result.put("ok", true);
        result.put("screen", normalized);
        result.put("width", screen.optInt("width"));
        result.put("height", screen.optInt("height"));
        result.put("data", new JSONObject().put("package", normalized.optString("package", pkg)));

        if (args.optBoolean("screenshot", false)) {
            JSONObject snapshot = bridge.snapshot();
            String encoded = snapshot.optString("screenshot", "");
            if (encoded.isEmpty()) throw new AgentFailure("screenshot_failed");
            byte[] jpeg = Base64.decode(encoded, Base64.DEFAULT);
            if (jpeg.length > 300 * 1024) throw new AgentFailure("screenshot_too_large");
            int width = snapshot.optInt("width", screen.optInt("width"));
            int height = snapshot.optInt("height", screen.optInt("height"));
            uploadFrame(jpeg, width, height);
            result.put("screenshot", new JSONObject()
                    .put("mime", "image/jpeg")
                    .put("base64", encoded));
        }
        return result;
    }

    private JSONObject act(JSONObject args) throws Exception {
        String action = args.optString("action", "");
        if (action.isEmpty()) throw new AgentFailure("invalid_action");

        if ("launch".equals(action)) {
            String pkg = args.optString("package", "");
            SafetyPolicy.requirePackage(pkg);
            JSONObject body = new JSONObject().put("launch", pkg);
            return ack(action, bridge.act(body));
        }
        if ("deep_link".equals(action)) {
            String uri = args.optString("uri", "");
            SafetyPolicy.requireSafeUri(uri);
            JSONObject body = new JSONObject()
                    .put("action", "android.intent.action.VIEW")
                    .put("uri", uri);
            return ack(action, bridge.intent(body));
        }

        JSONObject state = readyState();
        SafetyPolicy.requirePackage(state.optString("foregroundPackage", ""));
        SafetyPolicy.requireNotSecure(bridge.screen());

        JSONObject body = new JSONObject();
        switch (action) {
            case "tap_ref": {
                int ref = args.optInt("ref", -1);
                if (ref <= 0) throw new AgentFailure("ref_stale");
                body.put("click", ref);
                break;
            }
            case "tap":
                body.put("tap", new JSONObject()
                        .put("x", args.optInt("x"))
                        .put("y", args.optInt("y")));
                break;
            case "long_press": {
                JSONObject press = new JSONObject();
                if (args.has("ref")) press.put("ref", args.optInt("ref"));
                else press.put("x", args.optInt("x")).put("y", args.optInt("y"));
                body.put("longpress", press);
                break;
            }
            case "type": {
                JSONObject type = new JSONObject().put("text", args.optString("text", ""));
                if (args.optInt("ref", -1) > 0) type.put("ref", args.optInt("ref"));
                body.put("type", type);
                break;
            }
            case "swipe":
                if (args.has("direction")) body.put("swipe", args.optString("direction"));
                else body.put("swipe", new JSONObject()
                        .put("x1", args.optInt("x1")).put("y1", args.optInt("y1"))
                        .put("x2", args.optInt("x2")).put("y2", args.optInt("y2")));
                break;
            case "scroll":
                body.put("scroll", args.optString("direction", "down"));
                break;
            case "global": {
                String name = args.optString("name", "back");
                if (!name.equals("back") && !name.equals("home") && !name.equals("recents")) {
                    throw new AgentFailure("invalid_action");
                }
                body.put(name, true);
                break;
            }
            default:
                throw new AgentFailure("invalid_action");
        }
        JSONObject outcome = ack(action, bridge.act(body));
        if ("type".equals(action) && args.optBoolean("submit", false)) {
            outcome.put("warning", "submit_not_supported");
        }
        return outcome;
    }

    private JSONObject flow(JSONObject args) throws Exception {
        JSONObject state = readyState();
        SafetyPolicy.requirePackage(state.optString("foregroundPackage", ""));
        SafetyPolicy.requireNotSecure(bridge.screen());

        JSONArray steps = args.optJSONArray("steps");
        if (steps == null || steps.length() == 0) throw new AgentFailure("invalid_flow");
        JSONObject body = new JSONObject();
        JSONArray translated = new JSONArray();
        for (int i = 0; i < steps.length(); i++) {
            JSONObject step = steps.optJSONObject(i);
            if (step == null) throw new AgentFailure("invalid_flow");
            JSONObject wait = step.optJSONObject("wait_for");
            JSONObject then = step.optJSONObject("then");
            if (then == null) throw new AgentFailure("invalid_flow");

            JSONObject out = new JSONObject();
            if (wait != null) {
                if (wait.has("text")) out.put("wait", wait.optString("text"));
                if (wait.has("id")) out.put("waitId", wait.optString("id"));
                if (wait.has("desc")) out.put("waitDesc", wait.optString("desc"));
                out.put("timeout", wait.optInt("timeout_ms", 10_000));
            }
            String action = then.optString("action", "tap_text");
            switch (action) {
                case "tap_text":
                case "tap":
                    out.put("then", "tap");
                    break;
                case "global": {
                    String name = then.optString("name", "back");
                    if (!name.equals("back") && !name.equals("home")) {
                        throw new AgentFailure("unsupported_step");
                    }
                    out.put("then", name);
                    break;
                }
                case "none":
                    out.put("then", "none");
                    break;
                default:
                    throw new AgentFailure("unsupported_step");
            }
            if (step.optBoolean("optional", false)) out.put("optional", true);
            translated.put(out);
        }
        body.put("steps", translated);
        return ack("flow", bridge.flow(body));
    }

    private JSONObject apps(JSONObject args) throws Exception {
        Intent main = new Intent(Intent.ACTION_MAIN, null);
        main.addCategory(Intent.CATEGORY_LAUNCHER);
        PackageManager pm = getPackageManager();
        List<ResolveInfo> resolved = pm.queryIntentActivities(main, 0);
        boolean includeSystem = args.optBoolean("include_system", false);
        JSONArray apps = new JSONArray();
        Set<String> seen = new HashSet<>();
        for (ResolveInfo info : resolved) {
            if (info.activityInfo == null) continue;
            String pkg = info.activityInfo.packageName;
            if (pkg == null || seen.contains(pkg) || SafetyPolicy.isDenied(pkg)) continue;
            boolean system = (info.activityInfo.applicationInfo.flags & ApplicationInfo.FLAG_SYSTEM) != 0;
            if (system && !includeSystem && !pkg.equals("com.android.settings")) continue;
            seen.add(pkg);
            apps.put(new JSONObject()
                    .put("package", pkg)
                    .put("label", String.valueOf(info.loadLabel(pm)))
                    .put("system", system));
        }
        return new JSONObject().put("ok", true).put("apps", apps);
    }

    private JSONObject status() {
        JSONObject out = statusSnapshot();
        try {
            out.put("ok", true);
            out.put("app_version", AgentHttp.APP_VERSION);
            out.put("protocol", AgentHttp.PROTOCOL);
            out.put("aapm", Settings.Secure.getInt(
                    getContentResolver(), "advanced_protection_mode", 0) == 1);
        } catch (Exception ignored) {
            // Diagnostics must not fail the status call.
        }
        return out;
    }

    private JSONObject statusSnapshot() {
        JSONObject out = new JSONObject();
        try {
            BatteryManager battery = (BatteryManager) getSystemService(BATTERY_SERVICE);
            PowerManager power = (PowerManager) getSystemService(POWER_SERVICE);
            KeyguardManager keyguard = (KeyguardManager) getSystemService(KEYGUARD_SERVICE);
            int level = battery == null ? -1 : battery.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY);
            boolean charging = battery != null && battery.isCharging();
            boolean screenOn = power != null && power.isInteractive();
            boolean locked = keyguard != null && keyguard.isKeyguardLocked();
            out.put("battery", level < 0 ? JSONObject.NULL : level / 100.0);
            out.put("charging", charging);
            out.put("screen", screenOn ? "on" : "off");
            out.put("locked", locked);
            out.put("a11y", AccessibilityBridge.isRunning());
            out.put("model", Build.MODEL);
            out.put("os_version", Build.VERSION.RELEASE);
        } catch (Exception ignored) {
            // A partial status is still useful.
        }
        return out;
    }

    private JSONObject readyState() throws Exception {
        JSONObject state = bridge.state();
        if (state.optBoolean("locked", false)) throw new AgentFailure("locked");
        if (!state.optBoolean("screenOn", true)) throw new AgentFailure("screen_off");
        return state;
    }

    private JSONObject ack(String action, JSONObject result) throws Exception {
        return new JSONObject().put("ok", true).put("action", action).put("result", result);
    }

    private void postResult(
            String commandId,
            String status,
            JSONObject result,
            String error,
            long durationMs
    ) {
        try {
            JSONObject body = new JSONObject()
                    .put("command_id", commandId)
                    .put("status", status)
                    .put("duration_ms", durationMs);
            if (result != null) body.put("result", result);
            if (error != null) body.put("error", error);
            AgentHttp.json(store.server(), store.token(), "POST", "/api/phone/agent/result", body, 15_000);
        } catch (Exception errorPosting) {
            Log.w(TAG, "Result POST failed: " + errorPosting.getMessage());
        }
    }

    private void uploadFrame(byte[] jpeg, int width, int height) {
        try {
            AgentHttp.frame(store.server(), store.token(), jpeg, frameSeq++, width, height);
        } catch (Exception error) {
            Log.w(TAG, "Frame upload failed: " + error.getMessage());
        }
    }

    private void heartbeatLoop() {
        while (!stop) {
            sleep(30_000);
            if (stop) return;
            try {
                AgentHttp.json(
                        store.server(), store.token(), "POST", "/api/phone/agent/heartbeat",
                        statusSnapshot(), 15_000);
            } catch (AgentHttp.HttpError error) {
                if (error.status == 401) {
                    stopSelf();
                    return;
                }
            } catch (Exception error) {
                Log.w(TAG, "Heartbeat failed: " + error.getMessage());
            }
        }
    }

    private void sleep(long ms) {
        try {
            Thread.sleep(ms);
        } catch (InterruptedException ignored) {
            Thread.currentThread().interrupt();
        }
    }

    private void createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel channel = new NotificationChannel(
                    CHANNEL_ID, "Talisman companion", NotificationManager.IMPORTANCE_LOW);
            channel.setDescription("Keeps your paired phone available to your agent");
            NotificationManager manager = getSystemService(NotificationManager.class);
            if (manager != null) manager.createNotificationChannel(channel);
        }
    }

    private Notification buildNotification() {
        Intent open = new Intent(this, PairingActivity.class);
        PendingIntent openPending = PendingIntent.getActivity(
                this, 0, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        Intent stopIntent = new Intent(this, TalismanAgentService.class);
        stopIntent.setAction(ACTION_STOP);
        PendingIntent stopPending = PendingIntent.getService(
                this, 1, stopIntent, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);

        Notification.Builder builder = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                ? new Notification.Builder(this, CHANNEL_ID)
                : new Notification.Builder(this);
        return builder
                .setContentTitle("Talisman Companion")
                .setContentText(store != null && store.isPaired()
                        ? "Paired · waiting for work" : "Not paired")
                .setSmallIcon(android.R.drawable.ic_menu_compass)
                .setContentIntent(openPending)
                .setOngoing(true)
                .addAction(new Notification.Action.Builder(null, "Stop", stopPending).build())
                .build();
    }
}
