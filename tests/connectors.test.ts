import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { makeDatabase, makeConfig, makeDataDir, makeUser } from "./helpers.js";
import { SecretBox } from "../src/security/secrets.js";
import { CredentialStore } from "../src/connectors/store.js";
import { GoogleCalendar, type GoogleTokens } from "../src/connectors/google.js";
import { createApp } from "../src/api/app.js";
import { AuthService } from "../src/auth/service.js";
import { ArtifactStore } from "../src/workspace/workspace.js";
import { ModelRouter } from "../src/intelligence/router.js";
import { MockProvider } from "../src/intelligence/providers/mock.js";

const KEY = Buffer.alloc(32, 7).toString("base64");

/* --------------------------------------------------------------- crypto */

test("AES-GCM seals credentials and binds them to their tenant and provider", () => {
  const box = new SecretBox(SecretBox.decode(KEY));
  const sealed = box.seal(JSON.stringify({ accessToken: "secret-token" }), "org-1:google:user-1");

  assert.equal(
    box.open(sealed, "org-1:google:user-1"),
    JSON.stringify({ accessToken: "secret-token" }),
  );
  assert.throws(
    () => box.open(sealed, "org-2:google:user-1"),
    /could not be decrypted/,
    "the same ciphertext must not open for another tenant",
  );
  assert.throws(
    () => box.open(sealed, "org-1:gmail:user-1"),
    /could not be decrypted/,
    "the same ciphertext must not open for another provider",
  );

  const tampered = { ...sealed, ciphertext: Buffer.from("different").toString("base64") };
  assert.throws(() => box.open(tampered, "org-1:google:user-1"), /could not be decrypted/);

  const wrongKey = new SecretBox(Buffer.alloc(32, 9));
  assert.throws(() => wrongKey.open(sealed, "org-1:google:user-1"), /could not be decrypted/);

  assert.equal(SecretBox.from(null), null, "no key means no encryption, never plaintext");
  assert.throws(() => new SecretBox(Buffer.alloc(16, 1)), /32 bytes/);
});

test("encrypted credentials are isolated per user and per organisation", async () => {
  const database = await makeDatabase();
  const store = new CredentialStore(database, new SecretBox(SecretBox.decode(KEY)));
  try {
    const alice = await makeUser(database);
    const bob = await makeUser(database);
    await store.save(alice.user.orgId, alice.user.id, "google", { accessToken: "alice-token" });

    assert.deepEqual(
      await store.load(alice.user.orgId, alice.user.id, "google"),
      { accessToken: "alice-token" },
    );
    assert.equal(
      await store.load(bob.user.orgId, bob.user.id, "google"),
      null,
      "a second user must not see another user's token",
    );
    assert.equal(await store.load(alice.user.orgId, bob.user.id, "google"), null);
    assert.equal(await store.has(bob.user.orgId, bob.user.id, "google"), false);

    // The stored row must not contain the plaintext anywhere.
    const raw = await database.query<{ ciphertext: string }>(
      "SELECT ciphertext FROM provider_credentials",
    );
    assert.equal(raw.rows.length, 1);
    assert.ok(!raw.rows[0]!.ciphertext.includes("alice-token"));

    assert.equal(await store.remove(alice.user.orgId, alice.user.id, "google"), true);
    assert.equal(await store.has(alice.user.orgId, alice.user.id, "google"), false);
  } finally {
    await database.close();
  }
});

/* --------------------------------------------------- fake google backend */

interface FakeGoogle {
  server: Server;
  base: string;
  tokenRequests: string[];
  eventQueries: string[];
  created: Array<Record<string, unknown>>;
}

async function fakeGoogle(): Promise<FakeGoogle> {
  const tokenRequests: string[] = [];
  const eventQueries: string[] = [];
  const created: Array<Record<string, unknown>> = [];

  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      const send = (status: number, payload: unknown) => {
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify(payload));
      };

      if (url.pathname === "/token") {
        tokenRequests.push(body);
        const params = new URLSearchParams(body);
        if (params.get("grant_type") === "refresh_token") {
          send(200, {
            access_token: "refreshed-token",
            expires_in: 3600,
            scope: "https://www.googleapis.com/auth/calendar.events",
            token_type: "Bearer",
          });
          return;
        }
        send(200, {
          access_token: "access-token",
          refresh_token: "refresh-token",
          expires_in: 3600,
          scope: "https://www.googleapis.com/auth/calendar.events",
          token_type: "Bearer",
        });
        return;
      }

      if (url.pathname.endsWith("/events")) {
        if (request.headers.authorization === "Bearer rejected-token") {
          send(401, { error: { message: "Invalid Credentials" } });
          return;
        }
        if (request.method === "POST") {
          const parsed = JSON.parse(body || "{}") as Record<string, unknown>;
          created.push(parsed);
          send(200, { id: "created-event", htmlLink: "https://calendar.example/created", ...parsed });
          return;
        }
        eventQueries.push(url.search);
        send(200, {
          items: [
            {
              id: "event-1",
              summary: "Morning standup",
              start: { dateTime: "2026-05-01T09:00:00Z" },
              end: { dateTime: "2026-05-01T09:15:00Z" },
              location: "Room 1",
              attendees: [{ email: "ada@example.com" }],
              htmlLink: "https://calendar.example/event-1",
            },
          ],
        });
        return;
      }

      send(404, { error: { message: "not found" } });
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return {
    server,
    base: `http://127.0.0.1:${address.port}`,
    tokenRequests,
    eventQueries,
    created,
  };
}

