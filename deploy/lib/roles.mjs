// The passwords of the two restricted database roles (fenvix_github_app, fenvix_api). Each role's whole connection
// string lives in SSM (SecureString). On every deploy the pipeline logs in with the stored string; only when there is
// none, or the database refuses its password, it makes a new password, gives the role its SCRAM verifier (the password
// itself never reaches the database, its logs or a statement), and stores the new connection string. A network
// failure never changes a password.
import { randomBytes } from "node:crypto";
import { GetParameterCommand, PutParameterCommand } from "@aws-sdk/client-ssm";
import pg from "pg";
import { scramVerifier } from "../../infra/github-app/scripts/scram-verifier.mjs";
import { info, mask, Stop } from "./log.mjs";
import { roleUrl, ROLES } from "./supabase.mjs";
import { appPrefix } from "./secrets.mjs";

/** 32 random bytes, base64url: 43 URL-safe ASCII characters (no escaping in a connection string; SASLprep-neutral). */
export const newPassword = () => randomBytes(32).toString("base64url");

const AUTH_FAILED = new Set(["28P01", "28000"]);

/** Logs in with a connection string: "ok", "refused" (wrong password or no such login) or throws (anything else). */
export async function tryLogin(url, { attempts = 1, delayMs = 5000 } = {}) {
  for (let i = 1; ; i++) {
    const c = new pg.Client({ connectionString: url, connectionTimeoutMillis: 15_000 });
    try {
      await c.connect();
      await c.query("select 1");
      return "ok";
    } catch (e) {
      const code = /** @type {{ code?: string, message?: string }} */ (e).code;
      // Supavisor answers a wrong password with its own message and no SQLSTATE in some versions.
      const refused = (code && AUTH_FAILED.has(code)) || /password authentication failed|authentication failed|tenant or user not found/i.test(String(/** @type {Error} */ (e).message));
      if (i >= attempts) {
        if (refused) return "refused";
        throw new Error(`could not reach the database (${code ?? /** @type {Error} */ (e).name}): ${/** @type {Error} */ (e).message}`);
      }
    } finally {
      await c.end().catch(() => undefined);
    }
    await new Promise((r) => setTimeout(r, delayMs));
  }
}

/**
 * Makes sure each role's stored connection string logs in. `admin` is a connected pg client as the admin; `a` the
 * parsed admin URL (supabase.mjs). Returns per role "kept" or "set".
 */
export async function ensureRoles(admin, a, ssm, { env = "prod", login = tryLogin, verifyAttempts = 12, verifyDelayMs = 10_000, roles = ROLES } = {}) {
  const out = {};
  for (const r of roles) {
    if (!/^[a-z_][a-z0-9_]*$/.test(r.role)) throw new Error(`bad role name ${r.role}`);
    const name = `${appPrefix(env)}/${r.parameter}`;
    const role = await admin.query("select rolcanlogin from pg_roles where rolname = $1", [r.role]);
    if (!role.rows.length) throw new Stop(`The role ${r.role} does not exist: the migrations create it (supabase/migrations). Nothing was changed.`);
    if (!role.rows[0].rolcanlogin) throw new Stop(`The role ${r.role} cannot log in (NOLOGIN). Nothing was changed.`);

    let stored = null;
    try {
      stored = (await ssm.send(new GetParameterCommand({ Name: name, WithDecryption: true }))).Parameter?.Value ?? null;
    } catch (e) {
      if (/** @type {{ name?: string }} */ (e).name !== "ParameterNotFound") throw new Error(`${name}: could not be read (${/** @type {{ name?: string }} */ (e).name})`);
    }
    if (stored) {
      mask(stored);
      const result = await login(stored);
      if (result === "ok") { info(`${r.role}: the stored connection string logs in (kept)`); out[r.role] = "kept"; continue; }
      info(`${r.role}: the database refuses the stored password: setting a new one`);
    } else {
      info(`${r.role}: no connection string in ${name} yet: setting a password`);
    }

    const password = newPassword();
    mask(password);
    const url = roleUrl(a, r, password);
    mask(url);
    // The verifier, not the password: the statement (and any log of it) holds nothing that logs in.
    const verifier = scramVerifier(password);
    await admin.query(`alter role ${r.role} with login password '${verifier}'`);
    await ssm.send(new PutParameterCommand({ Name: name, Type: "SecureString", Value: url, Overwrite: true, Description: `fenvix: connection string of the role ${r.role} (Supabase pooler, ${r.mode} mode). Set by the deploy pipeline.` }));
    // The pooler may take a moment to see the new password.
    const check = await login(url, { attempts: verifyAttempts, delayMs: verifyDelayMs });
    if (check !== "ok") throw new Stop(`${r.role}: the new password was set but logging in through the pooler still fails. The next deploy tries again.`);
    info(`${r.role}: new password set (SCRAM verifier), connection string stored in ${name}, login checked (${r.mode} mode)`);
    out[r.role] = "set";
  }
  return out;
}
