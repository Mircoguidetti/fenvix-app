// Fails when src/api/schema.d.ts is not what openapi/fenvix-api.yaml generates today (someone changed the API
// description without running `npm run api:generate`). The build runs this first, so the dashboard is always compiled
// against the API as described.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "fenvix-api-check-"));
try {
  const out = join(dir, "schema.d.ts");
  execFileSync("npx", ["openapi-typescript", "openapi/fenvix-api.yaml", "-o", out], { stdio: ["ignore", "ignore", "inherit"] });
  if (readFileSync(out, "utf8") !== readFileSync("src/api/schema.d.ts", "utf8")) {
    console.error("src/api/schema.d.ts is out of date with openapi/fenvix-api.yaml. Run: npm run api:generate");
    process.exit(1);
  }
  console.log("api: src/api/schema.d.ts matches openapi/fenvix-api.yaml");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
