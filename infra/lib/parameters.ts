/**
 * The SecureString parameters the founder creates by hand in SSM Parameter Store (README.md, "The secrets"). Never
 * created by the stack and never written in the code: only their names live here. One list, used by the stack (what
 * must exist before a service starts), the boot script and the tests; the README table mirrors it.
 *
 * Names are relative to `/fenvix/<env>/`. Engine parameters become files in /run/fenvix (0600, owner fenvix);
 * control-plane parameters become variables of the container (name in capitals, `-` -> `_`).
 */
export interface SecretParameter {
  /** `engine/<name>` or `control-plane/<name>`. */
  name: string;
  /** The service refuses to start without it. */
  required: boolean;
  /** What it becomes on the server. */
  becomes: string;
  /** What to put in it. */
  value: string;
}

export const SECRET_PARAMETERS: SecretParameter[] = [
  {
    name: 'engine/admin-token',
    required: true,
    becomes: 'file /run/fenvix/admin-token, passed to the engine with --admin-token-file',
    value: 'a random string of at least 16 characters (`openssl rand -hex 32`)',
  },
  {
    name: 'control-plane/engine-admin-token',
    required: true,
    becomes: 'ENGINE_ADMIN_TOKEN',
    value: 'the same value as engine/admin-token (checked at start)',
  },
  {
    name: 'control-plane/engine-user-key',
    required: true,
    becomes: 'ENGINE_USER_KEY',
    value: '`v1:` followed by at least 32 random characters (`echo "v1:$(openssl rand -hex 32)"`)',
  },
  {
    name: 'control-plane/engine-user-key-previous',
    required: false,
    becomes: 'ENGINE_USER_KEY_PREVIOUS',
    value: 'only while rotating engine-user-key: the old value',
  },
  {
    name: 'control-plane/engine-provisioner-password',
    required: true,
    becomes: 'ENGINE_PROVISIONER_PASSWORD',
    value: 'a random string (`openssl rand -hex 32`); the engine user is made with it in Step 10',
  },
  {
    name: 'control-plane/download-signing-key',
    required: true,
    becomes: 'DOWNLOAD_SIGNING_KEY',
    value: 'a random string of at least 32 characters (`openssl rand -hex 32`)',
  },
  {
    name: 'control-plane/control-plane-database-url',
    required: true,
    becomes: 'CONTROL_PLANE_DATABASE_URL',
    value: 'the Postgres connection string of the fenvix_control_plane role (control-plane/README.md)',
  },
  {
    name: 'control-plane/supabase-url',
    required: true,
    becomes: 'SUPABASE_URL',
    value: 'the Supabase project URL, https://<ref>.supabase.co',
  },
  {
    name: 'control-plane/supabase-anon-key',
    required: true,
    becomes: 'SUPABASE_ANON_KEY',
    value: 'the Supabase public (anon) key; never the service_role key',
  },
];

/** Two parameters that must hold the same value, checked before the control plane starts. */
export const MUST_MATCH: [string, string] = ['control-plane/engine-admin-token', 'engine/admin-token'];

export function ssmPrefix(envName: string): string {
  return `/fenvix/${envName}`;
}

/** Full names of the parameters a service cannot start without. */
export function requiredSecretNames(envName: string): string[] {
  return SECRET_PARAMETERS.filter((p) => p.required).map((p) => `${ssmPrefix(envName)}/${p.name}`);
}
