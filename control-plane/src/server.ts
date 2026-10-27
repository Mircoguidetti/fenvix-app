import { buildApp } from "./app.ts";
import { loadConfig } from "./config.ts";
import { SupabaseGateway } from "./auth/gateway.ts";
import { FakeEngine } from "./engine/fake.ts";
import type { EngineClient } from "./engine/types.ts";

function makeEngine(driver: string): EngineClient {
  if (driver === "fake") {
    console.warn(JSON.stringify({ level: "warn", msg: "ENGINE_DRIVER=fake: databases exist only in this process's memory. Never use this in production." }));
    return new FakeEngine();
  }
  throw new Error(
    `ENGINE_DRIVER=${driver} is not available. Only "fake" exists: the engine admin interface (test5, branch control-ops) was not available when this service was written. See control-plane/docs/engine-adapter.md.`,
  );
}

let cfg;
try {
  cfg = loadConfig();
} catch (e) {
  console.error(JSON.stringify({ level: "fatal", msg: `Configuration error: ${e instanceof Error ? e.message : String(e)}` }));
  process.exit(1);
}

const app = await buildApp({ cfg, engine: makeEngine(cfg.engineDriver), gateway: new SupabaseGateway(cfg.supabaseUrl, cfg.supabaseAnonKey) });
app.startBackground();
await app.fastify.listen({ port: cfg.port, host: cfg.host });

for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.on(sig, () => {
    app.fastify.log.info({ sig }, "shutting down");
    app.close().then(() => process.exit(0), () => process.exit(1));
  });
}
