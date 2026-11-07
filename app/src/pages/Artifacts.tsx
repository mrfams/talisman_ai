import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Download, FileArchive, FileImage, FileText, Package, Search } from "lucide-react";
import { api, type Artifact } from "../lib/api";
import { errorMessage } from "../lib/queries";
import { Badge, Button, Card, Empty, Notice, Skeleton, bytes, timeAgo } from "../ui";

function iconFor(mime: string) {
  if (mime.startsWith("image/")) return <FileImage size={15} />;
  if (mime.includes("zip") || mime.includes("tar")) return <FileArchive size={15} />;
  return <FileText size={15} />;
}

function typeLabel(mime: string): string {
  const tail = mime.split("/").pop() ?? mime;
  return tail.toUpperCase();
}

function FileCard({ artifact }: { artifact: Artifact }) {
  return (
    <div className="file-card">
      <div className="row" style={{ gap: 9 }}>
        <span className="file-icon">{iconFor(artifact.mime)}</span>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div className="file-name" title={artifact.name}>
            {artifact.name}
          </div>
          <div className="file-meta" style={{ marginTop: 2 }}>
            {typeLabel(artifact.mime)}
          </div>
        </div>
      </div>
      <div className="row" style={{ gap: 6 }}>
        <span className="file-meta">{bytes(artifact.sizeBytes)}</span>
        <span className="file-meta">·</span>
        <span className="file-meta">{timeAgo(artifact.createdAt)}</span>
        <span style={{ marginLeft: "auto" }}>
          <Badge tone="plain">{artifact.sha256.slice(0, 7)}</Badge>
        </span>
      </div>
      <div className="file-foot">
        {artifact.taskId ? (
          <Link to={`/tasks/${artifact.taskId}`} className="tiny muted">
            Open run
          </Link>
        ) : (
          <span className="tiny faint">No run</span>
        )}
        <a href={api.artifactUrl(artifact.id)} download aria-label={`Download ${artifact.name}`}>
          <Button size="sm" icon={<Download size={12} />}>
            Download
          </Button>
        </a>
      </div>
    </div>
  );
}

export function Artifacts() {
  const query = useQuery({ queryKey: ["artifacts"], queryFn: api.artifacts });
  const [filter, setFilter] = useState("");

  const all = query.data?.artifacts ?? [];
  const needle = filter.trim().toLowerCase();
  const rows = all.filter((artifact) =>
    `${artifact.name} ${artifact.mime}`.toLowerCase().includes(needle),
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
        <label className="search">
          <Search size={13} aria-hidden />
          <input
            placeholder="Filter files"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            aria-label="Filter artifacts"
          />
        </label>
      </div>

      {query.isError ? <Notice tone="bad">{errorMessage(query.error)}</Notice> : null}

      {query.isLoading ? (
        <div className="file-grid">
          {[0, 1, 2].map((key) => (
            <Card key={key}>
              <Skeleton h={90} />
            </Card>
          ))}
        </div>
      ) : rows.length === 0 ? (
        <Card>
          <Empty
            icon={<Package size={15} />}
            title={needle ? "Nothing matches that filter" : "No artifacts yet"}
            body={
              needle
                ? "Try a shorter search, or clear it to see everything."
                : "When a run writes a PDF, a document, or a data file, it lands here and stays attached to the run that made it."
            }
            action={
              needle ? (
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
        </Card>
      ) : (
        <>
          <div className="toolbar">
            <span className="count-note">
              {rows.length}
              {needle ? ` of ${all.length}` : ""} file{rows.length === 1 ? "" : "s"}
            </span>
            <span className="tiny faint">
              Stored in {query.data ? "this deployment" : "—"} · content-addressed
            </span>
          </div>
          <div className="file-grid">
            {rows.map((artifact) => (
              <FileCard key={artifact.id} artifact={artifact} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}
