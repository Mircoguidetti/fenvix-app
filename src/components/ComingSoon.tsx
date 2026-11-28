import type { ReactNode } from "react";
import { Hourglass } from "lucide-react";
import { PageHeader } from "./PageHeader";

/**
 * A feature on the live list that is not built yet (founder review, 27 Nov): its own page now, with one sentence on
 * what it will show, so the page is filled when the feature lands. `kicker` is what the page belongs to (a project's
 * name, or the area).
 */
export function ComingSoon({ title, sentence, kicker }: { title: string; sentence: string; kicker?: ReactNode }) {
  return (
    <>
      <PageHeader back={kicker} title={title} />
      <section className="empty coming-soon" aria-labelledby="coming-soon-label">
        <Hourglass size={28} strokeWidth={1.6} aria-hidden="true" />
        <h2 id="coming-soon-label">Coming soon</h2>
        <p className="muted">{sentence}</p>
      </section>
    </>
  );
}

/** The live-list features not built yet, as project sections: path under /projects/:id, nav label, sentence. */
export const PROJECT_SOON = {
  nightly: { path: "nightly", label: "Nightly exploration", sentence: "Your suite run at night in many orders and seeds on fenvix machines, and the hidden order and timing bugs it found." },
  red: { path: "is-this-red-real", label: "Is this red real?", sentence: "For each failed run, whether the same tests were already red on the base branch, so you know which reds are yours." },
  database: { path: "database", label: "Database copies", sentence: "Each parallel lane gets its own copy of your test database, with no change to your code; this page will show the copies each run used." },
  compatibility: { path: "compatibility", label: "Compatibility", sentence: "How much of your suite can run in parallel with proof, predicted at connect and then measured, with what blocks the rest, whose it is, and the change that frees it." },
  proof: { path: "proof", label: "Detailed proof", sentence: "For each run, test by test, the parallel result next to the serial one and the evidence that they are identical." },
} as const;
export type ProjectSoonKey = keyof typeof PROJECT_SOON;

/** The organization-level coming-soon page (no project needed to reach it). */
export const PYTHON_SOON = { to: "/python", label: "Python", sentence: "pytest suites in parallel with proof, like Vitest, Jest and node:test today." } as const;
