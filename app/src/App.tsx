import { Navigate, Outlet, Route, Routes } from "react-router-dom";
import { useMe } from "./lib/queries";
import { AppShell } from "./shell/AppShell";
import { SignIn } from "./pages/SignIn";
import { Today } from "./pages/Today";
import { Chat } from "./pages/Chat";
import { Tasks } from "./pages/Tasks";
import { TaskDetail } from "./pages/TaskDetail";
import { Connectors } from "./pages/Connectors";
import { Artifacts } from "./pages/Artifacts";
import { Approvals } from "./pages/Approvals";
import { Activity } from "./pages/Activity";
import { Team } from "./pages/Team";
import { Devices } from "./pages/Devices";
import { Settings } from "./pages/Settings";
import { Schedules } from "./pages/Schedules";
import { NotFound } from "./pages/NotFound";

function RequireAuth() {
  const me = useMe();
  if (me.isLoading) {
    return (
      <div className="page" aria-busy="true">
        <div className="skeleton" style={{ height: 18, width: 180 }} />
        <div className="skeleton" style={{ height: 120 }} />
        <div className="skeleton" style={{ height: 240 }} />
      </div>
    );
  }
  if (me.isError) return <Navigate to="/sign-in" replace />;
  return <Outlet />;
}

export function App() {
  return (
    <Routes>
      <Route path="/sign-in" element={<SignIn mode="in" />} />
      <Route path="/sign-up" element={<SignIn mode="up" />} />
      <Route element={<RequireAuth />}>
        <Route element={<AppShell />}>
          <Route index element={<Today />} />
          <Route path="chat" element={<Chat />} />
          <Route path="chat/:id" element={<Chat />} />
          <Route path="tasks" element={<Tasks />} />
          <Route path="tasks/:id" element={<TaskDetail />} />
          <Route path="artifacts" element={<Artifacts />} />
          <Route path="approvals" element={<Approvals />} />
          <Route path="schedules" element={<Schedules />} />
          <Route path="activity" element={<Activity />} />
          <Route path="team" element={<Team />} />
          <Route path="connectors" element={<Connectors />} />
          <Route path="devices" element={<Devices />} />
          <Route path="settings" element={<Settings />} />
          <Route path="*" element={<NotFound />} />
        </Route>
      </Route>
    </Routes>
  );
}
