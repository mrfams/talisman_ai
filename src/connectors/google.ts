import { errors } from "../core/errors.js";

/**
 * Google Calendar over the REST API.
 *
 * The request shapes follow OpenMuse's Calendar adapter (`vendor/openmuse/
 * packages/integrations/src/google.ts`): the v3 events collection, the same
 * calendar id validation, and `singleEvents` ordering. Talisman adds OAuth token
 * refresh, encrypted per-user storage and a bounded tool surface.
 */

export const CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar.events";
const DEFAULT_CALENDAR_BASE = "https://www.googleapis.com/calendar/v3";
const DEFAULT_TOKEN_URL = "https://oauth2.googleapis.com/token";
const DEFAULT_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_ATTENDEES = 50;

export interface GoogleTokens {
  accessToken: string;
  refreshToken: string | null;
  /** Epoch milliseconds. */
  expiresAt: number;
  scope: string;
  tokenType: string;
}

export interface CalendarEventSummary {
  id: string;
  summary: string;
  start: string;
  end: string;
  location: string;
  attendees: string[];
  htmlLink: string | null;
}

export interface CalendarEventDraft {
  calendarId?: string;
  summary: string;
  description?: string;
  location?: string;
  start: string;
  end: string;
  timeZone?: string;
  attendees?: string[];
}

export interface ListEventsOptions {
  calendarId?: string;
  timeMin?: string;
  timeMax?: string;
  maxResults?: number;
}

export class GoogleApiError extends Error {
  constructor(
    readonly status: number,
    detail: string,
  ) {
    super(`Google API (${status}): ${detail}`);
    this.name = "GoogleApiError";
  }
}

export interface GoogleConnectorOptions {
  clientId: string | null;
  clientSecret: string | null;
  authUrl?: string;
  tokenUrl?: string;
  calendarBase?: string;
  fetchImpl?: typeof fetch;
}

const CALENDAR_ID_SAFE = /^[A-Za-z0-9@._+-]{1,1024}$/;

function calendarPath(calendarId: string): string {
  const id = calendarId || "primary";
  if (
    !CALENDAR_ID_SAFE.test(id) ||
    id === "." ||
    id === ".." ||
    Array.from(id).some((character) => character.charCodeAt(0) <= 32 || character.charCodeAt(0) === 127)
  ) {
    throw errors.invalid("Invalid Google calendar id");
  }
  return `calendars/${encodeURIComponent(id)}/events`;
}

function isoInstant(value: string, field: string): Date {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw errors.invalid(`${field} must be an ISO date-time`);
  if (!/[zZ]|[+-]\d{2}:\d{2}$/.test(value)) {
    throw errors.invalid(`${field} must include a timezone offset (for example 2026-05-01T09:00:00Z)`);
  }
  return parsed;
}

function singleLine(value: string, field: string, max: number): string {
  if (Array.from(value).some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) {
    throw errors.invalid(`Invalid ${field}: control characters are not allowed`);
  }
  if (value.length > max) throw errors.invalid(`${field} is too long`);
  return value;
}

export class GoogleCalendar {
  readonly scopes = [CALENDAR_SCOPE];
  private readonly fetchImpl: typeof fetch;
  private readonly authUrl: string;
  private readonly tokenUrl: string;
  private readonly calendarBase: string;

  constructor(private readonly options: GoogleConnectorOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.authUrl = options.authUrl ?? DEFAULT_AUTH_URL;
    this.tokenUrl = options.tokenUrl ?? DEFAULT_TOKEN_URL;
    this.calendarBase = (options.calendarBase ?? DEFAULT_CALENDAR_BASE).replace(/\/$/, "");
  }

  get configured(): boolean {
    return Boolean(this.options.clientId && this.options.clientSecret);
  }

  authorizeUrl(input: { redirectUri: string; state: string }): string {
    if (!this.configured) throw errors.unavailable("Google OAuth is not configured on this deployment");
    const url = new URL(this.authUrl);
    url.searchParams.set("client_id", this.options.clientId!);
    url.searchParams.set("redirect_uri", input.redirectUri);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", this.scopes.join(" "));
    url.searchParams.set("state", input.state);
    // offline + consent guarantees a refresh token, which the connector needs to
    // keep working after the first hour.
    url.searchParams.set("access_type", "offline");
    url.searchParams.set("prompt", "consent");
    return url.toString();
  }

