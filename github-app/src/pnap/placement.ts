import type { Db } from "../db.ts";
import type { JobPlacer, Logger } from "../service.ts";
import type { Region } from "./api.ts";
import type { PnapSettings } from "./settings.ts";

/**
 * Placement: a queued fenvix job joins the queue of ITS customer's region (gh_installations.pnap_region, or the
 * default region if one is configured). It is never placed in another region: a region without capacity makes its
 * jobs wait, and the scaler orders hosts there. Nothing secret is stored: the job's just-in-time runner and
 * credentials are made only when a host of that region leases it.
 */
export class PnapPlacement implements JobPlacer {
  private readonly db: Db;
  private readonly s: Pick<PnapSettings, "regions" | "defaultRegion">;
  private readonly log: Logger;

  constructor(db: Db, s: Pick<PnapSettings, "regions" | "defaultRegion">, log: Logger) { this.db = db; this.s = s; this.log = log; }

  async regionOf(installationId: number): Promise<Region | null> {
    const [r] = await this.db.q<{ pnap_region: Region | null }>("select pnap_region from gh_installations where installation_id = $1", [installationId]);
    const region = r?.pnap_region ?? this.s.defaultRegion;
    return region && this.s.regions[region] && this.s.regions[region]!.max > 0 ? region : null;
  }

  async place(j: { jobId: number; installationId: number; repositoryId: number }): Promise<void> {
    const region = await this.regionOf(j.installationId);
    if (!region) {
      this.log.warn({ job: j.jobId, installation: j.installationId }, "not placed: the installation has no region with hosts (set gh_installations.pnap_region)");
      return;
    }
    // A redelivered webhook places the job once.
    await this.db.q(`insert into pnap_jobs (job_id, region, installation_id, repository_id, state) values ($1, $2, $3, $4, 'queued')
                     on conflict (job_id) do nothing`, [j.jobId, region, j.installationId, j.repositoryId]);
    this.log.info({ job: j.jobId, region }, "job placed in its region's queue");
  }

  async finished(jobId: number): Promise<void> {
    // Cancelled before a host took it: off the queue. A leased job is closed by its host's report.
    await this.db.q(`update pnap_jobs set state = 'cancelled', finished_at = now(), detail = 'completed on GitHub before a host took it'
                     where job_id = $1 and state = 'queued'`, [jobId]);
  }
}
