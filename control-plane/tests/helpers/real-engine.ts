import { randomBytes } from "node:crypto";
import { loadConfig, type Config } from "../../src/config.ts";
import { RealEngine } from "../../src/engine/real.ts";
import type { SimEngine } from "./sim-engine.ts";

export const API = "https://api.fenvix.test/v1";

/** The environment a deployment on the real driver sets. Addresses and tokens are the simulator's: nothing here is a production value. */
export function realEnv(sims: Record<string, SimEngine>, over: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  const regions = Object.keys(sims);
  const single = regions.length === 1;
  return {
    CONTROL_PLANE_DATABASE_URL: "postgresql://unused.invalid/none",
    SUPABASE_URL: "https://project.supabase.invalid",
    SUPABASE_ANON_KEY: "anon",
    DOWNLOAD_SIGNING_KEY: randomBytes(32).toString("hex"),
    API_PUBLIC_URL: API,
    ENGINE_DRIVER: "real",
    REGIONS: regions.join(","),
    ENGINE_ADMIN_ENDPOINTS: regions.map((r) => (single ? sims[r]!.url : `${r}=${sims[r]!.url}`)).join(","),
    ENGINE_ADMIN_TOKEN: Object.values(sims)[0]!.token,
    CONNECTION_PORT: "27018",
    BASE_DOMAIN: "db.example.test",
    HOST_TEMPLATE: "<name>-<workspace>.<region>.<BASE_DOMAIN>",
    CONNECTION_DB_NAME: "engine",
    ...over,
  };
}

export function makeReal(sims: Record<string, SimEngine>, over: Record<string, string | undefined> = {}, now?: () => Date): { engine: RealEngine; cfg: Config } {
  const cfg = loadConfig(realEnv(sims, over));
  return { engine: new RealEngine({ settings: cfg.engine!, downloadSigningKey: cfg.downloadSigningKey, apiPublicUrl: cfg.apiPublicUrl, now }), cfg };
}
