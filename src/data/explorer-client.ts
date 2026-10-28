import { backend } from "../lib/env";
import type { ExplorerClient } from "./explorer";
import { httpExplorer } from "./explorer-http";

/** The mock is loaded only for VITE_DATA_BACKEND=mock, like the rest of the mock data. */
export const explorer: ExplorerClient = backend === "mock" ? (await import("./explorer-mock")).mockExplorer : httpExplorer;
