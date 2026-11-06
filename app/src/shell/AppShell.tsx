import { useEffect, useMemo, useState } from "react";
import { Link, NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import {
  Activity,
  ArrowUpRight,
  Bot,
  Command,
  Home,
  ListChecks,
  LogOut,
  MessageSquare,
  Moon,
  Package,
  Plug,
  Search,
  Settings,
  ShieldCheck,
  Sun,
  Users,
} from "lucide-react";
import { cx } from "../lib/cx";
import { useMe, useSignOut, useTasks, errorMessage } from "../lib/queries";
import { IconButton } from "../ui";

const NAV = [
  { to: "/", label: "Today", icon: Home, end: true },
  { to: "/chat", label: "Chat", icon: MessageSquare },
  { to: "/tasks", label: "Runs", icon: ListChecks },
  { to: "/approvals", label: "Approvals", icon: ShieldCheck },
  { to: "/artifacts", label: "Artifacts", icon: Package },
  { to: "/connectors", label: "Connectors", icon: Plug },
  { to: "/activity", label: "Activity", icon: Activity },
  { to: "/team", label: "Team", icon: Users },
  { to: "/settings", label: "Settings", icon: Settings },
];

const MOBILE = [
  { to: "/", label: "Today", icon: Home, end: true },
  { to: "/chat", label: "Chat", icon: MessageSquare },
  { to: "/tasks", label: "Runs", icon: ListChecks },
  { to: "/connectors", label: "Apps", icon: Plug },
  { to: "/settings", label: "You", icon: Settings },
];

const TITLES: Record<string, string> = {
  "/": "Today",
  "/chat": "Chat",
  "/tasks": "Runs",
  "/approvals": "Approvals",
  "/artifacts": "Artifacts",
  "/connectors": "Connectors",
  "/activity": "Activity",
  "/team": "Team",
  "/settings": "Settings",
};

function useTheme() {
  const [theme, setTheme] = useState<string>(
    () => document.documentElement.dataset.theme ?? "dark",
  );
  const toggle = () => {
    const next = theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem("talisman.theme", next);
    } catch {
      // Private mode: the theme still applies for this session.
    }
    setTheme(next);
  };
  return { theme, toggle };
}

export function AppShell() {
  const me = useMe();
  const tasks = useTasks();
  const signOut = useSignOut();
  const navigate = useNavigate();
  const location = useLocation();
  const { theme, toggle } = useTheme();
  const [paletteOpen, setPaletteOpen] = useState(false);

  const needsYou = tasks.data?.filter((task) => task.status === "waiting_approval").length ?? 0;
  const running = tasks.data?.filter((task) => task.status === "running").length ?? 0;

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPaletteOpen((open) => !open);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const title = useMemo(() => {
    if (location.pathname.startsWith("/chat")) return "Chat";
    if (location.pathname.startsWith("/tasks")) return "Runs";
    return TITLES[location.pathname] ?? "Talisman";
  }, [location.pathname]);

  const user = me.data?.user;
  const initials = (user?.name ?? user?.email ?? "?").slice(0, 1).toUpperCase();

  return (
    <div className="shell">
      <aside className="rail">
        <Link to="/" className="brand" style={{ textDecoration: "none", color: "inherit" }}>
          <span className="brand-mark" aria-hidden />
          <span className="brand-name">Talisman</span>
        </Link>

        <nav className="rail-group" aria-label="Primary">
          {NAV.map((item) => (
            <NavLink key={item.to} to={item.to} end={item.end} className="rail-link">
              <item.icon size={16} aria-hidden />
              <span>{item.label}</span>
              {item.to === "/tasks" && (needsYou > 0 || running > 0) ? (
                <span className="count">{needsYou > 0 ? needsYou : running}</span>
              ) : null}
            </NavLink>
          ))}
        </nav>

        <div className="rail-foot">
          <button className="rail-link" onClick={() => setPaletteOpen(true)}>
            <Command size={16} aria-hidden />
            <span>Command</span>
            <span className="count">⌘K</span>
          </button>
          <button className="rail-link" onClick={toggle}>
            {theme === "dark" ? <Sun size={16} aria-hidden /> : <Moon size={16} aria-hidden />}
            <span>{theme === "dark" ? "Light mode" : "Dark mode"}</span>
          </button>
          <div className="who">
            <span className="avatar" aria-hidden>
              {initials}
            </span>
            <span className="grow truncate tiny muted">{user?.email}</span>
            <IconButton
              label="Sign out"
              onClick={() =>
                signOut.mutate(undefined, {
                  onSettled: () => {
                    navigate("/sign-in", { replace: true });
                  },
                })
              }
            >
              <LogOut size={15} />
            </IconButton>
          </div>
          {signOut.isError ? <p className="error-text">{errorMessage(signOut.error)}</p> : null}
        </div>
      </aside>

      <div className="main">
        <header className="topbar">
          <span className="tiny muted" style={{ letterSpacing: "0.02em" }}>
            {title}
          </span>
          {running > 0 ? (
            <span className="badge" data-tone="live">
              {running} running
            </span>
          ) : null}
          <span className="grow" />
          <button
            className="chip"
            onClick={() => setPaletteOpen(true)}
            aria-label="Open command palette"
          >
            <Search size={13} aria-hidden />
            <span className="tiny">Search</span>
            <span className="kbd">⌘K</span>
          </button>
          <IconButton label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"} onClick={toggle}>
            {theme === "dark" ? <Sun size={16} /> : <Moon size={16} />}
          </IconButton>
        </header>

        <Outlet />
      </div>

      <nav className="mobile-tabs" aria-label="Primary">
        {MOBILE.map((item) => (
          <NavLink key={item.to} to={item.to} end={item.end} className="mobile-tab">
            <item.icon size={18} aria-hidden />
            <span>{item.label}</span>
          </NavLink>
        ))}
      </nav>

      {paletteOpen ? (
        <CommandPalette
          onClose={() => setPaletteOpen(false)}
          onTheme={toggle}
          onSignOut={() => signOut.mutate()}
        />
      ) : null}
    </div>
  );
}

