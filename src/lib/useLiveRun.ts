import { useEffect, useRef, useState } from "react";
import { client, type RunDetail } from "../data";

/** How often the live view asks while a run is running (the API asks for every 3 to 5 seconds). */
export const LIVE_POLL_MS = 4000;

/** The checks may ask faster, on the mock only (window.__fenvixPollMs). */
function pollMs(): number {
  const fast = client.sample ? Number((window as unknown as { __fenvixPollMs?: number }).__fenvixPollMs) : NaN;
  return Number.isFinite(fast) && fast > 0 ? fast : LIVE_POLL_MS;
}

const visible = () => typeof document === "undefined" || document.visibilityState === "visible";

/**
 * The live view of a run: while its status is "running" and the page is open and visible, GET /runs/{runId} every
 * 4 seconds with the last ETag as If-None-Match (304: nothing changed). It stops when the run has finished, when the
 * page is hidden (and starts again when it is shown) and when the page closes. No WebSocket.
 * Returns the newest detail, or `initial` until a poll brings a change.
 */
export function useLiveRun(runId: string, initial: RunDetail | null): { detail: RunDetail | null; polling: boolean } {
  const [detail, setDetail] = useState<RunDetail | null>(initial);
  const [polling, setPolling] = useState(false);
  const etag = useRef<string | null>(null);

  // A newly loaded run (another id, or a reload) replaces what the live view held.
  useEffect(() => {
    setDetail(initial);
    etag.current = null;
  }, [initial]);

  const running = detail?.run.status === "running" && detail.run.id === runId;

  useEffect(() => {
    if (!running) {
      setPolling(false);
      return;
    }
    let timer: number | undefined;
    let stopped = false;
    let inFlight = false;

    const schedule = () => {
      window.clearTimeout(timer);
      if (stopped || !visible()) {
        setPolling(false);
        return;
      }
      setPolling(true);
      timer = window.setTimeout(tick, pollMs());
    };

    async function tick() {
      if (stopped || !visible() || inFlight) return;
      inFlight = true;
      try {
        const live = await client.getRunLive(runId, etag.current);
        if (stopped) return;
        if (!live.notModified) {
          etag.current = live.etag;
          setDetail(live.detail);
          // A finished run ends the polling: the effect re-runs with running = false and stops.
          if (live.detail.run.status !== "running") return;
        }
      } catch {
        /* a failed poll is tried again at the next tick */
      } finally {
        inFlight = false;
      }
      schedule();
    }

    const onVisibility = () => {
      if (visible()) schedule();
      else {
        window.clearTimeout(timer);
        setPolling(false);
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    schedule();
    return () => {
      stopped = true;
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [running, runId]);

  return { detail, polling };
}
