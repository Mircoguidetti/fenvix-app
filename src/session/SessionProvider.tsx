import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { session, type SessionUser } from "./index";

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
    session.getSession().then((user) => alive && setState({ status: "ready", user }), () => alive && setState({ status: "ready", user: null }));
    return () => {
      alive = false;
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
