import { useEffect, useMemo, useRef, useState } from "react";
import { Link, NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Activity,
  ArrowDown,
  ArrowUp,
  ArrowUpRight,
  Bell,
  CalendarClock,
  CheckCheck,
  Home,
  ListChecks,
  LogOut,
  MessageSquare,
  Moon,
  Package,
  Plug,
  Plus,
  Search,
  Settings,
  ShieldCheck,
  Smartphone,
  Sun,
  Users,
} from "lucide-react";
import { useMe, useSignOut, useTasks, errorMessage } from "../lib/queries";
import { api, type AppNotification } from "../lib/api";
import { IconButton, Skeleton, timeAgo } from "../ui";
import { BrandMark } from "../BrandMark";
import type { Task } from "../lib/api";

const NAV_GROUPS = [
  {
    label: "Work",
    items: [
      { to: "/", label: "Today", icon: Home, end: true },
      { to: "/chat", label: "Chat", icon: MessageSquare },
      { to: "/tasks", label: "Runs", icon: ListChecks },
      { to: "/approvals", label: "Approvals", icon: ShieldCheck },
      { to: "/schedules", label: "Schedules", icon: CalendarClock },
    ],
  },
  {
    label: "Library",
    items: [
      { to: "/artifacts", label: "Artifacts", icon: Package },
      { to: "/connectors", label: "Connectors", icon: Plug },
      { to: "/devices", label: "Devices", icon: Smartphone },
      { to: "/activity", label: "Activity", icon: Activity },
    ],
  },
  {
    label: "Workspace",
    items: [
      { to: "/team", label: "Team", icon: Users },
      { to: "/settings", label: "Settings", icon: Settings },
    ],
  },
];

const NAV = NAV_GROUPS.flatMap((group) => group.items);

const MOBILE = [
  { to: "/", label: "Today", icon: Home, end: true },
  { to: "/chat", label: "Chat", icon: MessageSquare },
  { to: "/tasks", label: "Runs", icon: ListChecks },
  { to: "/approvals", label: "Approvals", icon: ShieldCheck },
  { to: "/schedules", label: "Schedules", icon: CalendarClock },
  { to: "/connectors", label: "Apps", icon: Plug },
  { to: "/settings", label: "You", icon: Settings },
];

const TITLES: Record<string, string> = {
  "/": "Today",
  "/chat": "Chat",
  "/tasks": "Runs",
  "/approvals": "Approvals",
  "/schedules": "Schedules",
  "/artifacts": "Artifacts",
  "/connectors": "Connectors",
  "/devices": "Devices",
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

  const all = tasks.data ?? [];
  const needsYou = all.filter((task) => task.status === "waiting_approval").length;
  const running = all.filter((task) => task.status === "running").length;

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
    return TITLES[location.pathname] ?? "Not found";
  }, [location.pathname]);

  const user = me.data?.user;
  const initials = (user?.name ?? user?.email ?? "?").slice(0, 1).toUpperCase();

  return (
    <div className="shell">
      <aside className="rail">
        <Link to="/" className="brand" style={{ textDecoration: "none", color: "inherit" }}>
          <span className="brand-mark">
            <BrandMark size={24} />
          </span>
          <span className="brand-name">Talisman</span>
        </Link>

        <nav aria-label="Primary">
          {NAV_GROUPS.map((group) => (
            <div className="rail-group" key={group.label}>
              <div className="rail-label">{group.label}</div>
              {group.items.map((item) => (
                <NavLink key={item.to} to={item.to} end={item.end} className="rail-link">
                  <item.icon size={15} aria-hidden />
                  <span>{item.label}</span>
                  {item.to === "/tasks" && (needsYou > 0 || running > 0) ? (
                    <span className="count" title={needsYou > 0 ? `${needsYou} need you` : `${running} running`}>
                      {needsYou > 0 ? needsYou : running}
                    </span>
                  ) : null}
                </NavLink>
              ))}
            </div>
          ))}
        </nav>

        <div className="rail-foot">
          <button className="rail-link" onClick={() => setPaletteOpen(true)}>
            <Search size={15} aria-hidden />
            <span>Search</span>
            <span className="count" style={{ background: "transparent", border: 0 }}>
              ⌘K
            </span>
          </button>
          <button className="rail-link" onClick={toggle}>
            {theme === "dark" ? <Sun size={15} aria-hidden /> : <Moon size={15} aria-hidden />}
            <span>{theme === "dark" ? "Light mode" : "Dark mode"}</span>
          </button>
          <div className="who">
            <span className="avatar" aria-hidden>
              {initials}
            </span>
            <span className="grow truncate tiny muted">{user?.name ?? user?.email}</span>
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
              <LogOut size={14} />
            </IconButton>
          </div>
          {signOut.isError ? <p className="error-text">{errorMessage(signOut.error)}</p> : null}
        </div>
      </aside>

      <div className="main">
        <header className="topbar">
          <span className="crumb">
            <span>Workspace</span>
            <span aria-hidden>/</span>
            <span className="crumb-current">{title}</span>
          </span>
          {running > 0 ? (
            <Link
              to="/tasks?tab=active"
              className="badge"
              data-tone="live"
              style={{ textDecoration: "none" }}
            >
              {running} running
            </Link>
          ) : null}
          <span className="grow" />
          <button
            className="topbar-search"
            onClick={() => setPaletteOpen(true)}
            aria-label="Search and commands"
          >
            <Search size={12} aria-hidden />
            <span className="tiny">Search</span>
            <span className="kbd" style={{ marginLeft: 4 }}>
              ⌘K
            </span>
          </button>
          <IconButton
            label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
            onClick={toggle}
          >
            {theme === "dark" ? <Sun size={15} /> : <Moon size={15} />}
          </IconButton>
          <NotificationBell />
          <IconButton label="New chat" onClick={() => navigate("/chat")}>
            <MessageSquare size={15} />
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
          runs={all}
          onClose={() => setPaletteOpen(false)}
          onTheme={toggle}
          onSignOut={() => signOut.mutate()}
        />
      ) : null}
    </div>
  );
}

