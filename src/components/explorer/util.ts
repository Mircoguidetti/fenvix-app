import { ExplorerError } from "../../data/explorer";

const WAKE_RETRIES = 5;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Runs a call; while the database wakes (503) it waits as asked and tries again, and tells the page it is waking. */
export async function waking<T>(work: () => Promise<T>, onWaking: (on: boolean) => void, slowMs = 900): Promise<T> {
  const slow = setTimeout(() => onWaking(true), slowMs);
  try {
    for (let attempt = 0; ; attempt++) {
      try {
        return await work();
      } catch (e) {
        if (!(e instanceof ExplorerError) || !e.waking || attempt >= WAKE_RETRIES) throw e;
        onWaking(true);
        await sleep((e.retryAfter ?? 2) * 1000);
      }
    }
  } finally {
    clearTimeout(slow);
    onWaking(false);
  }
}

/** A new ObjectId (time, then random), as MongoDB makes them. */
export function newObjectId(): string {
  const time = Math.floor(Date.now() / 1000).toString(16).padStart(8, "0");
  const rand = Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, "0")).join("");
  return time + rand;
}

export const message = (e: unknown) => (e instanceof Error ? e.message : "Something went wrong. Try again.");
