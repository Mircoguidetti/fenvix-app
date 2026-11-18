import { backend } from "../lib/env";
import type { DataClient } from "./client";

/**
 * The single place that picks the data source:
 *   - by default, the fenvix API at VITE_API_URL (src/data/api.ts): the dashboard never reaches the database;
 *   - VITE_DATA_BACKEND=mock: the sample data, for local development and the checks, loaded on demand (a real build
 *     never downloads it).
 */
export const client: DataClient = backend === "mock" ? (await import("./mock")).mockClient : (await import("./api-browser")).apiClient;
export type { DataClient, RunLive, RunQuery } from "./client";
export * from "./types";

// The Playwright checks call the mock "server" directly to show that it refuses what a member's screens hide.
if (backend === "mock") Object.assign(window, { __fenvixMock: client });
