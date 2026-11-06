import { Link } from "react-router-dom";
import { Button, Empty } from "../ui";
import { Compass } from "lucide-react";

export function NotFound() {
  return (
    <div className="page">
      <Empty
        icon={<Compass size={18} />}
        title="This page does not exist"
        body="The link may be old, or the thing it pointed at was deleted. Nothing was lost — head back to Today."
        action={
          <Link to="/" style={{ textDecoration: "none" }}>
            <Button variant="primary">Go to Today</Button>
          </Link>
        }
      />
    </div>
  );
}
