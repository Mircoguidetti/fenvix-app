import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { session, type SessionUser } from "./index";
import { SESSION_ENDED_EVENT, markSessionEnded, rememberReturnPath } from "../lib/returnPath";

interface SessionState {
  status: "loading" | "ready";
  user: SessionUser | null;
  setUser: (user: SessionUser | null) => void;
  signOut: () => Promise<void>;
}

const Ctx = createContext<SessionState>({ status: "loading", user: null, setUser: () => {}, signOut: async () => {} });

export function SessionProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<{ status: "loading" | "ready"; user: SessionUser | null }>({ status: "loading", user: null });

  useEffect(() => {
    let alive = true;
    session.getSession().then(
      (user) => alive && setState({ status: "ready", user }),
      () => alive && setState({ status: "ready", user: null }),
    );
    // Sign-in, sign-out and token refreshes, including in another tab. A client that cannot
    // subscribe must never take the whole screen down: the sign-in page explains the problem.
    let stop: (() => void) | undefined;
    try {
      stop = session.subscribe?.((user) => alive && setState({ status: "ready", user }));
    } catch {
      stop = undefined;
    }
    // The API said the session is over (401): sign out here, keep the page to come back to, show the sign-in page.
    const ended = () => {
      if (!alive) return;
      rememberReturnPath(window.location.pathname + window.location.search);
      markSessionEnded();
      void session.signOut().catch(() => undefined);
      setState({ status: "ready", user: null });
    };
    window.addEventListener(SESSION_ENDED_EVENT, ended);
    return () => {
      alive = false;
      stop?.();
      window.removeEventListener(SESSION_ENDED_EVENT, ended);
    };
  }, []);

  const setUser = useCallback((user: SessionUser | null) => setState({ status: "ready", user }), []);
  const signOut = useCallback(async () => {
    await session.signOut();
    setState({ status: "ready", user: null });
  }, []);
  const value = useMemo(() => ({ ...state, setUser, signOut }), [state, setUser, signOut]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export const useSession = () => useContext(Ctx);
