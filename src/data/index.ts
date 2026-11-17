import { backend } from "../lib/env";
import type { DataClient } from "./client";

/**
 * The single place that picks the data source:
 *   - VITE_DATA_BACKEND=mock: the sample data, loaded on demand (a real build never downloads it);
 *   - otherwise: the CI tables on Supabase (supabase/migrations/0011_ci_runs.sql), read under row level security.
 * Organizations and members still go to the control plane when VITE_API_URL is set (src/data/orgs-client.ts).
 */
export const client: DataClient = backend === "mock" ? (await import("./mock")).mockClient : (await import("./supabase")).supabaseClient;
export type { DataClient, RunQuery } from "./client";
export * from "./types";

// The Playwright checks call the mock "server" directly to show that it refuses what a member's screens hide.
if (backend === "mock") Object.assign(window, { __fenvixMock: client });
