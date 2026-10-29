import { useEffect, useId, useRef, useState } from "react";
import { ChevronUp, LogOut } from "lucide-react";
import { useSession } from "../session/SessionProvider";
import { useToast } from "./Toast";

const initials = (name: string) => name.split(/\s+/).map((p) => p[0]).slice(0, 2).join("").toUpperCase();

/** Name, email and sign out. A disclosure button; Escape or a click outside closes it. */
export function UserMenu() {
  const { user, signOut } = useSession();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const panelId = useId();

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    const onClick = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onClick);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onClick);
    };
  }, [open]);

  if (!user) return null;
  return (
    <div className="user-menu" ref={ref}>
      <button type="button" className="user-btn" aria-expanded={open} aria-controls={panelId} onClick={() => setOpen((o) => !o)}>
        {user.avatarUrl ? (
          <img className="avatar avatar-photo" src={user.avatarUrl} alt="" width={28} height={28} referrerPolicy="no-referrer" />
        ) : (
          <span className="avatar" aria-hidden="true">
            {initials(user.name)}
          </span>
        )}
        <span className="user-name">{user.name}</span>
        <ChevronUp size={16} aria-hidden="true" className={open ? "flip" : ""} />
      </button>
      {open && (
        <div id={panelId} className="user-panel" role="group" aria-label="Account">
          <p className="user-full">{user.name}</p>
          <p className="muted small user-email">{user.email}</p>
          <button
            type="button"
            className="btn btn-block"
            onClick={async () => {
              setOpen(false);
              await signOut();
              toast("Signed out", "success");
            }}
          >
            <LogOut size={16} aria-hidden="true" />
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}
