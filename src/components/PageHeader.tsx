import type { ReactNode } from "react";

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

export function Message({ children, role = "status" }: { children: ReactNode; role?: "status" | "alert" }) {
  return (
    <p className="message" role={role}>
      {children}
    </p>
  );
}
