import { useCallback, useEffect, useState } from "react";

export type AsyncState<T> = { status: "loading" } | { status: "error"; message: string } | { status: "ready"; data: T };

/** Runs a client call on mount (and when `deps` change). `reload` runs it again. */
export function useAsync<T>(load: () => Promise<T>, deps: unknown[]): AsyncState<T> & { reload: () => void; setData: (v: T) => void } {
  const [state, setState] = useState<AsyncState<T>>({ status: "loading" });
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let alive = true;
    load().then(
      (data) => alive && setState({ status: "ready", data }),
      (e: unknown) => alive && setState({ status: "error", message: e instanceof Error ? e.message : "Something went wrong" }),
    );
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);

  const reload = useCallback(() => setTick((t) => t + 1), []);
  const setData = useCallback((data: T) => setState({ status: "ready", data }), []);
  return { ...state, reload, setData };
}
