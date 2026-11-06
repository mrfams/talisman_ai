import {
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type TextareaHTMLAttributes,
  useEffect,
  useId,
} from "react";
import { AlertTriangle, Info, X } from "lucide-react";
import { cx } from "./lib/cx";
import type { TaskStatus } from "./lib/api";

/* ------------------------------------------------------------------ button */

type Variant = "primary" | "secondary" | "quiet" | "danger";

export function Button({
  variant = "secondary",
  size,
  busy,
  icon,
  className,
  children,
  disabled,
  type = "button",
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant;
  size?: "sm" | "lg";
  busy?: boolean;
  icon?: ReactNode;
}) {
  return (
    <button
      type={type}
      className={cx(
        "btn",
        `btn-${variant}`,
        size === "sm" && "btn-sm",
        size === "lg" && "btn-lg",
        className,
      )}
      disabled={disabled || busy}
      data-busy={busy ? "true" : undefined}
      {...rest}
    >
      {busy ? <span className="spinner" aria-hidden /> : icon}
      <span className="btn-label">{children}</span>
    </button>
  );
}

export function IconButton({
  label,
  children,
  className,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return (
    <button
      type="button"
      className={cx("icon-btn", className)}
      aria-label={label}
      title={label}
      {...rest}
    >
      {children}
    </button>
  );
}

/* ------------------------------------------------------------------- forms */

export function Field({
  label,
  hint,
  error,
  htmlFor,
  children,
}: {
  label: string;
  hint?: string;
  error?: string | null;
  htmlFor?: string;
  children: ReactNode;
}) {
  return (
    <div className="field">
      <label className="label" htmlFor={htmlFor}>
        {label}
      </label>
      {children}
      {error ? (
        <span className="error-text" role="alert">
          {error}
        </span>
      ) : hint ? (
        <span className="hint">{hint}</span>
      ) : null}
    </div>
  );
}

export function Input({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={cx("input", className)} {...rest} />;
}

export function Textarea({ className, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={cx("textarea", className)} {...rest} />;
}

/* ----------------------------------------------------------------- surfaces */

export function Card({
  children,
  className,
  flush,
}: {
  children: ReactNode;
  className?: string;
  flush?: boolean;
}) {
  return <section className={cx("card", flush && "flush", className)}>{children}</section>;
}

export function Notice({
  tone = "neutral",
  children,
}: {
  tone?: "neutral" | "bad" | "warn";
  children: ReactNode;
}) {
  const Icon = tone === "neutral" ? Info : AlertTriangle;
  return (
    <div className="notice" data-tone={tone === "neutral" ? undefined : tone} role="status">
      <Icon size={15} aria-hidden style={{ flex: "none", marginTop: 2 }} />
      <div>{children}</div>
    </div>
  );
}

export function Empty({
  icon,
  title,
  body,
  action,
}: {
  icon?: ReactNode;
  title: string;
  body: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty">
      {icon ? <span className="empty-icon">{icon}</span> : null}
      <div className="empty-title">{title}</div>
      <p className="empty-body">{body}</p>
      {action}
    </div>
  );
}

export function Skeleton({ h = 14, w = "100%" }: { h?: number; w?: number | string }) {
  return <div className="skeleton" style={{ height: h, width: w }} aria-hidden />;
}

export function Spinner() {
  return <span className="spinner" role="status" aria-label="Loading" />;
}

/* ------------------------------------------------------------------- badge */

export type Tone = "ok" | "warn" | "bad" | "info" | "live" | "plain";

export function Badge({ tone = "plain", children }: { tone?: Tone; children: ReactNode }) {
  return (
    <span className="badge" data-tone={tone}>
      {children}
    </span>
  );
}

const STATUS_TONE: Record<TaskStatus, Tone> = {
  queued: "plain",
  scheduled: "info",
  running: "live",
  waiting_approval: "warn",
  paused: "plain",
  succeeded: "ok",
  failed: "bad",
  cancelled: "bad",
};

const STATUS_LABEL: Record<TaskStatus, string> = {
  queued: "Queued",
  scheduled: "Scheduled",
  running: "Running",
  waiting_approval: "Needs you",
  paused: "Paused",
  succeeded: "Done",
  failed: "Failed",
  cancelled: "Cancelled",
};

export function StatusBadge({ status }: { status: TaskStatus }) {
  return <Badge tone={STATUS_TONE[status]}>{STATUS_LABEL[status]}</Badge>;
}

/* ------------------------------------------------------------------- modal */

export function Modal({
  open,
  onClose,
  title,
  children,
  footer,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = previous;
    };
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className="scrim" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="sheet" role="dialog" aria-modal="true" aria-label={title}>
        <div className="sheet-head">
          <h2 style={{ fontSize: "var(--text-lg)" }}>{title}</h2>
          <IconButton label="Close" onClick={onClose}>
            <X size={16} />
          </IconButton>
        </div>
        <div className="sheet-body">{children}</div>
        {footer ? <div className="sheet-foot">{footer}</div> : null}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------- time */

export function timeAgo(iso: string | null): string {
  if (!iso) return "—";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "—";
  const seconds = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days === 1) return "yesterday";
  if (days < 7) return `${days}d ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function bytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

/* --------------------------------------------------------------- markdown */

function safeHref(href: string): string | null {
  return /^(https?:\/\/|mailto:|\/)/i.test(href) ? href : null;
}

function inline(text: string, key: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const pattern = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)]+\)|\*[^*\n]+\*)/g;
  let last = 0;
  let index = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > last) nodes.push(text.slice(last, match.index));
    const token = match[0];
    const k = `${key}-${index}`;
    if (token.startsWith("**")) {
      nodes.push(<strong key={k}>{token.slice(2, -2)}</strong>);
    } else if (token.startsWith("`")) {
      nodes.push(<code key={k}>{token.slice(1, -1)}</code>);
    } else if (token.startsWith("[")) {
      const link = /\[([^\]]+)\]\(([^)]+)\)/.exec(token);
      const href = link ? safeHref(link[2] ?? "") : null;
      nodes.push(
        href ? (
          <a key={k} href={href} target="_blank" rel="noreferrer">
            {link?.[1]}
          </a>
        ) : (
          token
        ),
      );
    } else {
      nodes.push(<em key={k}>{token.slice(1, -1)}</em>);
    }
    last = match.index + token.length;
    index += 1;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

/** Small, safe Markdown subset: prose, lists, code fences, inline emphasis. */
export function Markdown({ text }: { text: string }) {
  const blocks: ReactNode[] = [];
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  let i = 0;
  let key = 0;

  while (i < lines.length) {
    const line = lines[i] ?? "";
    if (!line.trim()) {
      i += 1;
      continue;
    }
    if (line.startsWith("```")) {
      const code: string[] = [];
      i += 1;
      while (i < lines.length && !(lines[i] ?? "").startsWith("```")) {
        code.push(lines[i] ?? "");
        i += 1;
      }
      i += 1;
      blocks.push(
        <pre key={`b${key++}`}>
          <code>{code.join("\n")}</code>
        </pre>,
      );
      continue;
    }
    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    if (heading) {
      const Tag = (heading[1]?.length === 1 ? "h1" : heading[1]?.length === 2 ? "h2" : "h3") as
        | "h1"
        | "h2"
        | "h3";
      blocks.push(<Tag key={`b${key++}`}>{inline(heading[2] ?? "", `h${key}`)}</Tag>);
      i += 1;
      continue;
    }
    if (/^\s*[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i] ?? "")) {
        items.push((lines[i] ?? "").replace(/^\s*[-*]\s+/, ""));
        i += 1;
      }
      blocks.push(
        <ul key={`b${key++}`}>
          {items.map((item, n) => (
            <li key={n}>{inline(item, `li${key}-${n}`)}</li>
          ))}
        </ul>,
      );
      continue;
    }
    if (/^\s*\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i] ?? "")) {
        items.push((lines[i] ?? "").replace(/^\s*\d+\.\s+/, ""));
        i += 1;
      }
      blocks.push(
        <ol key={`b${key++}`}>
          {items.map((item, n) => (
            <li key={n}>{inline(item, `oli${key}-${n}`)}</li>
          ))}
        </ol>,
      );
      continue;
    }
    const paragraph: string[] = [];
    while (
      i < lines.length &&
      (lines[i] ?? "").trim() &&
      !/^\s*([-*]|\d+\.)\s+/.test(lines[i] ?? "") &&
      !(lines[i] ?? "").startsWith("```") &&
      !/^#{1,3}\s+/.test(lines[i] ?? "")
    ) {
      paragraph.push(lines[i] ?? "");
      i += 1;
    }
    blocks.push(<p key={`b${key++}`}>{inline(paragraph.join("\n"), `p${key}`)}</p>);
  }

  return <div className="md">{blocks}</div>;
}

/* ------------------------------------------------------------------- misc */

export function useDomId(prefix: string): string {
  const id = useId();
  return `${prefix}-${id.replace(/:/g, "")}`;
}
