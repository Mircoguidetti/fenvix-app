# Organizations, members and invitations

An organization is a row of `workspaces`. People belong to it through `workspace_members` with one role. What existed
before this work is in [`orgs-audit.md`](orgs-audit.md); the routes are in [`api-extensions.md`](api-extensions.md#organizations).
Migration: `supabase/migrations/0008_organizations.sql` (repeatable). It does not change the sign-up trigger.

## Roles

| | owner | admin | member |
| --- | --- | --- | --- |
| See databases, usage, billing, members, Data Explorer (read only) | yes | yes | yes |
| Create, fork, restore, export, erase, keep awake, tag databases | yes | yes | **403** |
| Change documents in the Data Explorer; create, reset, delete database users | yes | yes | **403** |
| API keys, settings, rename the organization | yes | yes | **403** |
| Invite people as member; revoke those invitations; remove members | yes | yes | **403** |
| Invite admins; change any role (including to owner); remove admins and owners | yes | **403** | **403** |
| Change their own role | yes, unless last owner | **403** | **403** |
| Leave | yes, unless last owner | yes | yes |

* The role always comes from the membership row the server reads for this request, never from the request.
* The last owner can neither leave, be removed nor be demoted: the service answers `409`, and the trigger
  `workspace_members_keep_owner` refuses it in the database too (a whole workspace or account can still be deleted).
* A member never receives a password: the routes that answer one (create, fork, user create and reset) are `403` for
  them, and connection strings always say `<password>`.
* Billing and plan changes, and deleting an organization, have no route; when they get one, they are owner only.

Row level security (signed-in users through Supabase): every write policy needs owner or admin
(`my_admin_workspace_ids()`), renaming needs owner or admin, `name_confirmed` and memberships cannot be written at all,
and invitations are not readable. The control-plane role reaches members and invitations of the workspace named for its
transaction only.

## Choosing an organization

The dashboard keeps the chosen organization in the browser and sends it as `X-Fenvix-Workspace`, to the control plane
and to Supabase. The control plane checks the membership on every request (`404` when it is not one). In Supabase,
`current_workspace()` uses the header only when the caller is a member of that organization and otherwise falls back to
the oldest membership, so naming another organization never shows anything of it.

## The organization name

The sign-up trigger still makes a workspace named after the person, with `name_confirmed = false` (every workspace
that existed before 0008 is `false` too). An owner whose current organization is not confirmed sees "Name your
organization" (2 to 64 characters, trimmed, one line, no control characters) before the dashboard; saving renames it
and sets `name_confirmed`. Someone who joined by invitation is not an owner of it and never sees the screen. Names are
always shown as text.

## Invitations

* Created by an owner (admin or member) or an admin (member only). The token is 32 random bytes (base64url); only its
  SHA-256 is stored. The link `https://<dashboard>/invite#token=…` is in the creating answer only; the token is after
  `#`, so it is never sent to a server by the browser and never appears in a log or a Referer.
* Valid 7 days, single use, revocable. No e-mail is sent (there is no provider yet): the inviter copies the link.
* Accepting needs a signed-in person whose **verified** e-mail (`auth.users.email_confirmed_at`) is the invited one.
  Unknown, malformed, expired, used, revoked, another e-mail, unverified: the same `404`, the same message, the same
  headers, after the same two lookups. A refused attempt on an existing invitation is recorded in that organization's
  audit log with its reason. 10 attempts a minute per person.
* Accepting adds the person to that organization only, with the invited role. Already a member: the role they have
  stays.
* Limits: 20 invitations a day per organization (counted in Postgres; `429` with `Retry-After`), 50 members per
  organization counting pending invitations (`409`).

## Audit

`audit_log` rows, with who (`actor_id`), what (`action`, `target_id`, small metadata such as roles) and when:
`organization.create`, `organization.rename`, `organization.leave`, `invitation.create`, `invitation.accept`
(`ok` or `denied` with a reason), `invitation.revoke`, `member.role_change` (`from`, `to`), `member.remove`. Never a
token, a link, a password or an invited e-mail; log lines carry ids only.

## Not covered

* Rate limits other than invitations per day are in memory, per instance (see `ratelimit.ts`).
* Without `VITE_API_URL` the dashboard cannot reach these routes: it shows the organization by name only, without the
  switcher, members or the name screen.
