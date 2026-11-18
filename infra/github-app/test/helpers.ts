import { App, Aspects } from "aws-cdk-lib";
import { Annotations, Match, Template } from "aws-cdk-lib/assertions";
import { AwsSolutionsChecks } from "cdk-nag";
import { applySuppressions } from "../lib/nag.ts";
import { readSettings, type Settings } from "../lib/settings.ts";
import { FenvixGitHubAppStack } from "../lib/stack.ts";

/** cdk.json's context plus the settings the founder fills in (sample values, no secret). */
export const SAMPLE: Record<string, string> = {
  githubAppId: "123456", githubAppSlug: "fenvix", githubClientId: "Iv1.example", dashboardUrl: "https://app.fenvix.dev",
  supabaseUrl: "https://example.supabase.co", runnerScopeUrl: "https://github.com/Mircoguidetti/fenvix-demo",
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
    const stack = new FenvixGitHubAppStack(app, "test-stack", { env: { account: s.account, region: s.region }, settings: s });
    applySuppressions(stack);
    Aspects.of(app).add(new AwsSolutionsChecks());
    app.synth();
    cached.set(key, { template: Template.fromStack(stack), stack, s });
  }
  const c = cached.get(key)!;
  const nagErrors = Annotations.fromStack(c.stack).findError("*", Match.stringLikeRegexp("AwsSolutions-.*")).map((m) => String(m.entry.data));
  return { ...c, nagErrors };
}

/** The always-on mode's settings (one machine registered on one repository). */
export const ALWAYS_ON = { runnerMode: "always-on" };

export type Res = { Type: string; Properties: Record<string, unknown> };
export const resources = (t: Template, type: string): [string, Res][] => Object.entries(t.findResources(type)) as [string, Res][];
