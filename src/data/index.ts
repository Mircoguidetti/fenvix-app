import { backend } from "../lib/env";
import type { DataClient } from "./client";
import { createHttpDataClient } from "./api-http";
import { httpConfig } from "./explorer-http";
import { httpRequest } from "./http";

/**
 * The single place that picks the data source:
 *   - VITE_DATA_BACKEND=mock: the mock, loaded on demand (a real build never downloads it or builds its fake fleet);
 *   - VITE_API_URL set: the control plane over HTTP, the same way as the Data Explorer, users, network and
 *     organizations (session token as Bearer, the chosen organization's header, the same errors). The test is on
 *     import.meta.env itself so the build can see it: a build with VITE_API_URL does not contain the Supabase data
 *     client at all;
 *   - otherwise: the Supabase functions, as before the control plane existed.
 */
export const client: DataClient =
  backend === "mock"
    ? (await import("./mock")).mockClient
    : import.meta.env.VITE_API_URL
      ? createHttpDataClient({ request: (method, path, opts) => httpRequest(httpConfig, method, path, opts) })
      : (await import("./supabase")).supabaseClient;
export type { DataClient } from "./client";
export * from "./types";

// The Playwright checks call the mock "server" directly to show that it refuses what a member's screens hide.
if (backend === "mock") Object.assign(window, { __fenvixMock: client });
