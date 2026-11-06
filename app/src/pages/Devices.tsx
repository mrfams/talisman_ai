import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronLeft, Home, MousePointerClick, Phone, RefreshCw, Terminal } from "lucide-react";
import { api, type PhoneStatus } from "../lib/api";
import { errorMessage } from "../lib/queries";
import { Badge, Button, Card, Empty, Notice, Skeleton } from "../ui";

interface Box {
  text: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

function boxesFrom(result: unknown): Box[] {
  const boxes = Array.isArray(result) ? result : [];
  return boxes
    .map((box) => (box && typeof box === "object" ? (box as Record<string, unknown>) : null))
    .filter((box): box is Record<string, unknown> => Boolean(box))
    .map((box) => ({
      text: String(box.text ?? ""),
      x: Number(box.x ?? 0),
      y: Number(box.y ?? 0),
      w: Number(box.w ?? 0),
      h: Number(box.h ?? 0),
    }))
    .filter((box) => box.text.length > 0);
}

function Screen({ device }: { device: PhoneStatus }) {
  const [shot, setShot] = useState<{ png: string; bounds: { w: number; h: number } | null } | null>(
    null,
  );
  const [boxes, setBoxes] = useState<Box[]>([]);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  async function look() {
    setBusy(true);
    setProblem(null);
    try {
      const image = await api.deviceOp("screen.capture");
      if (image.png_b64) {
        const bounds = image.bounds as { w?: number; h?: number } | null | undefined;
        setShot({
          png: image.png_b64,
          bounds:
            bounds && typeof bounds.w === "number" && typeof bounds.h === "number"
              ? { w: bounds.w, h: bounds.h }
              : null,
        });
      }
      const text = await api.deviceOp("screen.text");
      setBoxes(boxesFrom(text.result));
    } catch (error) {
      setProblem(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function act(op: string, kw: Record<string, unknown> = {}) {
    setBusy(true);
    setProblem(null);
    try {
      await api.deviceOp(op, kw);
      await look();
    } catch (error) {
      setProblem(errorMessage(error));
      setBusy(false);
    }
  }

  const width = shot?.bounds?.w ?? 390;

  return (
    <Card>
      <div className="row-between wrap">
        <div className="row" style={{ gap: 10 }}>
          <span className="empty-icon" style={{ width: 34, height: 34 }}>
            <Phone size={16} />
          </span>
          <div>
            <div style={{ fontWeight: 600 }}>{device.label}</div>
            <div className="tiny faint">{device.detail}</div>
          </div>
        </div>
        <div className="row">
          <Badge tone={device.ready ? "ok" : "warn"}>{device.ready ? "Ready" : "Offline"}</Badge>
          <Button size="sm" icon={<RefreshCw size={13} />} busy={busy} onClick={() => void look()}>
            Look
          </Button>
        </div>
      </div>

      {problem ? (
        <div style={{ marginTop: "var(--space-4)" }}>
          <Notice tone="bad">{problem}</Notice>
        </div>
      ) : null}

      <div
        className="grid-2"
        style={{ marginTop: "var(--space-4)", alignItems: "start", gap: "var(--space-4)" }}
      >
        <div>
          {shot ? (
            <div
              style={{
                border: "1px solid var(--line)",
                borderRadius: 18,
                overflow: "hidden",
                background: "var(--canvas-2)",
                maxWidth: 330,
              }}
            >
              {/* The image is the phone's own frame; clicks map back to screen points. */}
              <img
                src={`data:image/png;base64,${shot.png}`}
                alt={`${device.label} screen`}
                style={{ width: "100%", height: "auto", cursor: "crosshair", display: "block" }}
                onClick={(event) => {
                  const element = event.currentTarget;
                  const rect = element.getBoundingClientRect();
                  const x = Math.round(((event.clientX - rect.left) / rect.width) * width);
                  const y = Math.round(
                    ((event.clientY - rect.top) / rect.height) *
                      (shot.bounds?.h ?? (element.naturalHeight || 1)),
                  );
                  void act("input.tap", { x, y });
                }}
              />
            </div>
          ) : (
            <div
              className="panel"
              style={{ display: "grid", placeItems: "center", minHeight: 260, maxWidth: 330 }}
            >
              <div className="stack" style={{ alignItems: "center", gap: 8 }}>
                <MousePointerClick size={20} className="faint" />
                <p className="small muted" style={{ textAlign: "center", maxWidth: 220 }}>
                  Press Look to capture the phone. After that you can tap the image to tap the phone.
                </p>
              </div>
            </div>
          )}
          <div className="row wrap" style={{ marginTop: 10, gap: 6 }}>
            <Button size="sm" icon={<Home size={13} />} onClick={() => void act("nav.home")}>
              Home
            </Button>
            <Button size="sm" icon={<ChevronLeft size={13} />} onClick={() => void act("nav.back")}>
              Back
            </Button>
            <Button
              size="sm"
              icon={<ChevronLeft size={13} style={{ transform: "rotate(-90deg)" }} />}
              onClick={() => void act("input.scroll", { direction: "down", amount: 0.4 })}
            >
              Scroll
            </Button>
          </div>
        </div>

        <div>
          <h3 className="section-title">Text on screen</h3>
          {boxes.length === 0 ? (
            <p className="small muted" style={{ marginTop: 8 }}>
              Nothing read yet. “Look” reads the screen's text, which is what the agent uses to find
              what to tap.
            </p>
          ) : (
            <div className="stack" style={{ gap: 4, marginTop: 8, maxHeight: 320, overflow: "auto" }}>
              {boxes.slice(0, 60).map((box, index) => (
                <button
                  key={`${box.text}-${index}`}
                  className="row"
                  style={{
                    gap: 8,
                    padding: "6px 8px",
                    borderRadius: 8,
                    background: "var(--surface-2)",
                    textAlign: "left",
                  }}
                  onClick={() =>
                    void act("input.tap", {
                      x: Math.round(box.x + box.w / 2),
                      y: Math.round(box.y + box.h / 2),
                    })
                  }
                >
                  <span className="tiny mono faint">{index}</span>
                  <span className="small truncate">{box.text}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </Card>
  );
}

export function Devices() {
  const query = useQuery({ queryKey: ["devices"], queryFn: api.devices, retry: false });

  return (
    <div className="page">
      <div className="page-head">
        <div className="stack" style={{ gap: 4 }}>
          <h1 className="page-title">Devices</h1>
          <p className="page-sub">
            A real phone, driven through Phone Harness. The agent sees text and taps labels; it never
            gets your passwords.
          </p>
        </div>
        {query.data?.configured ? <Badge tone="live">Configured</Badge> : <Badge>Not set up</Badge>}
      </div>

      {query.isLoading ? (
        <Card>
          <Skeleton h={200} />
        </Card>
      ) : query.isError ? (
        <Notice tone="bad">{errorMessage(query.error)}</Notice>
      ) : query.data?.configured && query.data.devices.length ? (
        <div className="stack" style={{ gap: "var(--space-4)" }}>
          {query.data.devices.map((device) => (
            <Screen key={`${device.kind}-${device.label}`} device={device} />
          ))}
        </div>
      ) : (
        <>
          <Card>
            <Empty
              icon={<Phone size={18} />}
              title="No phone is connected yet"
              body="Two ways to give the agent a phone: rent a cloud phone, or run the bridge on the machine next to your own phone. The bridge is the only way to reach an iPhone or a USB Android, because a hosted server cannot touch them."
            />
          </Card>

          <div className="grid-2" style={{ alignItems: "start" }}>
            <Card>
              <div className="row" style={{ gap: 8 }}>
                <Terminal size={15} className="muted" />
                <h2 className="section-title">Your own phone</h2>
              </div>
              <p className="small muted" style={{ margin: "var(--space-3) 0" }}>
                Install Phone Harness, connect the phone, then run the bridge on that machine:
              </p>
              <pre
                className="tiny"
                style={{
                  background: "var(--code-bg)",
                  border: "1px solid var(--line)",
                  borderRadius: 10,
                  padding: 12,
                  overflow: "auto",
                }}
              >
                {`PHONE_BRIDGE_TOKEN=<32+ random chars> \\
  node scripts/phone-bridge.mjs`}
              </pre>
              <p className="tiny faint" style={{ marginTop: 10 }}>
                Then set <span className="mono">PHONE_BRIDGE_URL</span> and{" "}
                <span className="mono">PHONE_BRIDGE_TOKEN</span> on this deployment.
              </p>
            </Card>

            <Card>
              <h2 className="section-title">Cloud phone</h2>
              <p className="small muted" style={{ margin: "var(--space-3) 0" }}>
                Phone Harness Cloud hosts real iPhones and Androids. The server starts a session and
                drives it over HTTPS with a control token.
              </p>
              <p className="tiny faint">
                Set <span className="mono">PHONE_HARNESS_API_KEY</span>
                {query.data?.hint ? ` — ${query.data.hint}` : ""}
              </p>
            </Card>
          </div>

          <Notice tone="warn">
            Phone control is built against the harness's documented ops and tested against a fake
            control service. No phone has been driven from this deployment yet.
          </Notice>
        </>
      )}
    </div>
  );
}
