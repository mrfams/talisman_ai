package com.clawuse.android;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

/** Loopback-only calls into the upstream executor, authenticated by its local token. */
final class LocalBridge {
    private static final String BASE = "http://127.0.0.1:7333";
    private final String token;

    LocalBridge(String token) {
        this.token = token;
    }

    JSONObject screen() throws IOException, AgentFailure {
        return call("GET", "/screen", null);
    }

    JSONObject snapshot() throws IOException, AgentFailure {
        return call("GET", "/snapshot?quality=45&maxWidth=720", null);
    }

    JSONObject state() throws IOException, AgentFailure {
        return call("GET", "/screen/state", null);
    }

    JSONObject act(JSONObject body) throws IOException, AgentFailure {
        return call("POST", "/act", body);
    }

    JSONObject intent(JSONObject body) throws IOException, AgentFailure {
        return call("POST", "/intent", body);
    }

    JSONObject flow(JSONObject body) throws IOException, AgentFailure {
        return call("POST", "/flow", body);
    }

    private JSONObject call(String method, String path, JSONObject body)
            throws IOException, AgentFailure {
        HttpURLConnection connection = (HttpURLConnection) new URL(BASE + path).openConnection();
        connection.setRequestMethod(method);
        connection.setConnectTimeout(3_000);
        // A whole phone plan runs inside one /flow call, so this must outlast
        // several guarded waits rather than a single tap.
        connection.setReadTimeout(90_000);
        connection.setRequestProperty("x-bridge-token", token);
        connection.setRequestProperty("accept", "application/json");
        if (body != null) {
            byte[] bytes = body.toString().getBytes(StandardCharsets.UTF_8);
            connection.setDoOutput(true);
            connection.setRequestProperty("content-type", "application/json; charset=utf-8");
            connection.setFixedLengthStreamingMode(bytes.length);
            try (OutputStream output = connection.getOutputStream()) {
                output.write(bytes);
            }
        }
        try {
            int status = connection.getResponseCode();
            String text = read(status >= 400 ? connection.getErrorStream() : connection.getInputStream());
            if (text.isEmpty()) throw new AgentFailure("empty_response");
            JSONObject result;
            try {
                result = new JSONObject(text);
            } catch (JSONException invalid) {
                throw new AgentFailure("invalid_response");
            }
            if (status < 200 || status >= 300) {
                throw new AgentFailure(mapError(result.optString("error", "local_error")));
            }
            if (result.has("error")) {
                throw new AgentFailure(mapError(result.optString("error")));
            }
            return result;
        } finally {
            connection.disconnect();
        }
    }

    private static String mapError(String message) {
        String lower = message == null ? "" : message.toLowerCase();
        if (lower.contains("accessibility") || lower.contains("a11y")) return "a11y_off";
        if (lower.contains("locked")) return "locked";
        if (lower.contains("secure")) return "secure_window";
        if (lower.contains("not found") && lower.contains("ref")) return "ref_stale";
        if (lower.contains("not found")) return "app_not_found";
        return "act_failed";
    }

    private static String read(InputStream stream) throws IOException {
        if (stream == null) return "";
        try (InputStream input = stream; ByteArrayOutputStream output = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[8_192];
            int read;
            while ((read = input.read(buffer)) != -1) output.write(buffer, 0, read);
            return output.toString(StandardCharsets.UTF_8.name());
        }
    }
}
