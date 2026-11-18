import { contentPath, GitHubError, type GitHubHttp, repoPath } from "../github/client.ts";
import { analyzeWorkflow, chooseTestJob, type FileAnalysis, type JobAnalysis, type Language, setRunsOn, type TestRunner, unifiedDiff } from "./workflow.ts";

export type OnboardingState = "pr_open" | "no_workflow" | "no_test_job" | "already_fenvix" | "unsupported" | "failed";

export interface OnboardingResult {
  state: OnboardingState;
  detail: string;
  defaultBranch: string | null;
  workflowPath?: string;
  job?: string;
  pr?: { number: number; url: string; created: boolean };
  language: Language | null;
  testRunner: TestRunner | null;
}

export interface OnboardingOptions {
  label: string;
  branch: string;
  dashboardUrl: string;
  /** At most this many workflow files are read. */
  maxFiles?: number;
}

interface ContentFile { type: string; name: string; path: string; sha: string; content?: string; encoding?: string; size?: number }

const MAX_WORKFLOW_BYTES = 512 * 1024;

/** The pull request body: what changes, the diff, what happens next, how to undo it. */
export function pullRequestBody(o: { job: JobAnalysis; diff: string; others: JobAnalysis[]; label: string; dashboardUrl: string; note?: string }): string {
  const L = [
    `This pull request moves the test job \`${o.job.jobId}\` in \`${o.job.file}\` to fenvix machines: one line, \`runs-on: ${o.label}\`.`,
    "",
    "Nothing else in the workflow changes: same steps, same triggers, same secrets. The tests run on a fenvix machine, inside the fenvix engine:",
    "",
    "- a test whose inputs did not change since a passing run is **skipped with proof**, and its receipt says what was checked;",
    "- a flaky test becomes a **reproducible defect** with its replay command;",
    "- every run reports on the commit as a check run (and on the pull request as one comment, updated in place).",
    "",
    "### The change",
    "",
    "```diff",
    o.diff,
    "```",
    "",
    `Why this job: ${o.job.reasons.join(", ") || "it is the job that runs the tests"} (was \`runs-on: ${o.job.runsOn.ok ? o.job.runsOn.current : ""}\`).`,
  ];
  if (o.note) L.push("", o.note);
  if (o.others.length) {
    L.push("", "Other jobs that also look like tests were left as they are (change them the same way when you want):",
      ...o.others.map((j) => `- \`${j.jobId}\` in \`${j.file}\``));
  }
  L.push(
    "",
    "### Next",
    "",
    "Merge it when you are ready. The first run on fenvix starts cold; from the second run on, unchanged tests are skipped with proof.",
    `Runs, receipts and defects: ${o.dashboardUrl}/projects`,
    "",
    `To go back, change \`runs-on: ${o.label}\` back to the previous value.`,
    "",
    "<!-- fenvix:onboarding -->",
  );
  return L.join("\n");
}

async function readWorkflows(gh: GitHubHttp, repo: string, ref: string, maxFiles: number): Promise<{ files: { path: string; text: string; sha: string }[]; skipped: string[] } | null> {
  const list = await gh.request<ContentFile[] | ContentFile>("GET", `${repoPath(repo)}/contents/.github/workflows`, { query: { ref }, allow: [404] });
  if (list.status === 404 || !Array.isArray(list.data)) return null;
  const entries = list.data.filter((e) => e.type === "file" && /\.ya?ml$/i.test(e.name)).sort((a, b) => a.path.localeCompare(b.path));
  const files: { path: string; text: string; sha: string }[] = [];
  const skipped: string[] = [];
  for (const e of entries.slice(0, maxFiles)) {
    if ((e.size ?? 0) > MAX_WORKFLOW_BYTES) { skipped.push(`${e.path} (too large)`); continue; }
    const f = await gh.request<ContentFile>("GET", `${repoPath(repo)}/contents/${contentPath(e.path)}`, { query: { ref } });
    if (f.data.encoding !== "base64" || typeof f.data.content !== "string") { skipped.push(`${e.path} (not readable)`); continue; }
    files.push({ path: e.path, text: Buffer.from(f.data.content, "base64").toString("utf8"), sha: f.data.sha });
  }
  for (const e of entries.slice(maxFiles)) skipped.push(`${e.path} (more than ${maxFiles} workflows)`);
  return { files, skipped };
}

/**
 * Opens (or finds) the onboarding pull request of one repository. Idempotent: an open pull request from the onboarding
 * branch is returned as it is; a stale onboarding branch with no open pull request is reset to the default branch.
 */
