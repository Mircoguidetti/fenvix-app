import type { DataClient } from "./client";
import { mockClient } from "./mock";

/** The single place that picks the data source. Swap `mockClient` for a real API client later. */
export const client: DataClient = mockClient;
export type { DataClient } from "./client";
export * from "./types";
