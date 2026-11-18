// The dashboard API as a plain Node server, for local development and the end-to-end checks of every page
// (scripts/e2e-real-api.mjs). Production runs it on Lambda (src/lambda/api.ts). Settings from the environment, as in
// src/api/config.ts. The setup pull request is not sent to a worker here: the queued work is logged (WORK_LOG=1).
//
//   API_DATABASE_URL=… SUPABASE_URL=http://127.0.0.1:54320 STATE_SIGNING_KEY=… DASHBOARD_URL=http://localhost:4173 \
//   GITHUB_APP_SLUG=fenvix-local PORT=8791 node src/api/local.ts
import { loadApiConfig } from "./config.ts";
import { buildApi } from "./server.ts";

const cfg = loadApiConfig(process.env);
const queued: unknown[] = [];
const api = buildApi({
  cfg,
  queue: { enqueue: async (work) => { queued.push(work); if (process.env.WORK_LOG) console.log(JSON.stringify({ queued: work })); } },
});
await api.fastify.listen({ port: cfg.port, host: cfg.host });
const stop = async () => { await api.close(); process.exit(0); };
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
