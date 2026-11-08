import { useCallback, useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Check,
  Clock3,
  Pause,
  Phone,
  Play,
  RefreshCw,
  ShieldCheck,
  Trash2,
  Wifi,
  WifiOff,
  X,
} from "lucide-react";
import {
  api,
  type PhoneApproval,
  type PhoneDevice,
  type PhonePairing,
  type PhoneStatus,
} from "../lib/api";
import { errorMessage } from "../lib/queries";
import { Badge, Button, Card, Empty, Input, Notice, Skeleton, timeAgo } from "../ui";

interface Box {
  text: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

function boundsOf(value: unknown): { x: number; y: number; w: number; h: number } {
  if (!value || typeof value !== "object") return { x: 0, y: 0, w: 0, h: 0 };
  const box = value as Record<string, unknown>;
  return {
    x: Number(box.x ?? box.left ?? 0),
    y: Number(box.y ?? box.top ?? 0),
    w: Number(box.w ?? box.width ?? 0),
    h: Number(box.h ?? box.height ?? 0),
  };
}

function boxesFrom(result: unknown): Box[] {
  if (!result || typeof result !== "object") return [];
  const record = result as Record<string, unknown>;
  const screen =
    record.screen && typeof record.screen === "object"
      ? (record.screen as Record<string, unknown>)
      : null;
  const nodes = screen?.nodes;
  if (!Array.isArray(nodes)) return [];
  return nodes
    .map((node) => (node && typeof node === "object" ? (node as Record<string, unknown>) : null))
    .filter((node): node is Record<string, unknown> => Boolean(node))
    .map((node) => {
      const text = String(
        node.text ?? node.label ?? node.desc ?? node.contentDescription ?? "",
      ).trim();
      const bounds = boundsOf(node.bounds);
      return { text, ...bounds };
    })
    .filter((box) => box.text.length > 0);
}

function formatCode(code: string): string {
  const compact = code.replace(/-/g, "");
  return compact.length === 8 ? `${compact.slice(0, 4)}-${compact.slice(4)}` : code;
}

function statusTone(device: PhoneDevice): "ok" | "warn" | "bad" {
  if (device.status === "active") return device.online ? "ok" : "warn";
  if (device.status === "paused") return "warn";
  return "bad";
}

function statusLabel(device: PhoneDevice): string {
  if (device.status === "revoked") return "Revoked";
  if (device.status === "paused") return "Paused";
  return device.online ? "Online" : "Waiting";
}

function planPreview(approval: PhoneApproval): string[] {
  const raw = approval.args.steps;
  if (!Array.isArray(raw)) return [];
  return raw
    .map((entry) => {
      if (!entry || typeof entry !== "object") return "";
      const step = entry as Record<string, unknown>;
      const wait =
        step.wait_for && typeof step.wait_for === "object"
          ? String((step.wait_for as Record<string, unknown>).text ?? "").trim()
          : "";
      const then =
        step.then && typeof step.then === "object"
          ? (step.then as Record<string, unknown>)
          : null;
      if (!then) return "";
      const action = String(then.action ?? "");
      const label =
        action === "tap_text"
          ? `tap “${String(then.text ?? "")}”`
          : action === "tap"
            ? `tap (${String(then.x ?? 0)}, ${String(then.y ?? 0)})`
            : action === "global"
              ? `press ${String(then.name ?? "")}`
              : action === "none"
                ? "continue"
                : action;
      return `${wait ? `wait for “${wait}” then ` : ""}${label}`;
    })
    .filter(Boolean);
}

function PendingPhoneApprovals({ devices }: { devices: PhoneDevice[] }) {
  const client = useQueryClient();
  const [note, setNote] = useState<{ tone: "neutral" | "warn" | "bad"; text: string } | null>(null);
  const query = useQuery({
    queryKey: ["phone-approvals"],
    queryFn: () => api.phoneApprovals("pending"),
    refetchInterval: 5_000,
  });
  const decide = useMutation({
    mutationFn: (input: { id: string; decision: "approved" | "denied" }) =>
      api.decidePhoneApproval(input.id, input.decision),
    onSuccess: async (result, input) => {
      await client.invalidateQueries({ queryKey: ["phone-approvals"] });
      await client.invalidateQueries({ queryKey: ["devices"] });
      await client.invalidateQueries({ queryKey: ["notifications"] });
      if (input.decision === "denied") {
        setNote({ tone: "neutral", text: "Refused. Nothing was sent to the phone." });
      } else if (result.command?.status === "done") {
        setNote({ tone: "neutral", text: "The phone completed the approved plan." });
      } else if (result.command?.status === "error") {
        setNote({
          tone: "bad",
          text: `The phone rejected the plan: ${result.command.error ?? "unknown error"}`,
        });
      } else {
        setNote({ tone: "warn", text: "Approved and queued. Keep the companion open." });
      }
    },
    onError: (error) => setNote({ tone: "bad", text: errorMessage(error) }),
  });

  const approvals = query.data?.approvals ?? [];
  if (!query.isLoading && approvals.length === 0) return null;

  return (
    <Card flush>
      <div className="card-head">
        <div className="row" style={{ gap: 9, minWidth: 0 }}>
          <span className="provider-icon" style={{ width: 30, height: 30 }}>
            <ShieldCheck size={14} />
          </span>
          <div>
            <div className="provider-name">Phone approvals</div>
            <div className="tiny faint">One approval covers the exact plan below.</div>
          </div>
        </div>
        {approvals.length ? <Badge tone="warn">{approvals.length} waiting</Badge> : null}
      </div>
      <div className="card-body stack" style={{ gap: 10 }}>
        {note ? <Notice tone={note.tone}>{note.text}</Notice> : null}
        {query.isLoading ? <Skeleton h={70} /> : null}
        {approvals.map((approval) => {
          const device = devices.find((item) => item.id === approval.deviceId);
          const plan = planPreview(approval);
          return (
            <div key={approval.id} className="panel" style={{ padding: 12 }}>
              <div className="row-between wrap" style={{ gap: 10, alignItems: "flex-start" }}>
                <div style={{ minWidth: 0 }}>
                  <div className="small" style={{ fontWeight: 600 }}>
                    {approval.summary}
                  </div>
                  <div className="tiny faint" style={{ marginTop: 3 }}>
                    {device?.name ?? "Paired phone"} · expires{" "}
                    {new Date(approval.expiresAt).toLocaleTimeString([], {
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </div>
                  {plan.length ? (
                    <ol className="plan-list">
                      {plan.map((step, index) => (
                        <li key={`${approval.id}-${index}`}>{step}</li>
                      ))}
                    </ol>
                  ) : null}
                </div>
                <div className="row" style={{ gap: 6 }}>
                  <Button
                    size="sm"
                    variant="primary"
                    icon={<Check size={12} />}
                    busy={decide.isPending}
                    onClick={() => {
                      setNote(null);
                      decide.mutate({ id: approval.id, decision: "approved" });
                    }}
                  >
                    Allow once
                  </Button>
                  <Button
                    size="sm"
                    icon={<X size={12} />}
                    busy={decide.isPending}
                    onClick={() => {
                      setNote(null);
                      decide.mutate({ id: approval.id, decision: "denied" });
                    }}
                  >
                    Refuse
                  </Button>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </Card>
  );
}

function PairPanel({ onClose }: { onClose?: () => void }) {
  const client = useQueryClient();
  const [name, setName] = useState("My Android phone");
  const [pairing, setPairing] = useState<PhonePairing | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  async function start() {
    const trimmed = name.trim();
    if (!trimmed) {
      setProblem("Give the phone a name first.");
      return;
    }
    setBusy(true);
    setProblem(null);
    try {
      const started = await api.startPhonePairing({ platform: "android", name: trimmed });
      setPairing(started);
      await client.invalidateQueries({ queryKey: ["devices"] });
    } catch (error) {
      setProblem(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function copy() {
    if (!pairing) return;
    try {
      await navigator.clipboard.writeText(formatCode(pairing.code));
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard access is optional; the code is always visible.
    }
  }

  return (
    <Card>
      <div className="row-between" style={{ alignItems: "flex-start", gap: 12 }}>
        <div className="stack" style={{ gap: 4 }}>
          <h2 className="section-title">Pair your Android phone</h2>
          <p className="small muted" style={{ maxWidth: 620, lineHeight: 1.55 }}>
            Install the Talisman Companion app on the phone, open it, and enter the code below.
            The phone polls outbound, so it works on Wi-Fi or mobile data and never needs a port
            forwarded to this server.
          </p>
        </div>
        {onClose ? (
          <Button size="sm" variant="quiet" onClick={onClose}>
            Close
          </Button>
        ) : null}
      </div>

      {problem ? <Notice tone="bad">{problem}</Notice> : null}

      {pairing ? (
        <div className="panel" style={{ marginTop: 14, padding: 16 }}>
          <div className="row-between wrap" style={{ gap: 12 }}>
            <div className="stack" style={{ gap: 2 }}>
              <div className="tiny faint">Pairing code</div>
              <button
                className="mono"
                onClick={() => void copy()}
                title="Copy pairing code"
                style={{
                  background: "none",
                  border: 0,
                  color: "var(--text)",
                  cursor: "pointer",
                  fontSize: "clamp(24px, 4vw, 34px)",
                  letterSpacing: "0.14em",
                  padding: 0,
                  textAlign: "left",
                }}
              >
                {formatCode(pairing.code)}
              </button>
              <div className="tiny faint">
                {copied ? "Copied. " : "Tap the code to copy. "}
                Expires at {new Date(pairing.expiresAt).toLocaleTimeString([], {
                  hour: "2-digit",
                  minute: "2-digit",
                })}
                .
              </div>
            </div>
            <div className="stack" style={{ gap: 3, minWidth: 0 }}>
              <div className="tiny faint">Companion server</div>
              <code className="mono tiny truncate" style={{ maxWidth: 320 }}>
                {pairing.server}
              </code>
              <div className="tiny faint">
                The app verifies this host before it sends the one-time claim.
              </div>
            </div>
          </div>
          <p className="tiny faint" style={{ margin: "12px 0 0", lineHeight: 1.5 }}>
            The code is single-use and expires in five minutes. This page will show the phone as
            soon as it claims the code.
          </p>
        </div>
      ) : (
        <div className="row wrap" style={{ marginTop: 14, gap: 8, alignItems: "flex-end" }}>
          <label className="stack grow" style={{ gap: 4, minWidth: 220 }}>
            <span className="label">Phone name</span>
            <Input
              value={name}
              maxLength={80}
              onChange={(event) => setName(event.target.value)}
              placeholder="My Android phone"
            />
          </label>
          <Button variant="primary" busy={busy} onClick={() => void start()}>
            Create pairing code
          </Button>
        </div>
      )}

      <p className="tiny faint" style={{ marginTop: 12 }}>
        Android only for now. iPhone control is not available in this build.
      </p>
    </Card>
  );
}

function PhoneActions({ device, onDone }: { device: PhoneDevice; onDone: () => void }) {
  const [apps, setApps] = useState<Array<{ package: string; label: string }> | null>(null);
  const [selected, setSelected] = useState("");
  const [approval, setApproval] = useState<PhoneApproval | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<{
    tone: "neutral" | "warn" | "bad";
    text: string;
  } | null>(null);

  const appsLoading = useRef(false);

  async function loadApps(quiet = false) {
    if (appsLoading.current) return;
    appsLoading.current = true;
    if (!quiet) {
      setBusy("apps");
      setNote(null);
    }
    try {
      const response = await api.companionOp(device.id, "apps");
      const result = response.result as { apps?: Array<{ package?: string; label?: string }> };
      const found = (result.apps ?? [])
        .filter((app): app is { package: string; label?: string } => Boolean(app.package))
        .map((app) => ({ package: app.package, label: app.label || app.package }))
        .sort((a, b) => a.label.localeCompare(b.label));
      setApps(found);
      if (!found.length && !quiet) {
        setNote({ tone: "warn", text: "The phone returned no installed apps." });
      }
    } catch (error) {
      setNote({ tone: "bad", text: errorMessage(error) });
    } finally {
      appsLoading.current = false;
      if (!quiet) setBusy(null);
    }
  }

  // Apps change rarely, but the list should already be there when the page opens.
  useEffect(() => {
    if (!device.online || apps !== null) return;
    void loadApps(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [device.online]);

  async function request(args: Record<string, unknown>) {
    setBusy("request");
    setNote(null);
    try {
      const started = await api.requestPhoneAction(device.id, "act", args);
      setApproval(started.approval);
    } catch (error) {
      setNote({ tone: "bad", text: errorMessage(error) });
    } finally {
      setBusy(null);
    }
  }

  async function decide(decision: "approved" | "denied") {
    if (!approval) return;
    setBusy(decision);
    setNote(null);
    try {
      const result = await api.decidePhoneApproval(approval.id, decision);
      setApproval(null);
      if (decision === "denied") {
        setNote({ tone: "neutral", text: "Refused. Nothing was sent to the phone." });
      } else if (result.command?.status === "done") {
        setNote({ tone: "neutral", text: "The phone completed the action." });
        onDone();
      } else if (result.command?.status === "error") {
        setNote({
          tone: "bad",
          text: `The phone rejected it: ${result.command.error ?? "unknown error"}`,
        });
      } else {
        setNote({
          tone: "warn",
          text: "Approved and queued. The phone has not answered yet; keep the companion open.",
        });
      }
    } catch (error) {
      setNote({ tone: "bad", text: errorMessage(error) });
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="panel" style={{ padding: 14 }}>
      <div className="row-between wrap" style={{ gap: 10 }}>
        <div>
          <h3 className="section-title">Phone actions</h3>
          <p className="tiny faint" style={{ margin: "4px 0 0", lineHeight: 1.5 }}>
            A real action, not a preview. It is queued only after you press Allow once.
          </p>
        </div>
        {approval ? <Badge tone="warn">Waiting for you</Badge> : null}
      </div>

      {note ? <Notice tone={note.tone}>{note.text}</Notice> : null}

      {approval ? (
        <div className="stack" style={{ gap: 10, marginTop: 12 }}>
          <div className="small" style={{ fontWeight: 600 }}>
            {approval.summary}
          </div>
          <div className="tiny faint">
            One action only. Expires{" "}
            {new Date(approval.expiresAt).toLocaleTimeString([], {
              hour: "2-digit",
              minute: "2-digit",
            })}
            .
          </div>
          <div className="row wrap" style={{ gap: 8 }}>
            <Button
              size="sm"
              variant="primary"
              icon={<ShieldCheck size={12} />}
              busy={busy === "approved"}
              onClick={() => void decide("approved")}
            >
              Allow once
            </Button>
            <Button
              size="sm"
              busy={busy === "denied"}
              onClick={() => void decide("denied")}
            >
              Refuse
            </Button>
          </div>
        </div>
      ) : (
        <div className="row wrap" style={{ gap: 8, marginTop: 12, alignItems: "center" }}>
          {apps ? (
            <>
              <select
                className="select"
                aria-label="App to open"
                value={selected}
                onChange={(event) => setSelected(event.target.value)}
                style={{ minWidth: 200, maxWidth: 300 }}
              >
                <option value="">Choose an app</option>
                {apps.map((app) => (
                  <option key={app.package} value={app.package}>
                    {app.label}
                  </option>
                ))}
              </select>
              <Button
                size="sm"
                variant="primary"
                busy={busy === "request"}
                disabled={!selected || !device.online}
                onClick={() => void request({ action: "launch", package: selected })}
              >
                Request open
              </Button>
            </>
          ) : (
            <Button
              size="sm"
              busy={busy === "apps"}
              disabled={!device.online}
              onClick={() => void loadApps()}
            >
              Choose an app
            </Button>
          )}
          <Button
            size="sm"
            busy={busy === "request"}
            disabled={!device.online}
            onClick={() => void request({ action: "global", name: "home" })}
          >
            Home
          </Button>
        </div>
      )}
    </div>
  );
}

function CompanionCard({ device }: { device: PhoneDevice }) {
  const client = useQueryClient();
  const [boxes, setBoxes] = useState<Box[]>([]);
  const [revision, setRevision] = useState(0);
  const [frameOk, setFrameOk] = useState(true);
  const [looking, setLooking] = useState(false);
  const [live, setLive] = useState(true);
  const [syncedAt, setSyncedAt] = useState<string | null>(null);
  const [managing, setManaging] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const observing = useRef(false);
  const mounted = useRef(true);

  const diagnostics = device.diagnostics;
  const battery =
    typeof diagnostics.battery === "number"
      ? `${Math.round(diagnostics.battery * 100)}%`
      : null;
  const screen = typeof diagnostics.screen === "string" ? diagnostics.screen : null;
  const locked = typeof diagnostics.locked === "boolean" ? diagnostics.locked : null;

  const observe = useCallback(
    async (manual: boolean) => {
      if (observing.current) return;
      observing.current = true;
      if (manual) setLooking(true);
      try {
        const response = await api.companionOp(device.id, "observe", { screenshot: true });
        if (!mounted.current) return;
        setBoxes(boxesFrom(response.result));
        setFrameOk(true);
        setRevision(Date.now());
        setSyncedAt(new Date().toISOString());
        setProblem(null);
      } catch (error) {
        if (!mounted.current) return;
        setProblem(errorMessage(error));
        // A locked screen or a sleeping phone must not spin the live loop forever.
        if (!manual) setLive(false);
      } finally {
        observing.current = false;
        if (manual && mounted.current) setLooking(false);
      }
    },
    [device.id],
  );

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // Live view: observe sequentially, so a slow phone never builds a backlog.
  useEffect(() => {
    if (!device.online || !live) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = async () => {
      if (cancelled) return;
      if (document.visibilityState === "visible") await observe(false);
      if (!cancelled) timer = setTimeout(tick, 2_500);
    };
    timer = setTimeout(tick, 400);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [device.online, live, observe]);

  async function manage(action: "pause" | "resume" | "revoke") {
    if (
      action === "revoke" &&
      !window.confirm(`Revoke ${device.name}? The phone will stop receiving commands.`)
    ) {
      return;
    }
    setManaging(action);
    setProblem(null);
    try {
      if (action === "pause") await api.pauseDevice(device.id);
      else if (action === "resume") await api.resumeDevice(device.id);
      else await api.revokeDevice(device.id);
      await client.invalidateQueries({ queryKey: ["devices"] });
    } catch (error) {
      setProblem(errorMessage(error));
    } finally {
      setManaging(null);
    }
  }

  return (
    <Card flush>
      <div className="card-head">
        <div className="row" style={{ gap: 9, minWidth: 0 }}>
          <span className="provider-icon" style={{ width: 30, height: 30 }}>
            <Phone size={14} />
          </span>
          <div style={{ minWidth: 0 }}>
            <div className="provider-name truncate">{device.name}</div>
            <div className="tiny faint truncate">
              {device.model ?? "Android device"}
              {device.osVersion ? ` · Android ${device.osVersion}` : ""}
              {device.appVersion ? ` · app ${device.appVersion}` : ""}
            </div>
          </div>
        </div>
        <div className="row wrap" style={{ gap: 8 }}>
          <Badge tone={statusTone(device)}>{statusLabel(device)}</Badge>
          <Badge tone="plain">
            {device.online ? <Wifi size={11} /> : <WifiOff size={11} />}{" "}
            {device.online ? "Connected" : "No heartbeat"}
          </Badge>
          {live && device.online ? <Badge tone="live">Live</Badge> : null}
          <Button
            size="sm"
            icon={live ? <Pause size={12} /> : <Play size={12} />}
            disabled={!device.online}
            onClick={() => setLive((current) => !current)}
          >
            {live ? "Pause live" : "Go live"}
          </Button>
          <Button
            size="sm"
            icon={<RefreshCw size={12} />}
            busy={looking}
            disabled={!device.online}
            onClick={() => void observe(true)}
          >
            Look
          </Button>
        </div>
      </div>

      <div className="card-body stack" style={{ gap: "var(--space-4)" }}>
        {problem ? <Notice tone="bad">{problem}</Notice> : null}

        <div className="row wrap" style={{ gap: 14 }}>
          <span className="tiny faint row" style={{ gap: 5 }}>
            <Clock3 size={12} /> Seen {timeAgo(device.lastSeenAt)}
          </span>
          {syncedAt ? <span className="tiny faint">Frame {timeAgo(syncedAt)}</span> : null}
          {battery ? <span className="tiny faint">Battery {battery}</span> : null}
          {screen ? <span className="tiny faint">Screen {screen}</span> : null}
          {locked === true ? <span className="tiny faint">Locked</span> : null}
          {device.status === "paused" ? (
            <span className="tiny faint">Paused by you; queued commands were cancelled.</span>
          ) : null}
        </div>

        <div className="grid-2" style={{ alignItems: "start" }}>
          <div>
            {device.online && frameOk ? (
              <div className="device-frame">
                <img
                  key={revision}
                  src={api.deviceFrameUrl(device.id, revision)}
                  alt={`${device.name} screen`}
                  loading="lazy"
                  onError={() => setFrameOk(false)}
                />
              </div>
            ) : (
              <div
                className="panel"
                style={{
                  display: "grid",
                  placeItems: "center",
                  minHeight: 240,
                  maxWidth: 320,
                  border: "1px dashed var(--line-strong)",
                  textAlign: "center",
                }}
              >
                <div className="stack" style={{ alignItems: "center", gap: 8, padding: 18 }}>
                  <Phone size={18} className="faint" />
                  <p className="tiny muted" style={{ maxWidth: 210, lineHeight: 1.5 }}>
                    {device.online
                      ? live
                        ? "Waiting for the first live frame from the phone."
                        : "Live view is paused. Press Go live or Look to read the screen again."
                      : "The phone is not sending heartbeats. Open Talisman Companion on the phone."}
                  </p>
                </div>
              </div>
            )}
            <p className="tiny faint" style={{ marginTop: 8, lineHeight: 1.5 }}>
              The frame is uploaded by the phone after a read-only observation and refreshes while
              Live is on. It is never cached by the browser.
            </p>
          </div>

          <div style={{ minWidth: 0 }}>
            <div className="row-between">
              <h3 className="section-title">Visible text</h3>
              <span className="tiny faint">{boxes.length ? `${boxes.length} labels` : ""}</span>
            </div>
            {boxes.length === 0 ? (
              <p className="small muted" style={{ marginTop: 8, lineHeight: 1.55 }}>
                Nothing read yet. Look asks the phone for the accessibility tree, which is the same
                text the agent uses to decide what to do.
              </p>
            ) : (
              <div
                className="stack"
                style={{ gap: 2, marginTop: 8, maxHeight: 300, overflow: "auto" }}
              >
                {boxes.slice(0, 80).map((box, index) => (
                  <div
                    key={`${box.text}-${box.x}-${box.y}-${index}`}
                    className="row"
                    style={{ gap: 8, padding: "6px 8px", borderRadius: "var(--r-1)" }}
                  >
                    <span className="mono tiny faint" style={{ width: 18 }}>
                      {index}
                    </span>
                    <span className="small truncate">{box.text}</span>
                  </div>
                ))}
              </div>
            )}
            <p className="tiny faint" style={{ marginTop: 10, lineHeight: 1.5 }}>
              The screen read is read-only. Taps, app launches, and Home requests become one-shot
              approvals before the phone executes them.
            </p>
          </div>
        </div>

        <PhoneActions device={device} onDone={() => void observe(true)} />

        <div className="row wrap" style={{ gap: 8, borderTop: "1px solid var(--line)", paddingTop: 12 }}>
          {device.status === "active" ? (
            <Button
              size="sm"
              icon={<Pause size={12} />}
              busy={managing === "pause"}
              onClick={() => void manage("pause")}
            >
              Pause
            </Button>
          ) : device.status === "paused" ? (
            <Button
              size="sm"
              icon={<Play size={12} />}
              busy={managing === "resume"}
              onClick={() => void manage("resume")}
            >
              Resume
            </Button>
          ) : null}
          <Button
            size="sm"
            variant="danger"
            icon={<Trash2 size={12} />}
            busy={managing === "revoke"}
            onClick={() => void manage("revoke")}
          >
            Revoke
          </Button>
          <span className="tiny faint grow" style={{ alignSelf: "center" }}>
            Revoking rotates the stored hash and cancels queued work.
          </span>
        </div>
      </div>
    </Card>
  );
}

function LegacyNotice({ legacy }: { legacy: PhoneStatus }) {
  return (
    <Notice tone="neutral">
      A legacy {legacy.kind} transport is configured ({legacy.label}) and{" "}
      {legacy.ready ? "reachable" : "not reachable"}. The Android companion is the supported path;
      pair a phone above to give the agent your real apps.
    </Notice>
  );
}

export function Devices() {
  const [pairingOpen, setPairingOpen] = useState(false);
  const query = useQuery({
    queryKey: ["devices"],
    queryFn: api.devices,
    retry: false,
    refetchInterval: 4_000,
  });
  const devices = query.data?.devices ?? [];
  const active = devices.filter((device) => device.status === "active").length;

  return (
    <div className="page">
      <div className="page-head">
        <div className="stack" style={{ gap: 4 }}>
          <h1 className="page-title">Devices</h1>
          <p className="page-sub">
            Your own Android phone is the host. Talisman sends queued work; the companion uses the
            apps already installed on the phone and returns the result.
          </p>
        </div>
        {active > 0 ? (
          <Badge tone="live">{active} active</Badge>
        ) : query.data?.configured ? (
          <Badge tone="warn">No active phone</Badge>
        ) : (
          <Badge>Not paired</Badge>
        )}
      </div>

      {query.isLoading ? (
        <Card>
          <Skeleton h={200} />
        </Card>
      ) : query.isError ? (
        <Notice tone="bad">{errorMessage(query.error)}</Notice>
      ) : (
        <>
          <PendingPhoneApprovals devices={devices} />

          {devices.length === 0 || pairingOpen ? (
            <PairPanel onClose={devices.length ? () => setPairingOpen(false) : undefined} />
          ) : null}

          {devices.length === 0 ? (
            <Card>
              <Empty
                icon={<Phone size={15} />}
                title="No phone is paired yet"
                body="Create a pairing code above, then enter it in Talisman Companion on your Android phone. The phone will appear here after it claims the code."
              />
            </Card>
          ) : (
            <div className="stack" style={{ gap: "var(--space-4)" }}>
              {devices.map((device) => (
                <CompanionCard key={device.id} device={device} />
              ))}
            </div>
          )}

          {devices.length > 0 && !pairingOpen ? (
            <div className="row">
              <Button size="sm" onClick={() => setPairingOpen(true)}>
                Pair another phone
              </Button>
            </div>
          ) : null}

          {query.data?.legacy && devices.length === 0 ? (
            <LegacyNotice legacy={query.data.legacy} />
          ) : null}

          <Card>
            <div className="row" style={{ gap: 9, alignItems: "flex-start" }}>
              <ShieldCheck size={14} className="faint" aria-hidden style={{ marginTop: 2 }} />
              <div className="stack tiny muted" style={{ gap: 4, lineHeight: 1.55 }}>
                <span>
                  The companion refuses banking, password-manager, and authenticator packages. It
                  also refuses secure windows and never auto-unlocks the phone.
                </span>
                <span>
                  Actions that can send, pay, post, or delete require an approval bound to the exact
                  arguments the phone will execute. The manual controls in this page use the same
                  one-shot approval path; they are not a separate bypass.
                </span>
              </div>
            </div>
          </Card>
        </>
      )}
    </div>
  );
}
