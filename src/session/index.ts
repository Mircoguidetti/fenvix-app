import type { SessionClient } from "./client";
import { mockSession } from "./mock";

/** The single place that picks the sign-in implementation. Swap `mockSession` for a real one later. */
export const session: SessionClient = mockSession;
export type { SessionClient, SessionUser, AuthProvider } from "./client";
