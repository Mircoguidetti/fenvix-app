import { generateKeyPairSync } from "node:crypto";
import { App, Aspects } from "aws-cdk-lib";
import { Annotations, Match, Template } from "aws-cdk-lib/assertions";
import { AwsSolutionsChecks } from "cdk-nag";
import { applySuppressions } from "../lib/nag.ts";
import { readSettings, type Settings } from "../lib/settings.ts";
import { FenvixGitHubAppStack } from "../lib/stack.ts";
import { synthesizer } from "../lib/synthesizer.ts";

/** A cache signing key pair for the tests (the deploy pipeline makes the real one, deploy/lib/secrets.mjs; its private half is in SSM). */
export const CACHE_KEY = generateKeyPairSync("rsa", { modulusLength: 2048 });

/** cdk.json's context plus the settings the founder fills in (sample values, no secret). */
export const SAMPLE: Record<string, string> = {
  githubAppId: "123456", githubAppSlug: "fenvix", githubClientId: "Iv1.example", dashboardUrl: "https://console.fenvix.dev",
  supabaseUrl: "https://example.supabase.co", demoRepository: "Mircoguidetti/fenvix-demo",
  cacheSigningPublicKey: CACHE_KEY.publicKey.export({ type: "spki", format: "der" }).toString("base64"),
};

export async function cdkContext(): Promise<Record<string, unknown>> {
  const { readFileSync } = await import("node:fs");
  return (JSON.parse(readFileSync(new URL("../cdk.json", import.meta.url), "utf8")) as { context: Record<string, unknown> }).context;
}

export async function settings(over: Record<string, string> = {}): Promise<Settings> {
  const ctx = { ...(await cdkContext()), ...SAMPLE, ...over };
  return readSettings((k) => ctx[k], {});
}

const cached = new Map<string, { template: Template; stack: FenvixGitHubAppStack; s: Settings }>();

/** Synthesizes the stack once per setting set (bundles the functions with esbuild), with cdk-nag as in bin/app.ts. */
export async function synth(over: Record<string, string> = {}): Promise<{ template: Template; stack: FenvixGitHubAppStack; s: Settings; nagErrors: string[] }> {
  const key = JSON.stringify(over);
  if (!cached.has(key)) {
    const s = await settings(over);
    const app = new App({ outdir: (await import("node:fs")).mkdtempSync(`${(await import("node:os")).tmpdir()}/fenvix-cdk-`) });
    const stack = new FenvixGitHubAppStack(app, "test-stack", { env: { account: s.account, region: s.region }, settings: s, synthesizer: synthesizer() });
    applySuppressions(stack);
    Aspects.of(app).add(new AwsSolutionsChecks());
    app.synth();
    cached.set(key, { template: Template.fromStack(stack), stack, s });
  }
  const c = cached.get(key)!;
  const nagErrors = Annotations.fromStack(c.stack).findError("*", Match.stringLikeRegexp("AwsSolutions-.*")).map((m) => String(m.entry.data));
  return { ...c, nagErrors };
}

/** Per-job mode (the default). */
export const PER_JOB = { runnerMode: "per-job" };
/** Demo mode (an option; needs the GitHub App). */
export const DEMO = { runnerMode: "demo" };
/** The GitHub App not configured yet: the stack's first deploys (docs/DEPLOY-AWS.md). */
export const NO_APP = { githubAppId: "", githubAppSlug: "", githubClientId: "" };

export type Res = { Type: string; Properties: Record<string, unknown> };
export const resources = (t: Template, type: string): [string, Res][] => Object.entries(t.findResources(type)) as [string, Res][];
