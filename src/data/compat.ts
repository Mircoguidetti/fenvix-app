/*
 * Rollout compatibility (console proof review, 2026-11-23): the console is published on merge, before the API that
 * serves the new fields (and never, if that deploy fails). For one release the console must work against an API
 * without them. Every response the screens read goes through here: what an older API leaves out gets its "nothing to
 * show" value (no proof, nothing not proven, an empty search), never an error and never a green state it did not send.
 */
import { ApiError } from "./api-errors.ts";
import type { DataClient, RunLive } from "./client";
import type { Overview, Page, ProjectRow, Run, RunDetail, SearchResult, TestPage } from "./types";

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

export function compatRun(r: Run): Run {
  const tests = { ...r.tests, notProven: num((r.tests as Partial<Run["tests"]>)?.notProven) };
  return { ...r, tests, proof: r.proof ?? null, exitCode: r.exitCode ?? null };
}

export function compatOverview(o: Overview): Overview {
  const p = (o as Partial<Overview>).proof;
  return { ...o, proof: { runsWithProof: num(p?.runsWithProof), provenIdentical: num(p?.provenIdentical), notProven: num(p?.notProven) }, projects: (o.projects ?? []).map(compatRow) };
}

export const compatRow = (p: ProjectRow): ProjectRow => ({ ...p, lastRunNotProven: num((p as Partial<ProjectRow>).lastRunNotProven) });

export function compatTests(t: TestPage): TestPage {
  return { ...t, counts: { ...t.counts, not_proven: num((t.counts as Partial<TestPage["counts"]>)?.not_proven) }, items: t.items.map((x) => ({ ...x, notProvenCause: x.notProvenCause ?? null })) };
}

const compatDetail = (d: RunDetail | null): RunDetail | null => (d ? { ...d, run: compatRun(d.run) } : d);

/** The search of an API without GET /search: no results (a 404 or 405 is "not there yet"), never an error on screen. */
async function compatSearch(p: Promise<SearchResult[]>): Promise<SearchResult[]> {
  try {
    return (await p) ?? [];
  } catch (e) {
    if (e instanceof ApiError && (e.status === 404 || e.status === 405)) return [];
    throw e;
  }
}

/** The client the screens use: the same calls, with the responses above made complete. Other members pass through. */
export function withCompat<C extends DataClient>(c: C): C {
  const wrapped: Partial<DataClient> = {
    getOverview: async () => compatOverview(await c.getOverview()),
    listProjects: async () => (await c.listProjects()).map(compatRow),
    getProject: async (id) => {
      const p = await c.getProject(id);
      return p ? compatRow(p) : p;
    },
    listRuns: async (id, q) => {
      const page: Page<Run> = await c.listRuns(id, q);
      return { ...page, items: page.items.map(compatRun) };
    },
    getRun: async (id) => compatDetail(await c.getRun(id)),
    getRunLive: async (id, etag) => {
      const r: RunLive = await c.getRunLive(id, etag);
      return r.notModified ? r : { ...r, detail: compatDetail(r.detail)! };
    },
    listTestResults: async (id, q) => compatTests(await c.listTestResults(id, q)),
    search: (q) => compatSearch(c.search ? c.search(q) : Promise.resolve([])),
  };
  return new Proxy(c, { get: (target, key, recv) => (key in wrapped ? wrapped[key as keyof DataClient] : Reflect.get(target, key, recv)) });
}
