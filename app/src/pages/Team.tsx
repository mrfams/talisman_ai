import { useQuery } from "@tanstack/react-query";
import { MailPlus, Users } from "lucide-react";
import { api } from "../lib/api";
import { errorMessage, useMe } from "../lib/queries";
import { Badge, Card, Empty, Notice, Skeleton, timeAgo } from "../ui";

export function Team() {
  const me = useMe();
  const query = useQuery({ queryKey: ["team"], queryFn: api.team });

  const members = query.data?.members ?? [];
  const isAdmin = me.data?.user.role !== "member";

  return (
    <div className="page">
      <div className="page-head">
        <div className="stack" style={{ gap: 4 }}>
          <h1 className="page-title">Team</h1>
          <p className="page-sub">
            People with access to this workspace. Runs, artifacts and connectors are never shared
            across accounts.
          </p>
        </div>
        <div className="row" style={{ gap: 8 }}>
          {members.length ? <span className="count-note">{members.length} member{members.length === 1 ? "" : "s"}</span> : null}
          {me.data ? <Badge tone="info">{me.data.user.role}</Badge> : null}
        </div>
      </div>

      {query.isError ? <Notice tone="bad">{errorMessage(query.error)}</Notice> : null}

      <Card flush>
        {query.isLoading ? (
          <div className="card-body stack">
            <Skeleton h={18} w="50%" />
            <Skeleton h={18} w="35%" />
          </div>
        ) : members.length === 0 ? (
          <Empty
            icon={<Users size={15} />}
            title="No members loaded"
            body="The workspace membership list could not be read. Try again in a moment."
          />
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Person</th>
                <th>Role</th>
                <th style={{ textAlign: "right" }}>Joined</th>
              </tr>
            </thead>
            <tbody>
              {members.map((member) => (
                <tr key={member.userId}>
                  <td>
                    <div className="row" style={{ gap: 10 }}>
                      <span className="avatar avatar-lg" aria-hidden>
                        {(member.name ?? member.email).slice(0, 1).toUpperCase()}
                      </span>
                      <div>
                        <div className="cell-title">
                          {member.name ?? member.email.split("@")[0]}
                          {member.userId === me.data?.user.id ? (
                            <span className="tiny faint" style={{ fontWeight: 400 }}>
                              {" "}
                              · you
                            </span>
                          ) : null}
                        </div>
                        <div className="tiny faint">{member.email}</div>
                      </div>
                    </div>
                  </td>
                  <td>
                    <Badge tone={member.role === "owner" ? "info" : "plain"}>{member.role}</Badge>
                  </td>
                  <td className="num">{timeAgo(member.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      <div className="grid-2" style={{ alignItems: "start" }}>
        <Card>
          <h2 className="section-title">Roles</h2>
          <div className="kv" style={{ marginTop: 6 }}>
            <div className="kv-row">
              <span className="kv-label">Owner</span>
              <span className="kv-value">Full control of the workspace and its people</span>
            </div>
            <div className="kv-row">
              <span className="kv-label">Admin</span>
              <span className="kv-value">Members, connectors and all runs</span>
            </div>
            <div className="kv-row">
              <span className="kv-label">Member</span>
              <span className="kv-value">Own runs, chat and artifacts</span>
            </div>
          </div>
        </Card>

        {isAdmin ? (
          <Card>
            <div className="row-between" style={{ alignItems: "flex-start" }}>
              <div className="row" style={{ gap: 9, alignItems: "flex-start" }}>
                <span className="provider-icon">
                  <MailPlus size={15} />
                </span>
                <div>
                  <div className="provider-name">Invite people</div>
                  <p className="tiny muted" style={{ maxWidth: "46ch", marginTop: 3, lineHeight: 1.55 }}>
                    Invitations need an email sender, which this deployment does not have yet. Until
                    then, a new person creates their own workspace; seats are not shared
                    automatically.
                  </p>
                </div>
              </div>
              <Badge tone="warn">Not enabled</Badge>
            </div>
          </Card>
        ) : null}
      </div>
    </div>
  );
}
