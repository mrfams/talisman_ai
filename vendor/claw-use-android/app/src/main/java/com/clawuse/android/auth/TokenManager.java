package com.clawuse.android.auth;

import android.content.Context;
import android.content.SharedPreferences;
import android.util.Base64;

import androidx.security.crypto.EncryptedSharedPreferences;
import androidx.security.crypto.MasterKeys;

import java.security.SecureRandom;

/**
 * The secret that guards the loopback-only executor.
 *
 * This is not the Talisman device token. It never leaves the phone; the agent
 * service and the local bridge service are the only readers. It is stored in
 * Keystore-backed encrypted preferences rather than plain SharedPreferences.
 */
public class TokenManager {
    private static final String PREFS_NAME = "talisman_bridge_auth";
    private static final String KEY_TOKEN = "bridge_token";
    private final SharedPreferences prefs;

    public TokenManager(Context context) {
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
            throw new IllegalStateException("Talisman could not open encrypted bridge storage", e);
        }
        if (getToken() == null) {
            regenerateToken();
        }
    }

    public String getToken() {
        return prefs.getString(KEY_TOKEN, null);
    }

    public String regenerateToken() {
        byte[] bytes = new byte[32];
        new SecureRandom().nextBytes(bytes);
        String token = Base64.encodeToString(bytes, Base64.URL_SAFE | Base64.NO_WRAP | Base64.NO_PADDING);
        prefs.edit().putString(KEY_TOKEN, token).apply();
        return token;
    }

    public boolean validate(String token) {
        if (token == null) return false;
        String stored = getToken();
        if (stored == null || stored.length() != token.length()) return false;
        int diff = 0;
        for (int i = 0; i < stored.length(); i++) {
            diff |= stored.charAt(i) ^ token.charAt(i);
        }
        return diff == 0;
    }
}
