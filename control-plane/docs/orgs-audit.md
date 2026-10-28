# Organizations: what existed before the `orgs-invites` branch

Audit of `origin/navbar-fix` @ `29351aa`, written before any code of this branch. "Workspace" and "organization" are
the same thing: the table stays `workspaces`, the dashboard says "organization".

## 1. What already existed

| Area | What is there | Where |
| --- | --- | --- |
| Workspace table | `workspaces (id, name 1–60 chars, created_at)`. No flag for a confirmed name. | `0001_init.sql` |
| Membership | `workspace_members (workspace_id, user_id, role ∈ owner/admin/member, created_at)`, primary key on the pair, so **several workspaces per user are already possible in the schema**. | `0001_init.sql` |
| Workspace at sign-up | `on_auth_user_created` → `handle_new_user()` → `ensure_workspace()`: a workspace named after the person (or the local part of the email), the person as `owner`, a `workspace_settings` row. Only if the user has no membership yet. | `0001_init.sql` (not changed by this branch) |
| "Current" workspace | Always the **oldest** membership: `current_workspace()` (dashboard functions, Supabase path) and `fenvix_cp_workspace_for_user()` (control plane). There is no way to choose another one. | `0001`, `0002` |
| Roles in the control plane | `Caller.role` is read from the membership. `Access.role: "admin"` lets owner and admin through and refuses member (403). Used only on: `POST /databases/erase`, `GET/POST /api-keys`, `POST /api-keys/:id/revoke`, `PUT /settings`. Database users (create, reset, delete) check owner/admin in `requireManage`. | `http.ts`, `routes/data.ts`, `services/db-users.ts` |
| Roles **not** enforced | A `member` could create, fork, restore and export databases, change keep-awake and tags, download invoices, and **insert, save and delete documents** in the Data Explorer (`requireWrite` allows owner, admin and member). Owner and admin were treated the same everywhere. | `routes/data.ts`, `services/explorer.ts` |
| Row level security | Every table: read and write for any member of the workspace (`*_member_write` policies: no role check). `workspaces_member_update` lets **any member rename** the workspace. `workspace_members`: read only for signed-in users (no insert, update, delete grants). 0003 (applied at cutover) removes the dashboard's write path for `databases`, `database_tags`, `api_keys`, `workspace_settings`, but not for `workspaces`, usage, invoices. The control-plane role has **no right at all** on `workspace_members`. | `0001`, `0002`, `0003` |
| Invitations | None: no table, no route, no page. | – |
| Members page | None. Settings shows a hard-coded "Role: Owner" and "Member since March 2026". | `src/pages/Settings.tsx` |
| Workspace switcher | None. The sidebar shows one workspace (coloured avatar, name, "Managed") read from `getSettings()`; not clickable. | `src/components/Shell.tsx` |
| Name at sign-up | None: the name is made up from the person's name or email; it can be changed in Settings (owner/admin through the control plane, anyone through Supabase before 0003). | – |
| Audit | `audit_log` (who, action, target, outcome, request id, IP, metadata with secret-looking keys removed). Used for API keys, settings, operations, database users. Nothing about members. | `0002`, `audit.ts` |
| Rate limits | In-memory fixed windows per address, per workspace, per e-mail hash. | `ratelimit.ts` |
| Email sending | Only Supabase's sign-in link. There is no provider for other mail. | `auth/gateway.ts` |

## 2. What this branch builds (only what is missing)

1. `workspaces.name_confirmed` (default `false`) and the "Name your organization" screen for an owner whose
   workspace name is not confirmed. The sign-up trigger is not touched.
2. `workspace_invites`: hash of a 32-byte random token, e-mail, role (admin or member), 7-day expiry, single use,
   revocable; create, list, revoke, accept; 20 a day per workspace, at most 50 members.
3. Roles enforced by the server for **every** changing route (member → 403 everywhere; owner vs admin rules for
   members and invites) and by row level security (writes by signed-in users need owner or admin; workspace rename
   needs owner or admin).
4. Several organizations per user: the client names the one it acts for (`X-Fenvix-Workspace`), the server checks the
   membership and role on every request (control plane) and in `current_workspace()` (Supabase path).
5. Settings → Members and Organization; sidebar switcher (create, switch, leave).
6. Migration `0008_organizations.sql` (repeatable), RLS tests, audit rows for every change.

What is reused as is: the membership table and its roles, the sign-up trigger, `audit_log` and `writeAudit`, the
error and rate-limit machinery, the route helpers, the one-time "copy" pattern of API keys and passwords.
