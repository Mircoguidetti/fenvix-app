// Output of the deploy steps. Nothing secret is ever passed to these functions; mask() hides values derived from
// secrets (GitHub masks the secrets themselves, not what is computed from them) from every later log line.
import { appendFileSync } from "node:fs";

const inActions = () => process.env.GITHUB_ACTIONS === "true";

/** Tells GitHub Actions to replace this value with *** in every later log line. Prints nothing outside Actions. */
export function mask(value) {
  if (!value || !inActions()) return;
  // A multi-line value is masked line by line (GitHub's rule).
  for (const line of String(value).split(/\r?\n/)) if (line.trim()) process.stdout.write(`::add-mask::${line}\n`);
}

export const info = (msg) => process.stdout.write(`${msg}\n`);
export const notice = (msg) => process.stdout.write(inActions() ? `::notice::${msg.replace(/\n/g, "%0A")}\n` : `NOTICE: ${msg}\n`);
export const warning = (msg) => process.stdout.write(inActions() ? `::warning::${msg.replace(/\n/g, "%0A")}\n` : `WARNING: ${msg}\n`);

/** A line of the run's summary page (GitHub: the workflow run's Summary). Never a secret. */
export function summary(markdown) {
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${markdown}\n`);
  else process.stdout.write(`${markdown}\n`);
}

/** A non-secret value for the later steps of the job ($GITHUB_ENV). */
export function exportEnv(name, value) {
  if (!/^[A-Z][A-Z0-9_]*$/.test(name)) throw new Error(`bad variable name ${name}`);
  if (/[\r\n]/.test(String(value))) throw new Error(`${name}: one line only`);
  if (process.env.GITHUB_ENV) appendFileSync(process.env.GITHUB_ENV, `${name}=${value}\n`);
  process.env[name] = String(value);
}

/** A failure the founder can act on: one sentence, what to do. Never a secret. */
export class Stop extends Error {}