function NotificationBell() {
  const client = useQueryClient();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement | null>(null);
  const query = useQuery({
    queryKey: ["notifications"],
    queryFn: api.notifications,
    refetchInterval: 20_000,
  });
  const readAll = useMutation({
    mutationFn: api.readAllNotifications,
    onSuccess: async () => client.invalidateQueries({ queryKey: ["notifications"] }),
  });
  const readOne = useMutation({
    mutationFn: api.readNotification,
    onSuccess: async () => client.invalidateQueries({ queryKey: ["notifications"] }),
  });

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (wrap.current && !wrap.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  const items = query.data?.notifications ?? [];
  const unread = query.data?.unread ?? 0;

  function openItem(item: AppNotification) {
    if (!item.readAt) readOne.mutate(item.id);
    setOpen(false);
    if (item.kind.startsWith("phone.")) navigate("/devices");
    else if (item.data?.taskId) navigate(`/tasks/${item.data.taskId}`);
    else if (item.kind === "approval.pending") navigate("/approvals");
  }

  return (
    <div className="notif-wrap" ref={wrap}>
      <IconButton label="Notifications" onClick={() => setOpen((value) => !value)}>
        <Bell size={15} />
        {unread > 0 ? <span className="notif-dot" aria-label={`${unread} unread`} /> : null}
      </IconButton>
      {open ? (
        <div className="notif-pop" role="dialog" aria-label="Notifications">
          <div className="notif-head">
            <span className="small" style={{ fontWeight: 600 }}>
              Notifications
            </span>
            <button
              className="icon-btn"
              style={{ width: 24, height: 24 }}
              aria-label="Mark all read"
              title="Mark all read"
              disabled={unread === 0 || readAll.isPending}
              onClick={() => readAll.mutate()}
            >
              <CheckCheck size={13} />
            </button>
          </div>
          {query.isLoading ? (
            <div className="stack" style={{ padding: 12 }}>
              <Skeleton h={12} />
              <Skeleton h={12} w="75%" />
            </div>
          ) : items.length === 0 ? (
            <p className="tiny muted" style={{ padding: "18px 12px", lineHeight: 1.55 }}>
              No notifications yet. Finished runs, failures and approvals show up here.
            </p>
          ) : (
            <div className="notif-list">
              {items.map((item) => (
                <button
                  key={item.id}
                  className="notif-item"
                  data-unread={item.readAt ? undefined : "true"}
                  onClick={() => openItem(item)}
                >
                  <span className="notif-kind">{item.kind.replace(/_/g, " ")}</span>
                  <span className="notif-title">{item.title}</span>
                  {item.body ? <span className="notif-body">{item.body}</span> : null}
                  <span className="notif-time">{timeAgo(item.createdAt)}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}

interface PaletteAction {
  id: string;
  label: string;
  hint?: string;
  group: string;
  icon: typeof Home;
  run: () => void;
}

function CommandPalette({
  runs,
  onClose,
  onTheme,
  onSignOut,
}: {
  runs: Task[];
  onClose: () => void;
  onTheme: () => void;
  onSignOut: () => void;
}) {
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);

  const actions = useMemo<PaletteAction[]>(() => {
    const pages = NAV.map((item) => ({
      id: `go-${item.to}`,
      label: item.label,
      group: "Go to",
      icon: item.icon,
      run: () => navigate(item.to),
    }));
    const commands: PaletteAction[] = [
      {
        id: "new-chat",
        label: "New chat",
        hint: "Ask the agent",
        group: "Actions",
        icon: MessageSquare,
        run: () => navigate("/chat"),
      },
      {
        id: "new-run",
        label: "New run",
        hint: "Give it a job",
        group: "Actions",
        icon: Plus,
        run: () => navigate("/tasks?new=1"),
      },
      {
        id: "approvals",
        label: "Review approvals",
        hint: "Needs you",
        group: "Actions",
        icon: ShieldCheck,
        run: () => navigate("/approvals"),
      },
      {
        id: "theme",
        label: "Toggle light and dark",
        group: "Actions",
        icon: Sun,
        run: onTheme,
      },
      { id: "sign-out", label: "Sign out", group: "Actions", icon: LogOut, run: onSignOut },
    ];
    const recent = runs.slice(0, 4).map((task) => ({
      id: `run-${task.id}`,
      label: task.title,
      hint: timeAgo(task.updatedAt),
      group: "Recent runs",
      icon: ListChecks,
      run: () => navigate(`/tasks/${task.id}`),
    }));
    return [...commands, ...recent, ...pages];
  }, [navigate, onTheme, onSignOut, runs]);

  const needle = query.trim().toLowerCase();
  const filtered = actions.filter((action) =>
    `${action.group} ${action.label}`.toLowerCase().includes(needle),
  );

  useEffect(() => {
    setActive(0);
  }, [query]);

  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, []);

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

  let lastGroup = "";

  return (
    <div
      className="scrim"
      style={{ zIndex: "var(--z-palette)", paddingTop: "12vh" }}
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <div className="palette" role="dialog" aria-modal="true" aria-label="Command palette">
        <input
          className="palette-input"
          placeholder="Search pages, runs and actions"
          value={query}
          autoFocus
          onChange={(event) => setQuery(event.target.value)}
        />
        <div className="palette-list">
          {filtered.map((action, index) => {
            const showGroup = action.group !== lastGroup;
            lastGroup = action.group;
            return (
              <div key={action.id}>
                {showGroup ? <div className="palette-group">{action.group}</div> : null}
                <button
                  className="palette-item"
                  data-active={index === active}
                  onMouseEnter={() => setActive(index)}
                  onClick={() => {
                    action.run();
                    onClose();
                  }}
                >
                  <action.icon size={14} aria-hidden />
                  <span className="truncate">{action.label}</span>
                  {action.hint ? <span className="palette-hint">{action.hint}</span> : null}
                  {index === active ? (
                    <ArrowUpRight size={12} aria-hidden style={{ opacity: 0.4 }} />
                  ) : null}
                </button>
              </div>
            );
          })}
          {filtered.length === 0 ? (
            <p className="tiny muted" style={{ padding: "14px 10px" }}>
              Nothing matches “{query}”.
            </p>
          ) : null}
        </div>
        <div
          className="tiny faint"
          style={{
            display: "flex",
            gap: 14,
            padding: "8px 12px",
            borderTop: "1px solid var(--line)",
          }}
        >
          <span className="row" style={{ gap: 4 }}>
            <ArrowUp size={10} /> <ArrowDown size={10} /> navigate
          </span>
          <span>↵ open</span>
          <span style={{ marginLeft: "auto" }}>esc close</span>
        </div>
      </div>
    </div>
  );
}
