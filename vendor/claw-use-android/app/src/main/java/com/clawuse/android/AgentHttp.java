package com.clawuse.android;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

/**
 * The only network calls the companion makes. They are all outbound; the phone
 * never listens for Talisman traffic.
 */
final class AgentHttp {
    static final String APP_VERSION = "0.1.0";
    static final int PROTOCOL = 1;

    private AgentHttp() {}

    static JSONObject json(
            String baseUrl,
            String token,
            String method,
            String path,
            JSONObject body,
            int readTimeoutMs
    ) throws IOException, HttpError {
        HttpURLConnection connection = open(baseUrl, path, method, readTimeoutMs);
        try {
            connection.setRequestProperty("accept", "application/json");
            connection.setRequestProperty("x-talisman-app", APP_VERSION);
            connection.setRequestProperty("x-talisman-protocol", String.valueOf(PROTOCOL));
            if (token != null) connection.setRequestProperty("authorization", "Bearer " + token);
            if (body != null) {
                byte[] bytes = body.toString().getBytes(StandardCharsets.UTF_8);
                connection.setDoOutput(true);
                connection.setRequestProperty("content-type", "application/json; charset=utf-8");
                connection.setFixedLengthStreamingMode(bytes.length);
                try (OutputStream output = connection.getOutputStream()) {
                    output.write(bytes);
                }
            }

            int status = connection.getResponseCode();
            if (status == 204) return null;
            String text = read(status >= 400 ? connection.getErrorStream() : connection.getInputStream());
            if (status < 200 || status >= 300) throw new HttpError(status, text);
            return text.isEmpty() ? new JSONObject() : new JSONObject(text);
        } finally {
            connection.disconnect();
        }
    }

    static void frame(
            String baseUrl,
            String token,
            byte[] jpeg,
            long seq,
            int width,
            int height
    ) throws IOException, HttpError {
        HttpURLConnection connection = open(baseUrl, "/api/phone/agent/frame", "POST", 15_000);
        try {
            connection.setRequestProperty("authorization", "Bearer " + token);
            connection.setRequestProperty("content-type", "image/jpeg");
            connection.setRequestProperty("x-talisman-seq", String.valueOf(seq));
            if (width > 0) connection.setRequestProperty("x-talisman-width", String.valueOf(width));
            if (height > 0) connection.setRequestProperty("x-talisman-height", String.valueOf(height));
            connection.setDoOutput(true);
            connection.setFixedLengthStreamingMode(jpeg.length);
            try (OutputStream output = connection.getOutputStream()) {
                output.write(jpeg);
            }
            int status = connection.getResponseCode();
            String text = read(status >= 400 ? connection.getErrorStream() : connection.getInputStream());
            if (status < 200 || status >= 300) throw new HttpError(status, text);
        } finally {
            connection.disconnect();
        }
    }

    private static HttpURLConnection open(String baseUrl, String path, String method, int readTimeoutMs)
            throws IOException {
        String base = baseUrl.endsWith("/") ? baseUrl.substring(0, baseUrl.length() - 1) : baseUrl;
        HttpURLConnection connection = (HttpURLConnection) new URL(base + path).openConnection();
        connection.setRequestMethod(method);
        connection.setConnectTimeout(10_000);
        connection.setReadTimeout(readTimeoutMs);
        connection.setUseCaches(false);
        return connection;
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

    static final class HttpError extends Exception {
        final int status;
        final String body;

        HttpError(int status, String body) {
            super("HTTP " + status);
            this.status = status;
            this.body = body;
        }
    }
}
