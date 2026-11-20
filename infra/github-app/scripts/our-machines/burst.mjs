#!/usr/bin/env node
// A burst of jobs from two customers (docs/REPORT-our-machines.md, "Founder steps", step 7): starts N runs of the
// fenvix-e2e workflow in each of two scratch repositories, installed by two DIFFERENT GitHub accounts or organizations
// (two customers), at the same moment. Then run measure.mjs for the window.
//   GITHUB_TOKEN=<a token with actions:write on both> node burst.mjs owner-a/repo-a owner-b/repo-b [N=6]
const [a, b, n = "6"] = process.argv.slice(2);
if (!a || !b || !process.env.GITHUB_TOKEN) { console.error("usage: GITHUB_TOKEN=... node burst.mjs owner-a/repo-a owner-b/repo-b [N]"); process.exit(2); }
const started = new Date().toISOString();
const dispatch = (repo, i) => fetch(`https://api.github.com/repos/${repo}/actions/workflows/fenvix-e2e.yml/dispatches`, {
  method: "POST", headers: { authorization: `Bearer ${process.env.GITHUB_TOKEN}`, accept: "application/vnd.github+json", "content-type": "application/json" },
  body: JSON.stringify({ ref: "main", inputs: { tag: `burst-${i}` } }),
}).then((r) => `${repo} #${i}: ${r.status}`);
const res = await Promise.all(Array.from({ length: Number(n) }, (_, i) => [dispatch(a, i), dispatch(b, i)]).flat());
console.log(res.join("\n"));
console.log(`burst started ${started}: node measure.mjs --since ${started}`);