export async function onboardRepository(gh: GitHubHttp, fullName: string, o: OnboardingOptions): Promise<OnboardingResult> {
  const base = repoPath(fullName);
  let defaultBranch: string | null = null;
  try {
    const repo = await gh.request<{ default_branch: string; archived?: boolean; owner: { login: string } }>("GET", base);
    defaultBranch = repo.data.default_branch;
    const none = { language: null, testRunner: null, defaultBranch };
    if (repo.data.archived) return { state: "unsupported", detail: "the repository is archived", ...none };

    const wf = await readWorkflows(gh, fullName, defaultBranch, o.maxFiles ?? 30);
    if (!wf || wf.files.length === 0) return { state: "no_workflow", detail: "no workflow files in .github/workflows on the default branch", ...none };
    const analyses: FileAnalysis[] = wf.files.map((f) => analyzeWorkflow(f, o.label));
    const choice = chooseTestJob(analyses);
    if (choice.kind === "no_test_job") {
      const seen = choice.seen.map((j) => `${j.file}:${j.jobId}`).join(", ") || "none";
      const broken = analyses.filter((a) => a.error).map((a) => `${a.path} (${a.error})`).join(", ");
      return { state: "no_test_job", detail: `no job runs tests (jobs seen: ${seen}${broken ? `; not read: ${broken}` : ""})`, ...none };
    }
    if (choice.kind === "already_fenvix") {
      return { state: "already_fenvix", detail: `${choice.job.file}:${choice.job.jobId} already runs on ${o.label}`, workflowPath: choice.job.file, job: choice.job.jobId,
        language: choice.job.language, testRunner: choice.job.testRunner, defaultBranch };
    }
    if (choice.kind === "unsupported") {
      const why = choice.job.runsOn.ok ? "" : choice.job.runsOn.reason;
      return { state: "unsupported", detail: `${choice.job.file}:${choice.job.jobId} ${why}`, workflowPath: choice.job.file, job: choice.job.jobId,
        language: choice.job.language, testRunner: choice.job.testRunner, defaultBranch };
    }
    const job = choice.job;
    const found = { workflowPath: job.file, job: job.jobId, language: job.language, testRunner: job.testRunner, defaultBranch };

    const owner = repo.data.owner.login;
    const open = await gh.request<{ number: number; html_url: string }[]>("GET", `${base}/pulls`, { query: { head: `${owner}:${o.branch}`, state: "open", per_page: 10 } });
    if (open.data.length) {
      const pr = open.data[0]!;
      return { state: "pr_open", detail: "the onboarding pull request is already open", pr: { number: pr.number, url: pr.html_url, created: false }, ...found };
    }

    const file = wf.files.find((f) => f.path === job.file)!;
    const changed = setRunsOn(file.text, job.jobId, o.label);
    const diff = unifiedDiff(file.path, file.text, changed);

    const head = await gh.request<{ object: { sha: string } }>("GET", `${base}/git/ref/heads/${contentPath(defaultBranch)}`);
    const sha = head.data.object.sha;
    const created = await gh.request("POST", `${base}/git/refs`, { body: { ref: `refs/heads/${o.branch}`, sha }, allow: [422] });
    if (created.status === 422) {
      // Our branch from an earlier, closed attempt: start it again from the default branch.
      await gh.request("PATCH", `${base}/git/refs/heads/${contentPath(o.branch)}`, { body: { sha, force: true } });
    }
    await gh.request("PUT", `${base}/contents/${contentPath(file.path)}`, {
      body: {
        message: `ci: run the test job on fenvix (runs-on: ${o.label})`,
        content: Buffer.from(changed, "utf8").toString("base64"),
        sha: file.sha,
        branch: o.branch,
      },
    });
    const body = pullRequestBody({ job, diff, others: choice.others, label: o.label, dashboardUrl: o.dashboardUrl, note: job.runsOn.ok ? job.runsOn.note : undefined });
    const pr = await gh.request<{ number: number; html_url: string }>("POST", `${base}/pulls`, {
      body: { title: `Run the tests on fenvix (runs-on: ${o.label})`, head: o.branch, base: defaultBranch, body },
    });
    return { state: "pr_open", detail: `changed ${job.file}:${job.jobId}`, pr: { number: pr.data.number, url: pr.data.html_url, created: true }, ...found };
  } catch (e) {
    const detail = e instanceof GitHubError ? e.message : `unexpected error: ${e instanceof Error ? e.message : String(e)}`;
    return { state: "failed", detail: detail.slice(0, 900), language: null, testRunner: null, defaultBranch };
  }
}
