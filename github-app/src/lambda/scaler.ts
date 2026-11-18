// AWS Lambda entry: the phoenixNAP scaler (src/pnap/scaler.ts). An EventBridge schedule invokes it every minute with
// no action; reserved concurrency 1, so two runs never overlap. By hand (aws lambda invoke, docs/CUSTOMER-MODE-PNAP.md):
//   {"action": "hold", "region": "ASH", "hosts": 1, "minutes": 60}   a floor of hosts for a while (the first test)
//   {"action": "release", "region": "ASH"}                            drain and release every host of a region
//   {"action": "set-region", "installationId": 123, "region": "ASH"}  where an installation's jobs run
//   {"action": "status"}                                              hosts and jobs of the last day
import { isRegion } from "../pnap/api.ts";
import { hold, releaseRegion, runScaler, status } from "../pnap/scaler.ts";
import { refreshing, scalerDeps } from "./runtime.ts";

const deps = refreshing(() => scalerDeps(process.env));

type Event = { action?: string; region?: string; hosts?: number; minutes?: number; installationId?: number };

export const handler = async (event: Event = {}) => {
  const d = await deps();
  const region = event.region;
  switch (event.action ?? "scale") {
    case "scale":
      return runScaler(d);
    case "hold":
      if (!isRegion(region) || !d.s.regions[region]) throw new Error("region must be one of PNAP_REGIONS");
      if (!Number.isInteger(event.hosts) || event.hosts! < 0 || event.hosts! > d.s.regions[region]!.max) throw new Error("hosts: 0 to the region's max");
      if (!Number.isInteger(event.minutes) || event.minutes! < 1 || event.minutes! > 24 * 60) throw new Error("minutes: 1 to 1440");
      await hold(d.db, region, event.hosts!, event.minutes!, "by hand");
      return runScaler(d);
    case "release":
      if (!isRegion(region)) throw new Error("region must be one of ASH, PHX, CHI, SEA, NLD");
      return { draining: await releaseRegion(d.db, region), run: await runScaler(d) };
    case "set-region":
      if (!isRegion(region) || !Number.isInteger(event.installationId)) throw new Error("installationId and region are required");
      await d.db.q("update gh_installations set pnap_region = $2 where installation_id = $1", [event.installationId, region]);
      return { installationId: event.installationId, region };
    case "status":
      return status(d.db);
    default:
      throw new Error('action must be "scale", "hold", "release", "set-region" or "status"');
  }
};
