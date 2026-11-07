package com.clawuse.android;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Iterator;
import java.util.List;

/** Must stay byte-for-byte compatible with src/phone/protocol.ts. */
final class CanonicalJson {
    private CanonicalJson() {}

    static String hash(JSONObject value) {
        return "sha256:" + sha256(canonical(value));
    }

    static String canonical(Object value) {
        if (value == null || value == JSONObject.NULL) return "null";
        if (value instanceof JSONObject) {
            JSONObject object = (JSONObject) value;
            List<String> keys = new ArrayList<>();
            Iterator<String> iterator = object.keys();
            while (iterator.hasNext()) keys.add(iterator.next());
            Collections.sort(keys);
            StringBuilder out = new StringBuilder("{");
            boolean first = true;
            for (String key : keys) {
                Object child = object.opt(key);
                if (child == null) continue;
                if (!first) out.append(',');
                first = false;
                out.append(JSONObject.quote(key)).append(':').append(canonical(child));
            }
            return out.append('}').toString();
        }
        if (value instanceof JSONArray) {
            JSONArray array = (JSONArray) value;
            StringBuilder out = new StringBuilder("[");
            for (int i = 0; i < array.length(); i++) {
                if (i > 0) out.append(',');
                out.append(canonical(array.opt(i)));
            }
            return out.append(']').toString();
        }
        if (value instanceof String) return quote((String) value);
        if (value instanceof Boolean) return String.valueOf(value);
        if (value instanceof Number) {
            try {
                return JSONObject.numberToString((Number) value);
            } catch (JSONException invalid) {
                throw new IllegalArgumentException("Invalid JSON number", invalid);
            }
        }
        return quote(String.valueOf(value));
    }

    /** Matches JSON.stringify: never escape '/', do escape quotes, slashes and controls. */
    private static String quote(String value) {
        StringBuilder out = new StringBuilder(value.length() + 2).append('"');
        for (int i = 0; i < value.length(); i++) {
            char c = value.charAt(i);
            switch (c) {
                case '"': out.append("\\\""); break;
                case '\\': out.append("\\\\"); break;
                case '\b': out.append("\\b"); break;
                case '\f': out.append("\\f"); break;
                case '\n': out.append("\\n"); break;
                case '\r': out.append("\\r"); break;
                case '\t': out.append("\\t"); break;
                default:
                    if (c < 0x20) out.append(String.format("\\u%04x", (int) c));
                    else out.append(c);
            }
        }
        return out.append('"').toString();
    }

    private static String sha256(String input) {
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            byte[] bytes = digest.digest(input.getBytes(java.nio.charset.StandardCharsets.UTF_8));
            StringBuilder hex = new StringBuilder(bytes.length * 2);
            for (byte b : bytes) hex.append(String.format("%02x", b));
            return hex.toString();
        } catch (Exception e) {
            throw new IllegalStateException("SHA-256 is unavailable", e);
        }
    }
}
