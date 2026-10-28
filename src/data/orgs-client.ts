import { backend } from "../lib/env";
import type { OrgsClient } from "./orgs";
import { httpOrgs } from "./orgs-http";

/** The mock is loaded only for VITE_DATA_BACKEND=mock, like the rest of the mock data. */
export const orgs: OrgsClient = backend === "mock" ? (await import("./orgs-mock")).mockOrgs : httpOrgs;
