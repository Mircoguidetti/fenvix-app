import type { OperationKind, OperationProgress } from "../data";

const WORKING: Record<OperationKind, string> = {
  create: "Creating the database",
  fork: "Making the copy",
  restore: "Restoring the data",
  export: "Preparing the export",
  erase: "Erasing",
};

/** The text for a status, or null when there is nothing to say (failures are shown as the error, with their reason). */
export function operationText(p: OperationProgress | null): string | null {
  if (!p) return null;
  if (p.status === "submitting") return `${WORKING[p.kind]}…`;
  if (p.status === "queued") return `${WORKING[p.kind]}: queued, it starts in a moment.`;
  if (p.status === "running") return `${WORKING[p.kind]}: in progress. This can take a minute; keep this page open.`;
  if (p.status === "succeeded") return "Done.";
  return null;
}

/** Says, while it lasts, where a long operation (create, fork, restore, export, erase) has got to. */
export function OperationNote({ progress }: { progress: OperationProgress | null }) {
  const text = operationText(progress);
  if (!text) return null;
  return (
    <p className="muted small op-note" role="status" aria-live="polite" data-status={progress?.status}>
      {text}
    </p>
  );
}
