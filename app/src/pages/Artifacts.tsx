import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Download, FileText, Package, Search } from "lucide-react";
import { api } from "../lib/api";
import { errorMessage } from "../lib/queries";
import { Badge, Button, Card, Empty, Input, Notice, Skeleton, bytes, timeAgo } from "../ui";

export function Artifacts() {
  const query = useQuery({ queryKey: ["artifacts"], queryFn: api.artifacts });
  const [filter, setFilter] = useState("");

  const all = query.data?.artifacts ?? [];
  const rows = all.filter((artifact) =>
    `${artifact.name} ${artifact.mime}`.toLowerCase().includes(filter.trim().toLowerCase()),
  );

  return (
    <div className="page">
      <div className="page-head">
        <div className="stack" style={{ gap: 4 }}>
          <h1 className="page-title">Artifacts</h1>
          <p className="page-sub">
            Every file a run produced, with the hash it was written at. Downloads come straight from
            this deployment.
          </p>
        </div>
        <div className="row" style={{ width: "min(280px, 100%)" }}>
          <Search size={14} className="faint" aria-hidden />
          <Input
            placeholder="Filter by name or type"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            aria-label="Filter artifacts"
          />
        </div>
      </div>

      {query.isError ? <Notice tone="bad">{errorMessage(query.error)}</Notice> : null}

      <Card flush>
        {query.isLoading ? (
          <div className="card-body stack">
            <Skeleton h={18} w="55%" />
            <Skeleton h={18} w="40%" />
          </div>
        ) : rows.length === 0 ? (
          <Empty
            icon={<Package size={18} />}
            title={filter ? "Nothing matches that filter" : "No artifacts yet"}
            body={
              filter
                ? "Try a shorter search, or clear it to see everything."
                : "When a run writes a PDF, a document, or a data file, it lands here and stays attached to the run that made it."
            }
            action={
              filter ? (
                <Button size="sm" onClick={() => setFilter("")}>
                  Clear filter
                </Button>
              ) : (
                <Link to="/tasks">
                  <Button size="sm">Open runs</Button>
                </Link>
              )
            }
          />
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table className="table">
              <thead>
                <tr>
                  <th>File</th>
                  <th>Type</th>
                  <th style={{ textAlign: "right" }}>Size</th>
                  <th>Created</th>
                  <th>Run</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((artifact) => (
                  <tr key={artifact.id}>
                    <td>
                      <div className="row" style={{ gap: 8 }}>
                        <FileText size={14} className="muted" aria-hidden />
                        <span style={{ fontWeight: 550 }}>{artifact.name}</span>
                      </div>
                      <div className="mono tiny faint">{artifact.sha256.slice(0, 16)}</div>
                    </td>
                    <td>
                      <Badge tone="info">{artifact.mime.split("/").pop()}</Badge>
                    </td>
                    <td className="num">{bytes(artifact.sizeBytes)}</td>
                    <td className="num">{timeAgo(artifact.createdAt)}</td>
                    <td>
                      {artifact.taskId ? (
                        <Link to={`/tasks/${artifact.taskId}`} className="tiny">
                          Open
                        </Link>
                      ) : (
                        <span className="tiny faint">—</span>
                      )}
                    </td>
                    <td style={{ textAlign: "right" }}>
                      <a href={api.artifactUrl(artifact.id)} aria-label={`Download ${artifact.name}`}>
                        <Button size="sm" icon={<Download size={13} />}>
                          Download
                        </Button>
                      </a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
