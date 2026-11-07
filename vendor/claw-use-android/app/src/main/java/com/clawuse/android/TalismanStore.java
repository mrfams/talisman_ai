package com.clawuse.android;

import android.content.Context;
import android.content.SharedPreferences;

import androidx.security.crypto.EncryptedSharedPreferences;
import androidx.security.crypto.MasterKeys;

/**
 * The paired-device credentials. Only the device token and the server URL are
 * stored; there is no PIN, password, or lock credential.
 */
final class TalismanStore {
    private static final String PREFS_NAME = "talisman_pairing_encrypted";
    private static final String KEY_SERVER = "server";
    private static final String KEY_TOKEN = "device_token";
    private static final String KEY_DEVICE = "device_id";
    private static final String KEY_NAME = "device_name";
    private static final String KEY_ENABLED = "enabled";

    private static volatile TalismanStore instance;
    private final SharedPreferences prefs;

    static TalismanStore get(Context context) {
        if (instance == null) {
            synchronized (TalismanStore.class) {
                if (instance == null) instance = new TalismanStore(context.getApplicationContext());
            }
        }
        return instance;
    }

    private TalismanStore(Context context) {
        try {
            String masterKeyAlias = MasterKeys.getOrCreate(MasterKeys.AES256_GCM_SPEC);
            prefs = EncryptedSharedPreferences.create(
                    PREFS_NAME,
                    masterKeyAlias,
                    context,
                    EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
                    EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM
            );
        } catch (Exception e) {
            throw new IllegalStateException("Talisman could not open encrypted pairing storage", e);
        }
    }

    boolean isPaired() {
        String server = server();
        String token = token();
        return server != null && !server.isEmpty() && token != null && !token.isEmpty();
    }

    String server() {
        return prefs.getString(KEY_SERVER, null);
    }

    String token() {
        return prefs.getString(KEY_TOKEN, null);
    }

    String deviceId() {
        return prefs.getString(KEY_DEVICE, null);
    }

    String deviceName() {
        return prefs.getString(KEY_NAME, "Android phone");
    }

    boolean isEnabled() {
        return prefs.getBoolean(KEY_ENABLED, true);
    }

    void setEnabled(boolean enabled) {
        prefs.edit().putBoolean(KEY_ENABLED, enabled).apply();
    }

    void savePairing(String server, String token, String deviceId, String name) {
        prefs.edit()
                .putString(KEY_SERVER, server)
                .putString(KEY_TOKEN, token)
                .putString(KEY_DEVICE, deviceId)
                .putString(KEY_NAME, name)
                .putBoolean(KEY_ENABLED, true)
                .apply();
    }

    void clear() {
        prefs.edit().clear().apply();
    }
}
