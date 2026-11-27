// Writes board/index.html from ../contrast.json. Usage: node second-colour/2026-11-27-r2/board/build.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const HERE = dirname(fileURLToPath(import.meta.url));
const data = JSON.parse(readFileSync(join(HERE, "..", "contrast.json"), "utf8"));
const lean = {
  reference: { tokens: data.reference.tokens, dist: data.reference.dist, checks: data.reference.checks.map((c) => [c.ratio, c.pass]) },
  labels: data.reference.checks.map((c) => [c.label, c.kind]),
  directions: data.directions.map((d) => ({ letter: d.letter, title: d.title, intent: d.intent, tokens: d.tokens, checks: d.checks.map((c) => [c.ratio, c.pass]) })),
};
const tpl = readFileSync(join(HERE, "template.html"), "utf8");
writeFileSync(join(HERE, "index.html"), tpl.replace("/*DATA*/null", JSON.stringify(lean)));
console.log("board/index.html written");
