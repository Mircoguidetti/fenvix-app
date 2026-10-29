// Builds the app, serves it, runs the screenshots and the behaviour checks, then stops the server.
import { spawn, spawnSync } from "node:child_process";

const PORT = 4173;

// The checks run against the mock backend: no network, no Supabase project needed.
const buildEnv = { ...process.env, VITE_DATA_BACKEND: "mock" };
if (spawnSync("npx", ["vite", "build"], { stdio: "inherit", env: buildEnv }).status !== 0) process.exit(1);
const server = spawn("npx", ["vite", "preview", "--port", String(PORT), "--strictPort"], { stdio: "ignore" });
const stop = () => server.kill();
process.on("exit", stop);

for (let i = 0; i < 50; i++) {
  try {
    if ((await fetch(`http://localhost:${PORT}/`)).ok) break;
  } catch {
    /* not up yet */
  }
  await new Promise((r) => setTimeout(r, 200));
}

const env = { ...buildEnv, BASE_URL: `http://localhost:${PORT}/` };
const ok = [["node", ["scripts/checks.mjs"]], ["node", ["scripts/orgs-checks.mjs"]], ["node", ["scripts/network-checks.mjs"]], ["node", ["scripts/screenshots.mjs"]]].map(([c, a]) => spawnSync(c, a, { stdio: "inherit", env }).status === 0);
stop();
process.exit(ok.every(Boolean) ? 0 : 1);
