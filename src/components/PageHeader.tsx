import type { ReactNode } from "react";
import { CircleAlert, TriangleAlert } from "lucide-react";
import { useCurrentOrg } from "./AccountMenu";

/** `meta` sits next to the title (a state badge, a region); `actions` sit at the far end. */
export function PageHeader({ title, description, actions, back, meta }: { title: ReactNode; description?: ReactNode; actions?: ReactNode; back?: ReactNode; meta?: ReactNode }) {
  return (
    <header className="page-header">
      <div className="page-header-main">
        {back}
        <div className="page-title-row">
          <h1>{title}</h1>
          {meta}
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

/** The small line above a page title: where the page sits (the organization's name, or a fixed word). */
export function Kicker({ children }: { children?: ReactNode }) {
  const current = useCurrentOrg();
  const text = children ?? (current.status === "ready" ? current.name : " ");
  return <p className="page-kicker">{text}</p>;
}

/**
 * A load that failed: the error in red and a button that asks again (audit G-1691). Every screen shows a failed read
 * with this, never as "Loading" for ever (G-1690, G-1692 to G-1694, G-2277 to G-2282).
 */
export function LoadError({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="load-error">
      <Message role="alert">{message}</Message>
      {onRetry && (
        <button type="button" className="btn btn-sm" onClick={onRetry}>
          Try again
        </button>
      )}
    </div>
  );
}

type Loadable<T> = ({ status: "loading" } | { status: "error"; message: string } | { status: "ready"; data: T }) & { reload?: () => void };

/**
 * The three states of a read, each drawn: "loading" says what is loading, "error" is a LoadError with Try again,
 * "ready" renders `children`. A read that failed can never look like one still loading or like an empty result.
 */
export function Await<T>({ state, loading, children }: { state: Loadable<T>; loading: string; children: (data: T) => ReactNode }) {
  if (state.status === "loading") return <Message>{loading}</Message>;
  if (state.status === "error") return <LoadError message={state.message} onRetry={state.reload} />;
  return <>{children(state.data)}</>;
}
