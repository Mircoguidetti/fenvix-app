import { backend } from "../lib/env";
import type { DataClient } from "./client";
import { supabaseClient } from "./supabase";

/**
 * The single place that picks the data source. VITE_DATA_BACKEND=mock uses the mock, which is
 * loaded on demand: a Supabase build never downloads it or builds its fake fleet.
 */
export const client: DataClient = backend === "mock" ? (await import("./mock")).mockClient : supabaseClient;
export type { DataClient } from "./client";
export * from "./types";

// The Playwright checks call the mock "server" directly to show that it refuses what a member's screens hide.
if (backend === "mock") Object.assign(window, { __fenvixMock: client });
