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

/**
 * The live-list features not built yet, as project sections: path under /projects/:id, nav label, sentence.
 * Founder, 28 Nov: Detailed proof, Compatibility, Is this red real? and Database copies were removed (invented as
 * pages), and Python is a language the engine will support, not a page.
 */
export const PROJECT_SOON = {
  nightly: { path: "nightly", label: "Nightly exploration", sentence: "Your suite run at night in many orders and seeds on fenvix machines, and the hidden order and timing bugs it found." },
} as const;
export type ProjectSoonKey = keyof typeof PROJECT_SOON;
