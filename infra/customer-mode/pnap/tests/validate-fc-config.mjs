// Checks a job's Firecracker configuration file against Firecracker's own API description (swagger) of a release:
//   node validate-fc-config.mjs <firecracker.yaml of that release> <config.json>
// Each section of the configuration file is the body of one API call. Uses yaml and ajv from github-app's
// dependencies. (The spike's validate-config.mjs, plus the entropy device; no Nitro "enclave" section on KVM.)
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(new URL("../../../../github-app/package.json", import.meta.url));
const { parse } = require("yaml");
const Ajv = require("ajv");
const [swaggerPath, configPath] = process.argv.slice(2);
const swagger = parse(readFileSync(swaggerPath, "utf8"));
const config = JSON.parse(readFileSync(configPath, "utf8"));
const ajv = new Ajv({ strict: false, allErrors: true, logger: false });
const known = { "boot-source": "BootSource", "machine-config": "MachineConfiguration", drives: "Drive", "network-interfaces": "NetworkInterface", entropy: "EntropyDevice" };
let ok = true;
for (const [key, value] of Object.entries(config)) {
  const def = known[key];
  if (!def || !swagger.definitions[def]) { console.log(`INVALID ${key}: not a section this check knows in this release`); ok = false; continue; }
  for (const [i, v] of (Array.isArray(value) ? value.map((v, i) => [i, v]) : [[null, value]])) {
    const valid = ajv.validate({ definitions: swagger.definitions, $ref: `#/definitions/${def}`, }, v);
    // additionalProperties is not set in the swagger: refuse unknown keys ourselves (a typo would be ignored by ajv).
    const extra = Object.keys(v).filter((k) => !(k in (swagger.definitions[def].properties ?? {})));
    console.log(`${valid && !extra.length ? "ok     " : "INVALID"} ${i === null ? key : `${key}[${i}]`} (${def})${valid ? "" : ": " + ajv.errorsText()}${extra.length ? ` unknown: ${extra}` : ""}`);
    ok = ok && valid && !extra.length;
  }
}
console.log(`API description: ${swagger.info?.title} ${swagger.info?.version}`);
process.exit(ok ? 0 : 1);
