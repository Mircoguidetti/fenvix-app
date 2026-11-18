import { buildApp } from "./app.ts";
import { type Config, loadConfig } from "./config.ts";

let cfg: Config;
try {
  cfg = loadConfig();
} catch (e) {
  console.error(JSON.stringify({ level: "fatal", msg: `Configuration error: ${e instanceof Error ? e.message : String(e)}` }));
  process.exit(1);
}

const app = await buildApp({ cfg });
app.startBackground();
await app.fastify.listen({ port: cfg.port, host: cfg.host });

for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.on(sig, () => {
    app.fastify.log.info({ sig }, "shutting down");
    app.close().then(() => process.exit(0), () => process.exit(1));
  });
}