function clientFor(fake: FakeGoogle): GoogleCalendar {
  return new GoogleCalendar({
    clientId: "client-id",
    clientSecret: "client-secret",
    authUrl: `${fake.base}/auth`,
    tokenUrl: `${fake.base}/token`,
    calendarBase: `${fake.base}/calendar/v3`,
  });
}

const savedTokens = (): GoogleTokens => ({
  accessToken: "access-token",
  refreshToken: "refresh-token",
  expiresAt: Date.now() + 3_600_000,
  scope: "https://www.googleapis.com/auth/calendar.events",
  tokenType: "Bearer",
});

test("the Calendar client authorises, refreshes, lists and creates events", async () => {
  const fake = await fakeGoogle();
  const google = clientFor(fake);
  try {
    const url = new URL(
      google.authorizeUrl({ redirectUri: "https://talisman.test/api/connectors/google/callback", state: "s-1" }),
    );
    assert.equal(url.searchParams.get("client_id"), "client-id");
    assert.equal(url.searchParams.get("state"), "s-1");
    assert.equal(url.searchParams.get("access_type"), "offline");
    assert.equal(url.searchParams.get("response_type"), "code");
    assert.match(url.searchParams.get("scope") ?? "", /calendar\.events/);

    const exchanged = await google.exchangeCode("code-1", "https://talisman.test/cb");
    assert.equal(exchanged.accessToken, "access-token");
    assert.equal(exchanged.refreshToken, "refresh-token");
    assert.ok(exchanged.expiresAt > Date.now());

    const events = await google.listEvents(exchanged.accessToken, { maxResults: 5 });
    assert.equal(events.length, 1);
    assert.equal(events[0]!.summary, "Morning standup");
    assert.equal(events[0]!.attendees[0], "ada@example.com");
    assert.match(fake.eventQueries[0] ?? "", /singleEvents=true/);
    assert.match(fake.eventQueries[0] ?? "", /maxResults=5/);

    const created = await google.createEvent(exchanged.accessToken, {
      summary: "Design review",
      start: "2026-05-02T10:00:00Z",
      end: "2026-05-02T11:00:00Z",
      attendees: ["ada@example.com"],
    });
    assert.equal(created.id, "created-event");
    assert.equal(fake.created.length, 1);
    assert.equal(fake.created[0]!.summary, "Design review");

    await assert.rejects(
      google.createEvent(exchanged.accessToken, {
        summary: "Backwards",
        start: "2026-05-02T11:00:00Z",
        end: "2026-05-02T10:00:00Z",
      }),
      /end must be after start/,
    );
    await assert.rejects(
      google.createEvent(exchanged.accessToken, {
        summary: "No timezone",
        start: "2026-05-02T10:00:00",
        end: "2026-05-02T11:00:00",
      }),
      /timezone offset/,
    );

    // An expired token refreshes before the call, keeping the refresh token.
    const stale: GoogleTokens = { ...savedTokens(), expiresAt: Date.now() - 1000 };
    const { result, tokens } = await google.call(stale, (token) =>
      google.listEvents(token, { maxResults: 1 }),
    );
    assert.equal(result.length, 1);
    assert.equal(tokens.accessToken, "refreshed-token");
    assert.equal(tokens.refreshToken, "refresh-token");
    assert.equal(fake.tokenRequests.filter((body) => body.includes("refresh_token")).length, 1);

    // A 401 mid-flight refreshes once and retries.
    const rejected: GoogleTokens = { ...savedTokens(), accessToken: "rejected-token" };
    const retried = await google.call(rejected, (token) => google.listEvents(token, {}));
    assert.equal(retried.result.length, 1);
    assert.equal(retried.tokens.accessToken, "refreshed-token");
  } finally {
    fake.server.close();
  }
});

/* ------------------------------------------------------------- http flow */

