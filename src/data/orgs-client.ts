import { backend } from "../lib/env";
import type { OrgsClient } from "./orgs";

/** Organizations through the fenvix API; the mock is loaded only for VITE_DATA_BACKEND=mock, like the rest of the mock data. */
export const orgs: OrgsClient = backend === "mock" ? (await import("./orgs-mock")).mockOrgs : (await import("./api-browser")).apiOrgs;