function CommandPalette({
  onClose,
  onTheme,
  onSignOut,
}: {
  onClose: () => void;
  onTheme: () => void;
  onSignOut: () => void;
}) {
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);

  const actions = useMemo(
    () => [
      ...NAV.map((item) => ({
        id: item.to,
        label: `Go to ${item.label}`,
        icon: item.icon,
        run: () => navigate(item.to),
      })),
      { id: "new-chat", label: "Start a new chat", icon: Bot, run: () => navigate("/chat") },
      { id: "theme", label: "Toggle light and dark", icon: Sun, run: onTheme },
      { id: "sign-out", label: "Sign out", icon: LogOut, run: onSignOut },
    ],
    [navigate, onTheme, onSignOut],
  );

  const filtered = actions.filter((action) =>
    action.label.toLowerCase().includes(query.trim().toLowerCase()),
  );

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setActive((value) => Math.min(value + 1, Math.max(0, filtered.length - 1)));
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setActive((value) => Math.max(0, value - 1));
      }
      if (event.key === "Enter") {
        const action = filtered[active];
        if (action) {
          action.run();
          onClose();
        }
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [active, filtered, onClose]);

  return (
    <div
      className="scrim"
      style={{ zIndex: "var(--z-palette)" }}
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <div className="palette" role="dialog" aria-modal="true" aria-label="Command palette">
        <input
          className="palette-input"
          placeholder="Search pages and actions"
          value={query}
          autoFocus
          onChange={(event) => {
            setQuery(event.target.value);
            setActive(0);
          }}
        />
        <div className="palette-list">
          {filtered.map((action, index) => (
            <button
              key={action.id}
              className={cx("palette-item")}
              data-active={index === active}
              onMouseEnter={() => setActive(index)}
              onClick={() => {
                action.run();
                onClose();
              }}
            >
              <action.icon size={15} aria-hidden />
              {action.label}
              <ArrowUpRight size={13} aria-hidden style={{ marginLeft: "auto", opacity: 0.5 }} />
            </button>
          ))}
          {filtered.length === 0 ? (
            <p className="tiny muted" style={{ padding: "12px" }}>
              Nothing matches “{query}”.
            </p>
          ) : null}
        </div>
      </div>
    </div>
  );
}
