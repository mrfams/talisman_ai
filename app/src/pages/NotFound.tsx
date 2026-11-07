import { Link } from "react-router-dom";
import { ArrowLeft } from "lucide-react";
import { Button } from "../ui";
import { BrandMark } from "../BrandMark";

export function NotFound() {
  return (
    <div className="page" style={{ minHeight: "70vh", justifyContent: "center" }}>
      <div className="notfound">
        <span className="chat-empty-mark">
          <BrandMark size={26} />
        </span>
        <span className="eyebrow">404</span>
        <h1 className="page-title" style={{ fontSize: 26 }}>
          This page does not exist
        </h1>
        <p className="page-sub" style={{ maxWidth: "42ch" }}>
          The link may be old, or the thing it pointed at was deleted. Nothing was lost.
        </p>
        <div className="row" style={{ gap: 8, marginTop: 4 }}>
          <Link to="/">
            <Button variant="primary">Go to Today</Button>
          </Link>
          <Link to="/tasks">
            <Button icon={<ArrowLeft size={13} />}>Open runs</Button>
          </Link>
        </div>
      </div>
    </div>
  );
}
