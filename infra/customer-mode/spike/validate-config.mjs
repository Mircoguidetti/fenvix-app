// Checks run-job.sh's Firecracker configuration against Firecracker's own API description (swagger) of a release:
//   node validate-config.mjs <firecracker.yaml of that release> <config.json>
// Each section of the configuration file is the body of one API call: boot-source → BootSource, machine-config →
// MachineConfiguration, drives[] → Drive, network-interfaces[] → NetworkInterface, enclave → EnclaveConfig.
// Uses yaml and ajv from ../../../github-app (its dependencies).
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(new URL("../../../github-app/package.json", import.meta.url));
const { parse } = require("yaml");
const Ajv = require("ajv");
const [swaggerPath, configPath] = process.argv.slice(2);
const swagger = parse(readFileSync(swaggerPath, "utf8"));
const config = JSON.parse(readFileSync(configPath, "utf8"));
const ajv = new Ajv({ strict: false, allErrors: true, logger: false });
const check = (def, value, where) => {
  const ok = ajv.validate({ definitions: swagger.definitions, $ref: `#/definitions/${def}` }, value);
  console.log(`${ok ? "ok     " : "INVALID"} ${where} (${def})${ok ? "" : ": " + ajv.errorsText()}`);
  return ok;
};
const known = { "boot-source": "BootSource", "machine-config": "MachineConfiguration", drives: "Drive", "network-interfaces": "NetworkInterface", enclave: "EnclaveConfig" };
let ok = true;
for (const [key, value] of Object.entries(config)) {
  const def = known[key];
  if (!def) { console.log(`INVALID ${key}: not a section this check knows`); ok = false; continue; }
  if (!swagger.definitions[def]) { console.log(`INVALID ${def}: not in this release's API description`); ok = false; continue; }
  for (const [i, v] of (Array.isArray(value) ? value.map((v, i) => [i, v]) : [[null, value]])) ok = check(def, v, i === null ? key : `${key}[${i}]`) && ok;
}
console.log(`API description: ${swagger.info?.title} ${swagger.info?.version}`);
process.exit(ok ? 0 : 1);
