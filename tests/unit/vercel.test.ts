// The dashboard on Vercel (docs/DEPLOY-VERCEL.md): vercel.json builds it from this repository with no manual edit, the
// SPA rewrite answers every client route with index.html (the same rule as the CloudFront function,
// infra/github-app/lib/dashboard.ts), and every VITE_ variable the app reads is named in the founder's guide.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const vercel = JSON.parse(readFileSync("vercel.json", "utf8")) as {
  framework: string; installCommand: string; buildCommand: string; outputDirectory: string;
  rewrites: { source: string; destination: string }[]; headers: { source: string; headers: { key: string; value: string }[] }[];
};
const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { scripts: Record<string, string>; engines?: { node?: string } };
const guide = readFileSync("docs/DEPLOY-VERCEL.md", "utf8");

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => { const p = join(dir, f); return statSync(p).isDirectory() ? files(p) : [p]; });
}

test("vercel.json: Vite, npm ci, the repository's own build, dist; Node 22 as in CI", () => {
  assert.equal(vercel.framework, "vite");
  assert.equal(vercel.installCommand, "npm ci --no-audit --no-fund");
  assert.equal(vercel.buildCommand, "npm run build");
  assert.match(pkg.scripts.build, /vite build/);
  assert.equal(vercel.outputDirectory, "dist");
  assert.doesNotMatch(readFileSync("vite.config.ts", "utf8"), /outDir/);
  assert.equal(pkg.engines?.node, "22.x");
  assert.match(readFileSync(".github/workflows/test.yml", "utf8"), /NODE_VERSION: "22"/);
});

test("vercel.json: client routes get index.html; /assets/* and the icon are served as they are", () => {
  assert.equal(vercel.rewrites.length, 1);
  const [r] = vercel.rewrites;
  assert.equal(r.destination, "/index.html");
  // Vercel reads a source with a group as a regular expression on the whole path.
  const re = new RegExp(`^${r.source}$`);
  for (const p of ["/", "/overview", "/projects/abc/runs/1", "/projects/connect", "/invite", "/settings/billing"]) assert.ok(re.test(p), p);
  for (const p of ["/assets/index-abc123.js", "/assets/font.woff2", "/favicon.svg"]) assert.ok(!re.test(p), p);
  // The CloudFront function (dashboard on AWS, off for now) keeps the same rule.
  assert.match(readFileSync("infra/github-app/lib/dashboard.ts", "utf8"), /indexOf\("\/assets\/"\) !== 0 && r\.uri !== "\/favicon\.svg"/);
});

test("vercel.json: the security headers CloudFront's managed policy sent; hashed assets cached for a year", () => {
  const all = Object.fromEntries(vercel.headers.find((h) => h.source === "/(.*)")!.headers.map((h) => [h.key, h.value]));
  assert.deepEqual(Object.keys(all).sort(), ["Referrer-Policy", "Strict-Transport-Security", "X-Content-Type-Options", "X-Frame-Options", "X-XSS-Protection"]);
  assert.equal(all["X-Content-Type-Options"], "nosniff");
  const assets = vercel.headers.find((h) => h.source === "/assets/(.*)")!.headers;
  assert.deepEqual(assets, [{ key: "Cache-Control", value: "public, max-age=31536000, immutable" }]);
});

test("docs/DEPLOY-VERCEL.md names every VITE_ variable the app reads, and the production API base", () => {
  const read = new Set(files("src").filter((f) => /\.(ts|tsx)$/.test(f) && !f.endsWith(".d.ts")).flatMap((f) => readFileSync(f, "utf8").match(/VITE_[A-Z_]+/g) ?? []));
  assert.deepEqual([...read].sort(), ["VITE_API_URL", "VITE_DATA_BACKEND", "VITE_STYLEGUIDE", "VITE_SUPABASE_ANON_KEY", "VITE_SUPABASE_URL"]);
  for (const v of read) assert.ok(guide.includes(`\`${v}\``), v);
  assert.ok(guide.includes("`https://github.fenvix.dev/v1`"));
  assert.ok(guide.includes("console.fenvix.dev"));
});