test("connect, verify and disconnect Google Calendar over the API", async () => {
  const fake = await fakeGoogle();
  const database = await makeDatabase();
  try {
    const config = makeConfig({
      DATA_DIR: await makeDataDir(),
      CREDENTIAL_ENCRYPTION_KEY: KEY,
      GOOGLE_CLIENT_ID: "client-id",
      GOOGLE_CLIENT_SECRET: "client-secret",
    });
    const app = createApp({
      config,
      database,
      auth: new AuthService(database, config.sessionSecret!),
      models: new ModelRouter([new MockProvider([{ text: "ok" }])], { defaultModel: "mock" }),
      artifactStore: new ArtifactStore(config.dataDir),
      google: clientFor(fake),
    });

    const signup = await app.request("/api/auth/signup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: "calendar@example.com",
        password: "a sufficiently long password",
        orgName: "Calendar Org",
      }),
    });
    assert.equal(signup.status, 201);
    const cookie = signup.headers.get("set-cookie")?.split(";")[0];
    assert.ok(cookie);

    const before = await app.request("/api/connectors", { headers: { cookie: cookie! } });
    const beforeBody = (await before.json()) as {
      encryption: boolean;
      connectors: Array<{ configured: boolean; connected: boolean }>;
    };
    assert.equal(beforeBody.encryption, true);
    assert.equal(beforeBody.connectors[0]!.configured, true);
    assert.equal(beforeBody.connectors[0]!.connected, false);

    const authorize = await app.request("/api/connectors/google/authorize", {
      headers: { cookie: cookie! },
    });
    assert.equal(authorize.status, 200);
    const { url } = (await authorize.json()) as { url: string };
    const state = new URL(url).searchParams.get("state");
    assert.ok(state);
    assert.match(url, /response_type=code/);

    const callback = await app.request(
      `/api/connectors/google/callback?code=code-1&state=${encodeURIComponent(state!)}`,
    );
    assert.equal(callback.status, 302);
    assert.match(callback.headers.get("location") ?? "", /status=connected/);

    const after = await app.request("/api/connectors", { headers: { cookie: cookie! } });
    const afterBody = (await after.json()) as { connectors: Array<{ connected: boolean }> };
    assert.equal(afterBody.connectors[0]!.connected, true);

    const verified = await app.request("/api/connectors/google/verify", {
      method: "POST",
      headers: { cookie: cookie! },
    });
    assert.equal(verified.status, 200);
    const verifiedBody = (await verified.json()) as { ok: boolean; events: number };
    assert.equal(verifiedBody.ok, true);
    assert.equal(verifiedBody.events, 1);

    // A forged or expired state must never be accepted.
    const forged = await app.request(
      "/api/connectors/google/callback?code=code-1&state=forged.signature",
    );
    assert.equal(forged.status, 403);

    // A second user has no connection and cannot use the first user's tokens.
    const other = await app.request("/api/auth/signup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: "other@example.com",
        password: "a sufficiently long password",
        orgName: "Other Org",
      }),
    });
    const otherCookie = other.headers.get("set-cookie")?.split(";")[0];
    const otherStatus = await app.request("/api/connectors", {
      headers: { cookie: otherCookie! },
    });
    const otherBody = (await otherStatus.json()) as { connectors: Array<{ connected: boolean }> };
    assert.equal(otherBody.connectors[0]!.connected, false);
    const otherVerify = await app.request("/api/connectors/google/verify", {
      method: "POST",
      headers: { cookie: otherCookie! },
    });
    assert.equal(otherVerify.status, 409);

    const removed = await app.request("/api/connectors/google", {
      method: "DELETE",
      headers: { cookie: cookie! },
    });
    assert.equal(removed.status, 200);
    const finalState = await app.request("/api/connectors", { headers: { cookie: cookie! } });
    const finalBody = (await finalState.json()) as { connectors: Array<{ connected: boolean }> };
    assert.equal(finalBody.connectors[0]!.connected, false);
  } finally {
    fake.server.close();
    await database.close();
  }
});

test("connector endpoints fail closed when Google or the encryption key is missing", async () => {
  const database = await makeDatabase();
  try {
    const config = makeConfig({ DATA_DIR: await makeDataDir() });
    const app = createApp({
      config,
      database,
      auth: new AuthService(database, config.sessionSecret!),
      models: new ModelRouter([new MockProvider([{ text: "ok" }])], { defaultModel: "mock" }),
      artifactStore: new ArtifactStore(config.dataDir),
    });
    const signup = await app.request("/api/auth/signup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: "no-google@example.com",
        password: "a sufficiently long password",
        orgName: "No Google",
      }),
    });
    const cookie = signup.headers.get("set-cookie")?.split(";")[0];

    const status = await app.request("/api/connectors", { headers: { cookie: cookie! } });
    const body = (await status.json()) as {
      encryption: boolean;
      connectors: Array<{ configured: boolean; connected: boolean }>;
    };
    assert.equal(body.encryption, false);
    assert.equal(body.connectors[0]!.configured, false);
    assert.equal(body.connectors[0]!.connected, false);

    const authorize = await app.request("/api/connectors/google/authorize", {
      headers: { cookie: cookie! },
    });
    assert.equal(authorize.status, 503);

    // With no encryption key the store refuses to operate at all, so the
    // request fails closed as unavailable rather than pretending it is merely
    // "not connected".
    const verify = await app.request("/api/connectors/google/verify", {
      method: "POST",
      headers: { cookie: cookie! },
    });
    assert.equal(verify.status, 503);
  } finally {
    await database.close();
  }
});
