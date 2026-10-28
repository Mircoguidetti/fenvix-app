import { backend } from "../lib/env";
import type { UsersClient } from "./users";
import { httpUsers } from "./users-http";

/** The mock is loaded only for VITE_DATA_BACKEND=mock, like the rest of the mock data. */
export const users: UsersClient = backend === "mock" ? (await import("./users-mock")).mockUsers : httpUsers;
