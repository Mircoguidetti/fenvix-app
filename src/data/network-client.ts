import { backend } from "../lib/env";
import type { NetworkClient } from "./network";
import { httpNetwork } from "./network-http";

/** The mock is loaded only for VITE_DATA_BACKEND=mock, like the rest of the mock data. */
export const network: NetworkClient = backend === "mock" ? (await import("./network-mock")).mockNetwork : httpNetwork;
