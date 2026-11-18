/**
 * The API clients wired to the browser: VITE_API_URL, the Supabase session's access token (Supabase is only used for
 * sign-in) and the organization chosen in the browser, sent as X-Fenvix-Workspace.
 */
import { apiUrl } from "../lib/env";
import { getSupabase } from "../lib/supabaseClient";
import { activeWorkspaceId } from "../lib/org";
import { blobUrl } from "../lib/download";
import { createApiDataClient, createApiOrgsClient, type ApiConfig } from "./api";

const config: ApiConfig = {
  baseUrl: apiUrl,
  async token() {
    const { data } = await getSupabase().auth.getSession();
    return data.session?.access_token ?? null;
  },
  workspace: activeWorkspaceId,
  blobUrl,
};

export const apiClient = createApiDataClient(config);
export const apiOrgs = createApiOrgsClient(config);
