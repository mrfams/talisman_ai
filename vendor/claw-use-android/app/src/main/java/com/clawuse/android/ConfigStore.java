package com.clawuse.android;

import android.content.Context;
import android.content.SharedPreferences;

import androidx.security.crypto.EncryptedSharedPreferences;
import androidx.security.crypto.MasterKeys;

import org.json.JSONObject;

/**
 * Encrypted storage for the bridge preference only.
 *
 * Talisman deliberately has no lock credential here. The companion cannot wake
 * or unlock the phone; if the phone is locked, it returns `locked` and waits for
 * its owner. Storing a PIN would turn a database compromise into a phone
 * compromise, which is not a trade this product makes.
 */
public class ConfigStore {
    private static final String PREFS_NAME = "talisman_companion_config";
    private static final String KEY_BRIDGE_ENABLED = "bridge_enabled";
    private static final String KEY_PERMISSIONS_ASKED = "permissions_asked";

    private static volatile ConfigStore instance;
    private final SharedPreferences prefs;

    public static ConfigStore get(Context context) {
        if (instance == null) {
            synchronized (ConfigStore.class) {
                if (instance == null) {
                    instance = new ConfigStore(context.getApplicationContext());
                }
            }
        }
        return instance;
    }

    private ConfigStore(Context context) {
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
            // Fail closed. Falling back to plain SharedPreferences would silently
            // downgrade the only secret on the device.
            throw new IllegalStateException("Talisman could not open encrypted storage", e);
        }
    }

    /** Whether the local bridge service should run. Default: on after pairing. */
    public boolean isBridgeEnabled() {
        return prefs.getBoolean(KEY_BRIDGE_ENABLED, true);
    }

    public void setBridgeEnabled(boolean enabled) {
        prefs.edit().putBoolean(KEY_BRIDGE_ENABLED, enabled).apply();
    }

    public boolean werePermissionsAsked() {
        return prefs.getBoolean(KEY_PERMISSIONS_ASKED, false);
    }

    public void setPermissionsAsked(boolean asked) {
        prefs.edit().putBoolean(KEY_PERMISSIONS_ASKED, asked).apply();
    }

    public JSONObject toJson() {
        try {
            JSONObject j = new JSONObject();
            j.put("bridgeEnabled", isBridgeEnabled());
            j.put("lockCredentialStored", false);
            return j;
        } catch (Exception e) {
            return new JSONObject();
        }
    }
}
