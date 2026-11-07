package com.clawuse.android;

import org.json.JSONArray;
import org.json.JSONObject;

import java.net.URI;
import java.util.Arrays;
import java.util.List;

/**
 * Rules that hold even if the server sends the wrong command.
 *
 * The denylist is deliberately local. It is the last line of defence for
 * banking, password managers and authenticators, and it does not depend on a
 * setting or a network round trip.
 */
final class SafetyPolicy {
    private static final List<String> DENIED = Arrays.asList(
            // Banking and payments
            "com.chase", "com.bankofamerica", "com.wellsfargo", "com.citi",
            "com.capitalone", "com.americanexpress", "com.discover", "com.schwab",
            "com.fidelity", "com.robinhood", "com.usbank", "com.tdbank",
            "com.navyfederal", "com.sofi", "com.creditonebank", "com.merrickbank",
            "com.paypal", "com.venmo", "com.squareup.cash", "com.coinbase",
            "com.binance", "com.revolut", "com.monzo", "com.n26", "com.wise",
            "com.visa", "com.mastercard", "com.stripe",
            // Password managers and authenticators
            "com.onepassword", "com.bitwarden", "com.lastpass", "com.dashlane",
            "com.keepersecurity", "com.google.android.apps.authenticator2",
            "com.microsoft.authenticator", "com.authy", "com.duosecurity"
    );

    private SafetyPolicy() {}

    static boolean isDenied(String packageName) {
        if (packageName == null || packageName.isEmpty()) return true;
        String normalized = packageName.toLowerCase();
        for (String prefix : DENIED) {
            if (normalized.equals(prefix) || normalized.startsWith(prefix + ".")) return true;
        }
        return false;
    }

    static void requirePackage(String packageName) throws AgentFailure {
        if (packageName == null || packageName.isEmpty()) throw new AgentFailure("no_foreground_app");
        if (isDenied(packageName)) throw new AgentFailure("denied_package");
    }

    /** Password fields and explicit secure flags never leave the phone. */
    static void requireNotSecure(JSONObject screen) throws AgentFailure {
        if (screen == null) return;
        if (screen.optBoolean("secure", false)) throw new AgentFailure("secure_window");
        JSONArray elements = screen.optJSONArray("elements");
        if (elements == null) elements = screen.optJSONArray("nodes");
        if (elements == null) return;
        for (int i = 0; i < elements.length(); i++) {
            JSONObject element = elements.optJSONObject(i);
            if (element != null && element.optBoolean("password", false)) {
                throw new AgentFailure("secure_window");
            }
        }
    }

    static void requireSafeUri(String uri) throws AgentFailure {
        if (uri == null || uri.isEmpty()) throw new AgentFailure("invalid_deep_link");
        try {
            URI parsed = URI.create(uri);
            String scheme = parsed.getScheme();
            if (scheme == null) throw new AgentFailure("invalid_deep_link");
            String lower = scheme.toLowerCase();
            if (lower.equals("file") || lower.equals("content")
                    || lower.equals("javascript") || lower.equals("intent")) {
                throw new AgentFailure("denied_deep_link");
            }
        } catch (IllegalArgumentException e) {
            throw new AgentFailure("invalid_deep_link");
        }
    }
}
