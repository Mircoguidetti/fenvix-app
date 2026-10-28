import { backend } from "../lib/env";
import type { SessionClient } from "./client";
import { mockSession } from "./mock";
import { supabaseSession } from "./supabase";

/** The single place that picks the sign-in implementation. VITE_DATA_BACKEND=mock uses the mock. */
export const session: SessionClient = backend === "mock" ? mockSession : supabaseSession;
export type { SessionClient, SessionUser, AuthProvider, LinkedIdentity } from "./client";
