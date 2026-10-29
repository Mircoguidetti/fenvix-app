import type { ReactNode } from "react";
import { CircleAlert, TriangleAlert } from "lucide-react";

export function PageHeader({ title, description, actions, back }: { title: ReactNode; description?: ReactNode; actions?: ReactNode; back?: ReactNode }) {
  return (
    <header className="page-header">
      <div className="page-header-main">
        {back}
        <div className="page-title-row">
          <h1>{title}</h1>
        </div>
        {description && <p className="muted page-desc">{description}</p>}
      </div>
      {actions && <div className="page-actions">{actions}</div>}
    </header>
  );
}

export function Card({ title, description, tag, actions, children, id }: { title: ReactNode; description?: ReactNode; tag?: ReactNode; actions?: ReactNode; children?: ReactNode; id?: string }) {
  const headingId = id ? `${id}-h` : undefined;
  return (
    <section className="card" id={id} aria-labelledby={headingId}>
      <div className="card-head">
        <div className="card-head-main">
          <h2 id={headingId}>{title}</h2>
          {description && <p className="muted card-desc">{description}</p>}
        </div>
        {actions}
        {tag}
      </div>
      {children}
    </section>
  );
}

/**
 * A line of status. role "alert" is an error and shows in red with an icon. tone "warning" is a note that needs
 * attention and shows an amber icon. Otherwise it is plain grey text.
 */
export function Message({ children, role = "status", tone }: { children: ReactNode; role?: "status" | "alert"; tone?: "warning" }) {
  if (role === "alert")
    return (
      <p className="message message-error" role="alert">
        <CircleAlert size={16} aria-hidden="true" />
        <span>{children}</span>
      </p>
    );
  if (tone === "warning")
    return (
      <p className="message message-warning" role={role}>
        <TriangleAlert size={16} aria-hidden="true" />
        <span>{children}</span>
      </p>
    );
  return (
    <p className="message" role={role}>
      {children}
    </p>
  );
}
