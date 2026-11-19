// The passwords of the two restricted database roles (fenvix_github_app, fenvix_api). Each role's whole connection
// string lives in SSM (SecureString). On every deploy the pipeline logs in with the stored string; only when there is
// none, or the database answers "wrong password" (28P01) to every retry, it makes a new password, gives the role its SCRAM verifier (the password
// itself never reaches the database, its logs or a statement), and stores the new connection string. A network
// failure never changes a password.
import { randomBytes } from "node:crypto";
import { DeleteParameterCommand, GetParameterCommand, PutParameterCommand } from "@aws-sdk/client-ssm";
import pg from "pg";
import { scramVerifier } from "../../infra/github-app/scripts/scram-verifier.mjs";
import { info, mask, Stop } from "./log.mjs";
import { roleUrl, ROLES } from "./supabase.mjs";
import { appPrefix } from "./secrets.mjs";

/** 32 random bytes, base64url: 43 URL-safe ASCII characters (no escaping in a connection string; SASLprep-neutral). */
export const newPassword = () => randomBytes(32).toString("base64url");

/** The one answer that means "this password is wrong": SQLSTATE 28P01 (invalid_password). */
const WRONG_PASSWORD = "28P01";

/**
 * Logs in with a connection string, up to `attempts` times, `delayMs` apart. Returns "ok" as soon as one attempt logs
 * in. Otherwise the LAST attempt decides: SQLSTATE 28P01 (wrong password) → "refused"; anything else throws. Supavisor's
 * "Tenant or user not found" (XX000, reported intermittently), 28000, timeouts and network errors are never "refused":
 * a password is changed only when the database itself says it is wrong, every time it is asked.
 */
export async function tryLogin(url, { attempts = 1, delayMs = 5000 } = {}) {
  for (let i = 1; ; i++) {
    const c = new pg.Client({ connectionString: url, connectionTimeoutMillis: 15_000 });
    try {
      await c.connect();
      await c.query("select 1");
      return "ok";
    } catch (e) {
      const code = /** @type {{ code?: string, message?: string }} */ (e).code;
      if (i >= attempts) {
        if (code === WRONG_PASSWORD) return "refused";
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
export async function ensureRoles(admin, a, ssm, { env = "prod", login = tryLogin, checkAttempts = 4, checkDelayMs = 10_000, verifyAttempts = 12, verifyDelayMs = 10_000, roles = ROLES } = {}) {
  const out = {};
  for (const r of roles) {
    if (!/^[a-z_][a-z0-9_]*$/.test(r.role)) throw new Error(`bad role name ${r.role}`);
    const name = `${appPrefix(env)}/${r.parameter}`;
    // The admin connection is up (the pooler answers) and proves the role exists and may log in: a later "wrong
    // password" for it is about the password, not about a pooler that does not know the role yet.
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
      let result;
      try {
        // Retried: one pooler hiccup must not change the password the running API and App hold.
        result = await login(stored, { attempts: checkAttempts, delayMs: checkDelayMs });
      } catch {
        throw new Stop(`${r.role}: logging in with the stored connection string failed ${checkAttempts} times, never with "wrong password" (SQLSTATE 28P01). The password was NOT changed (the running services keep it). Run the workflow again later.`);
      }
      if (result === "ok") { info(`${r.role}: the stored connection string logs in (kept)`); out[r.role] = "kept"; continue; }
      info(`${r.role}: the database answers "wrong password" (28P01) to the stored string ${checkAttempts} times: setting a new one`);
    } else {
      info(`${r.role}: no connection string in ${name} yet: setting a password`);
    }

    const password = newPassword();
    mask(password);
    const url = roleUrl(a, r, password);
    mask(url);
    // The verifier, not the password: the statement (and any log of it) holds nothing that logs in. The new verifier
    // is committed only once the new connection string is stored: if the SSM write fails, the role keeps its old
    // password (and nobody is left without one).
    const verifier = scramVerifier(password);
    await admin.query("begin");
    let putDone = false;
    try {
      await admin.query(`alter role ${r.role} with login password '${verifier}'`);
      await ssm.send(new PutParameterCommand({ Name: name, Type: "SecureString", Value: url, Overwrite: true, Description: `fenvix: connection string of the role ${r.role} (Supabase pooler, ${r.mode} mode). Set by the deploy pipeline.` }));
      putDone = true;
      await admin.query("commit");
    } catch (e) {
      await admin.query("rollback").catch(() => undefined);
      const why = /** @type {{ name?: string }} */ (e).name ?? "error";
      if (!putDone) throw new Stop(`${r.role}: the new connection string could not be stored (${why}); the password change was rolled back, nothing changed. Run the workflow again.`);
      // SSM already holds the new string, but the password change was not committed: put SSM back the way it was
      // (or remove the parameter if there was none), so the running services keep a string that logs in.
      try {
        if (stored) await ssm.send(new PutParameterCommand({ Name: name, Type: "SecureString", Value: stored, Overwrite: true }));
        else await ssm.send(new DeleteParameterCommand({ Name: name }));
      } catch (restoreError) {
        throw new Stop(`${r.role}: the new connection string was stored in ${name}, but the password change could not be committed (${why}), and putting the previous value back failed too (${/** @type {{ name?: string }} */ (restoreError).name ?? "error"}). SSM now holds a connection string that the role does NOT accept: the API and the GitHub App load it within 5 minutes and will then fail to log in. Run the workflow again NOW (it sees "wrong password" and sets a new one).`);
      }
      throw new Stop(`${r.role}: the password change could not be committed (${why}) after the new connection string was stored; the previous value of ${name} was ${stored ? "put back" : "removed (there was none)"} and the password change was rolled back, so nothing changed. Run the workflow again.`);
    }
    // The pooler may take a moment to see the new password.
    const check = await login(url, { attempts: verifyAttempts, delayMs: verifyDelayMs }).catch(() => "unreachable");
    if (check !== "ok") throw new Stop(`${r.role}: the new password was set but logging in through the pooler still fails. The next deploy tries again.`);
    info(`${r.role}: new password set (SCRAM verifier), connection string stored in ${name}, login checked (${r.mode} mode)`);
    out[r.role] = "set";
  }
  return out;
}