  private async tokenRequest(params: Record<string, string>): Promise<GoogleTokens> {
    const response = await this.fetchImpl(this.tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({
        client_id: this.options.clientId!,
        client_secret: this.options.clientSecret!,
        ...params,
      }).toString(),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const payload = (await response.json().catch(() => null)) as
      | {
          access_token?: string;
          refresh_token?: string;
          expires_in?: number;
          scope?: string;
          token_type?: string;
          error?: string;
          error_description?: string;
        }
      | null;
    if (!response.ok || !payload?.access_token) {
      const detail = payload?.error_description ?? payload?.error ?? `HTTP ${response.status}`;
      throw new GoogleApiError(response.status, `token exchange failed: ${detail}`);
    }
    return {
      accessToken: payload.access_token,
      refreshToken: payload.refresh_token ?? null,
      expiresAt: Date.now() + Math.max(60, payload.expires_in ?? 3600) * 1000,
      scope: payload.scope ?? CALENDAR_SCOPE,
      tokenType: payload.token_type ?? "Bearer",
    };
  }

  exchangeCode(code: string, redirectUri: string): Promise<GoogleTokens> {
    if (!this.configured) throw errors.unavailable("Google OAuth is not configured on this deployment");
    return this.tokenRequest({ grant_type: "authorization_code", code, redirect_uri: redirectUri });
  }

  async refresh(tokens: GoogleTokens): Promise<GoogleTokens> {
    if (!tokens.refreshToken) throw errors.forbidden("Google access expired; reconnect the connector");
    const refreshed = await this.tokenRequest({
      grant_type: "refresh_token",
      refresh_token: tokens.refreshToken,
    });
    // Google does not repeat the refresh token on refresh.
    return { ...refreshed, refreshToken: refreshed.refreshToken ?? tokens.refreshToken };
  }

  private async fresh(tokens: GoogleTokens): Promise<{ token: string; tokens: GoogleTokens }> {
    if (tokens.expiresAt - 60_000 > Date.now()) {
      return { token: tokens.accessToken, tokens };
    }
    const next = await this.refresh(tokens);
    return { token: next.accessToken, tokens: next };
  }

  /**
   * Runs an API call with a valid access token, refreshing once before the call
   * and once more if Google rejects the token. Returns the tokens that are now
   * current so the caller can persist a rotation.
   */
  async call<T>(
    tokens: GoogleTokens,
    fn: (accessToken: string) => Promise<T>,
  ): Promise<{ result: T; tokens: GoogleTokens }> {
    const first = await this.fresh(tokens);
    try {
      return { result: await fn(first.token), tokens: first.tokens };
    } catch (error) {
      if (error instanceof GoogleApiError && error.status === 401 && first.tokens.refreshToken) {
        const next = await this.refresh(first.tokens);
        return { result: await fn(next.accessToken), tokens: next };
      }
      throw error;
    }
  }

  private async request(token: string, path: string, init: RequestInit = {}): Promise<unknown> {
    const response = await this.fetchImpl(`${this.calendarBase}/${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/json",
        ...(init.body ? { "content-type": "application/json" } : {}),
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const payload = (await response.json().catch(() => null)) as
      | { error?: { message?: string } }
      | null;
    if (!response.ok) {
      throw new GoogleApiError(response.status, payload?.error?.message ?? `HTTP ${response.status}`);
    }
    return payload;
  }

  async listEvents(token: string, options: ListEventsOptions = {}): Promise<CalendarEventSummary[]> {
    const query = new URLSearchParams({
      singleEvents: "true",
      orderBy: "startTime",
      maxResults: String(Math.min(100, Math.max(1, options.maxResults ?? 10))),
    });
    if (options.timeMin) query.set("timeMin", isoInstant(options.timeMin, "timeMin").toISOString());
    if (options.timeMax) query.set("timeMax", isoInstant(options.timeMax, "timeMax").toISOString());
    const payload = (await this.request(
      token,
      `${calendarPath(options.calendarId ?? "primary")}?${query.toString()}`,
      { method: "GET" },
    )) as { items?: unknown[] } | null;
    const items = Array.isArray(payload?.items) ? payload.items : [];
    return items.map((raw) => this.normaliseEvent(raw as Record<string, unknown>));
  }

  private normaliseEvent(raw: Record<string, unknown>): CalendarEventSummary {
    const start = (raw.start ?? {}) as { dateTime?: string; date?: string };
    const end = (raw.end ?? {}) as { dateTime?: string; date?: string };
    const attendees = Array.isArray(raw.attendees) ? raw.attendees : [];
    return {
      id: String(raw.id ?? ""),
      summary: String(raw.summary ?? "(untitled)").slice(0, 500),
      start: start.dateTime ?? start.date ?? "",
      end: end.dateTime ?? end.date ?? "",
      location: String(raw.location ?? "").slice(0, 500),
      attendees: attendees
        .map((entry) => String((entry as { email?: unknown }).email ?? ""))
        .filter(Boolean)
        .slice(0, MAX_ATTENDEES),
      htmlLink: typeof raw.htmlLink === "string" ? raw.htmlLink : null,
    };
  }

  async createEvent(token: string, draft: CalendarEventDraft): Promise<CalendarEventSummary> {
    const summary = singleLine(draft.summary?.trim() ?? "", "summary", 500);
    if (!summary) throw errors.invalid("summary is required");
    const start = isoInstant(draft.start, "start");
    const end = isoInstant(draft.end, "end");
    if (end.getTime() <= start.getTime()) throw errors.invalid("end must be after start");
    if (end.getTime() - start.getTime() > 7 * 24 * 60 * 60 * 1000) {
      throw errors.invalid("events longer than 7 days cannot be created here");
    }
    const attendees = (draft.attendees ?? []).slice(0, MAX_ATTENDEES).map((email) => {
      const trimmed = email.trim();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(trimmed)) throw errors.invalid(`Invalid attendee: ${email}`);
      return { email: trimmed };
    });
    const body = {
      summary,
      ...(draft.description
        ? { description: singleLine(draft.description, "description", 4000) }
        : {}),
      ...(draft.location ? { location: singleLine(draft.location, "location", 500) } : {}),
      start: { dateTime: start.toISOString(), ...(draft.timeZone ? { timeZone: draft.timeZone } : {}) },
      end: { dateTime: end.toISOString(), ...(draft.timeZone ? { timeZone: draft.timeZone } : {}) },
      ...(attendees.length > 0 ? { attendees } : {}),
    };
    const payload = await this.request(
      token,
      `${calendarPath(draft.calendarId ?? "primary")}?sendUpdates=none`,
      { method: "POST", body: JSON.stringify(body) },
    );
    return this.normaliseEvent((payload ?? {}) as Record<string, unknown>);
  }
}
