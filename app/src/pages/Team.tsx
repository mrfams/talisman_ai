import { useQuery } from "@tanstack/react-query";
import { Users } from "lucide-react";
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
        {me.data ? <Badge tone="info">{me.data.user.role}</Badge> : null}
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
            icon={<Users size={18} />}
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
                      <span className="avatar" aria-hidden>
                        {(member.name ?? member.email).slice(0, 1).toUpperCase()}
                      </span>
                      <div>
                        <div style={{ fontWeight: 550 }}>
                          {member.name ?? member.email.split("@")[0]}
                          {member.userId === me.data?.user.id ? (
                            <span className="tiny faint"> · you</span>
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

      {isAdmin ? (
        <Card>
          <div className="row-between wrap">
            <div>
              <div style={{ fontWeight: 600 }}>Inviting people</div>
              <p className="small muted" style={{ maxWidth: "58ch", marginTop: 4 }}>
                Invitations need an email sender, which this deployment does not have yet. Until
                then, a new person creates their own workspace; seats are not shared automatically.
              </p>
            </div>
            <Badge tone="warn">Not enabled</Badge>
          </div>
        </Card>
      ) : null}
    </div>
  );
}
