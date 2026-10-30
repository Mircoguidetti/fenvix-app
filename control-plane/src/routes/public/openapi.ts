/**
 * The OpenAPI 3.1 description of the public API, served at GET /v1/openapi.json. Written by hand next to the routes
 * (index.ts); tests/integration/public-openapi.test.ts fails when a route is missing here or this describes a route
 * that does not exist.
 */

type Schema = Record<string, unknown>;
const ref = (name: string): Schema => ({ $ref: `#/components/schemas/${name}` });
const str = (extra: Schema = {}): Schema => ({ type: "string", ...extra });
const dateTime = (nullable = false): Schema => (nullable ? { type: ["string", "null"], format: "date-time" } : { type: "string", format: "date-time" });
const obj = (properties: Record<string, Schema>, required = Object.keys(properties)): Schema => ({ type: "object", properties, required });
const page = (item: string): Schema => obj({ items: { type: "array", items: ref(item) }, nextCursor: { type: ["string", "null"], description: "Pass as `cursor` to get the next page; null on the last page." } });

const json = (schema: Schema, description: string) => ({ description, content: { "application/json": { schema } } });
const err = (description: string) => json(ref("Error"), description);

const P = {
  id: { name: "id", in: "path", required: true, schema: str({ format: "uuid" }) },
  username: { name: "username", in: "path", required: true, schema: str({ pattern: "^[a-z][a-z0-9_-]{2,31}$" }) },
  cursor: { name: "cursor", in: "query", required: false, schema: str(), description: "The nextCursor of the previous page." },
  limit: { name: "limit", in: "query", required: false, schema: { type: "integer", minimum: 1, maximum: 100, default: 20 } },
  range: { name: "range", in: "query", required: true, schema: str({ enum: ["24h", "7d", "30d"] }), description: "24h: 24 hourly buckets. 7d: 28 six-hourly buckets (UTC 00, 06, 12, 18). 30d: 30 UTC days. The last bucket is the current one." },
  idem: { name: "Idempotency-Key", in: "header", required: false, schema: str({ minLength: 1, maxLength: 255 }), description: "Repeat a request safely for 24 hours. See the Idempotency section." },
};

/** Errors every authenticated route can answer. */
const common = {
  "401": err("No key, or the key is not valid, has expired or has been revoked."),
  "429": err("Too many requests. Wait for the number of seconds in Retry-After."),
};
const changing = { "400": err("The request is not valid; `field` names the part that is not."), "403": err("The key is read only."), "409": err("Conflict: the name is taken, the database is busy, or the Idempotency-Key was used for another request.") };
const accepted = { "202": json(obj({ operation: ref("Operation") }), "Still running. Poll the URL in Location (GET /operations/{id}).") };

function op(operationId: string, summary: string, o: { params?: unknown[]; body?: Schema; responses: Record<string, unknown>; admin?: boolean; idem?: boolean; session?: boolean; description?: string }) {
  return {
    operationId, summary,
    ...(o.description ? { description: o.description } : {}),
    ...(o.session ? { security: [{ apiKey: [] }, { session: [] }] } : {}),
    "x-fenvix-role": o.admin ? "admin" : "any",
    parameters: [...(o.params ?? []), ...(o.idem ? [P.idem] : [])],
    ...(o.body ? { requestBody: { required: true, content: { "application/json": { schema: o.body } } } } : {}),
    responses: { ...o.responses, ...common },
  };
}

export function buildOpenApi(apiPublicUrl: string, regions: string[]) {
  return {
    openapi: "3.1.0",
    info: {
      title: "Fenvix public API",
      version: "1.0.0",
      description: "Manage databases, their users and network allowlists, and API keys of your Fenvix organization, and read its usage. "
        + "Every request needs `Authorization: Bearer fvx_...`. Every answer has an `X-Request-Id` header. Guide: docs/public-api.md.",
    },
    servers: [{ url: `${apiPublicUrl}/public` }],
    security: [{ apiKey: [] }],
    paths: {
      "/databases": {
        get: op("listDatabases", "List databases, newest first", { params: [P.cursor, P.limit], responses: { "200": json(page("Database"), "A page of databases."), "400": err("Bad cursor or limit.") } }),
        post: op("createDatabase", "Create a database", {
          admin: true, idem: true,
          description: "Answers 201 with the database and its initial user. The initial user's password is in this answer only (null in a replay or a poll).",
          body: obj({
            name: str({ pattern: "^[a-z0-9][a-z0-9-]{1,46}[a-z0-9]$", description: "3 to 48 lowercase letters, numbers or dashes." }),
            region: str({ enum: regions }),
            tags: { type: "array", items: str({ description: "key:value" }) },
            appUser: str({ description: "Name of the initial database user. Default app." }),
          }, ["name", "region"]),
          responses: { "201": json(ref("CreatedDatabase"), "Created."), ...accepted, ...changing },
        }),
      },
      "/databases/{id}": {
        get: op("getDatabase", "Get a database", { params: [P.id], responses: { "200": json(ref("Database"), "The database. Its connection string never holds a password."), "404": err("No such database in this organization.") } }),
        delete: op("deleteDatabase", "Delete (erase) a database", {
          admin: true, idem: true, params: [P.id],
          responses: { "200": json(obj({ id: str({ format: "uuid" }), deleted: { const: true } }), "Erased."), ...accepted, ...changing, "404": err("No such database in this organization.") },
        }),
      },
      "/databases/{id}/users": {
        get: op("listDatabaseUsers", "List a database's users", { params: [P.id, P.cursor, P.limit], responses: { "200": json(page("DatabaseUser"), "A page of users, by name. Never a password."), "404": err("No such database."), "503": err("Database users are not available on this deployment yet.") } }),
        post: op("createDatabaseUser", "Create a database user", {
          admin: true, idem: true, params: [P.id],
          description: "The password is in this answer only. Repeating the request with the same Idempotency-Key answers 409 and makes nothing.",
          body: obj({ username: str({ pattern: "^[a-z][a-z0-9_-]{2,31}$" }), role: str({ enum: ["readWrite", "read"], default: "readWrite" }) }, ["username"]),
          responses: { "201": json(ref("CreatedDatabaseUser"), "Created."), ...changing, "404": err("No such database."), "503": err("Database users are not available on this deployment yet.") },
        }),
      },
      "/databases/{id}/users/{username}": {
        delete: op("deleteDatabaseUser", "Delete a database user", {
          admin: true, idem: true, params: [P.id, P.username],
          responses: { "200": json(obj({ username: str(), deleted: { const: true } }), "Deleted."), ...changing, "404": err("No such database or user."), "503": err("Database users are not available on this deployment yet.") },
        }),
      },
      "/databases/{id}/ip-allowlist": {
        get: op("getIpAllowlist", "Get a database's IP allowlist", { params: [P.id], responses: { "200": json(ref("IpAllowlist"), "The allowlist."), "404": err("No such database.") } }),
        put: op("setIpAllowlist", "Replace a database's IP allowlist", {
          admin: true, idem: true, params: [P.id],
          body: obj({ entries: { type: "array", maxItems: 100, items: str({ description: "IPv4 or IPv6 address or CIDR network" }) } }),
          responses: { "200": json(ref("IpAllowlist"), "The new allowlist."), ...changing, "404": err("No such database."), "503": err("The engine did not answer; nothing was changed.") },
        }),
      },
      "/usage": {
        get: op("getUsage", "Usage of the organization", {
          description: "Requests and stored bytes of every database of the organization (or of one, with databaseId), per bucket and in total. "
            + "Copied from the engine by the usage sync; see the Usage section of the guide for what each number means and how fresh it is.",
          params: [P.range, { name: "databaseId", in: "query", required: false, schema: str({ format: "uuid" }), description: "Only this database (same answer as GET /databases/{id}/usage)." }],
          responses: { "200": json(ref("Usage"), "The usage."), "400": err("Missing or unknown range."), "404": err("databaseId is not a database of this organization.") },
        }),
      },
      "/databases/{id}/usage": {
        get: op("getDatabaseUsage", "Usage of a database", {
          params: [P.id, P.range],
          responses: { "200": json(ref("Usage"), "The usage. activeDatabases is 0 or 1."), "400": err("Missing or unknown range."), "404": err("No such database in this organization.") },
        }),
      },
      "/usage/export": {
        get: op("exportUsageCsv", "Monthly usage report as CSV", {
          description: "The dashboard's monthly report (per database or per tag), as a signed link to a CSV file that works for 15 minutes without a key. The file is built when the link is opened.",
          params: [
            { name: "month", in: "query", required: true, schema: str({ pattern: "^\\d{4}-\\d{2}$" }), description: "YYYY-MM (UTC)." },
            { name: "by", in: "query", required: true, schema: str({ enum: ["database", "tag"] }) },
            { name: "tagKey", in: "query", required: false, schema: str(), description: "With by=tag: one row per value of this tag key (and (none)). Without it: one row per key:value." },
            { name: "sort", in: "query", required: false, schema: str({ enum: ["name", "databases", "storageGb", "requests"], default: "requests" }), description: "databases only with by=tag." },
            { name: "dir", in: "query", required: false, schema: str({ enum: ["asc", "desc"], default: "desc" }) },
          ],
          responses: {
            "200": json(obj({ filename: str(), mimeType: { const: "text/csv" }, downloadUrl: str({ format: "uri" }), expiresAt: dateTime() }), "The link."),
            "400": err("Bad parameters, or there is no usage for that month."),
          },
        }),
      },
      "/organization": {
        get: op("getOrganization", "The key's organization", { responses: { "200": json(ref("Organization"), "The organization.") } }),
      },
      "/operations/{id}": {
        get: op("getOperation", "Poll a long operation", { params: [P.id], responses: { "200": json(ref("OperationWithResult"), "The operation."), "404": err("No such operation.") } }),
      },
      "/api-keys": {
        get: op("listApiKeys", "List API keys", { admin: true, session: true, params: [P.cursor, P.limit], responses: { "200": json(page("ApiKey"), "A page of keys, newest first. Never the key itself."), "403": err("The key is read only.") } }),
        post: op("createApiKey", "Create an API key", {
          admin: true, session: true, idem: true,
          description: "The key (`token`) is in this answer only; store it now. Repeating the request with the same Idempotency-Key answers 409. "
            + "At most 100 active keys per organization (409). Only a dashboard session creates admin keys; a key creates read_only keys "
            + "that expire no later than itself (and must expire if it does), and that are revoked when it is. A session must send X-Fenvix-Workspace.",
          body: obj({ name: str({ minLength: 1, maxLength: 60 }), role: str({ enum: ["admin", "read_only"] }), expiresAt: dateTime(true) }, ["name", "role"]),
          responses: { "201": json(obj({ key: ref("ApiKey"), token: str({ pattern: "^fvx_[A-Za-z0-9_-]{43}$" }) }), "Created."), ...changing },
        }),
      },
      "/api-keys/{id}": {
        delete: op("revokeApiKey", "Revoke an API key", { admin: true, session: true, idem: true, params: [P.id], responses: { "200": json(ref("ApiKey"), "Revoked (repeating it changes nothing)."), ...changing, "404": err("No such key in this organization.") } }),
      },
    },
    components: {
      securitySchemes: {
        apiKey: { type: "http", scheme: "bearer", bearerFormat: "fvx_<43 characters>", description: "A public API key of your organization." },
        session: { type: "http", scheme: "bearer", bearerFormat: "JWT", description: "A signed-in dashboard session (owner or admin), with the organization named in X-Fenvix-Workspace. Only for managing API keys, so the first key can be made." },
      },
      schemas: {
        Error: obj({ error: obj({ code: str({ enum: ["validation_failed", "unauthenticated", "forbidden", "not_found", "conflict", "rate_limited", "internal", "unavailable"] }), message: str(), field: str() }, ["code", "message"]) }),
        Database: obj({
          id: str({ format: "uuid" }), name: str(), status: str({ enum: ["ready", "restoring", "erasing"] }), state: str({ enum: ["awake", "asleep"] }),
          region: str(), host: str(), connectionString: str({ description: "mongodb://user:<password>@host:port/db?...: the password is never filled in." }),
          storageMb: { type: "number" }, requests24h: { type: "number" }, lastActiveAt: dateTime(), createdAt: dateTime(),
          tags: { type: "array", items: str() }, keepAwake: { type: "boolean" }, forkedFrom: { type: ["string", "null"] }, restoredTo: dateTime(true),
        }),
        CreatedDatabase: {
          allOf: [ref("Database"), { type: "object", properties: { initialUser: { oneOf: [{ type: "null" }, obj({ username: str(), role: str(), password: { type: ["string", "null"] }, connectionString: { type: ["string", "null"] } })] } }, required: ["initialUser"] }],
        },
        DatabaseUser: obj({ username: str(), role: str({ enum: ["readWrite", "read"] }), createdAt: dateTime(true) }),
        CreatedDatabaseUser: obj({ user: ref("DatabaseUser"), password: str(), connectionString: str() }),
        IpAllowlist: { type: "object", required: ["entries", "allowAll", "maxEntries"], properties: {
          entries: { type: "array", items: str() }, allowAll: { type: "boolean" }, maxEntries: { type: "integer" }, updatedAt: dateTime(true),
          updatedBy: { type: ["object", "null"] }, engine: { type: "object" }, dataExplorer: { type: "object" },
        } },
        Organization: obj({ id: str({ format: "uuid" }), name: str(), members: { type: "integer" }, apiKey: { oneOf: [{ type: "null" }, obj({ id: str({ format: "uuid" }), role: str({ enum: ["admin", "read_only"] }) })] } }),
        Operation: obj({
          id: str({ format: "uuid" }), kind: str({ enum: ["create", "fork", "restore", "export", "erase"] }), status: str({ enum: ["queued", "running", "succeeded", "failed"] }),
          databaseId: { type: ["string", "null"] }, createdAt: dateTime(), updatedAt: dateTime(), finishedAt: dateTime(true), error: { oneOf: [{ type: "null" }, { type: "object" }] },
        }),
        OperationWithResult: { allOf: [ref("Operation"), { type: "object", properties: { result: { description: "When succeeded: what the original request would have answered (a database, or { id, deleted })." } }, required: ["result"] }] },
        Usage: obj({
          range: str({ enum: ["24h", "7d", "30d"] }), databaseId: { type: ["string", "null"], format: "uuid" },
          from: dateTime(), to: dateTime(), bucketSeconds: { type: "integer", enum: [3600, 21600, 86400] },
          totals: obj({
            requests: { type: "integer", description: "Requests of the range: the sum of the buckets." },
            storageBytes: { type: "integer", description: "Stored bytes at the end of the range: each database's newest value in the range, added up." },
          }),
          items: { type: "array", items: ref("UsageBucket"), description: "Every bucket of the range, oldest first; a bucket without data is zeros." },
        }),
        UsageBucket: obj({
          at: dateTime(), requests: { type: "integer", description: "Requests (database commands) in the bucket." },
          storageBytes: { type: "integer", description: "Stored bytes: each database's newest value in the bucket, added up." },
          activeDatabases: { type: "integer", description: "Databases that served at least one request in the bucket." },
        }),
        ApiKey: obj({
          id: str({ format: "uuid" }), name: str(), role: str({ enum: ["admin", "read_only"] }), prefix: str({ description: "fvx_ and the next 8 characters, to tell keys apart." }),
          status: str({ enum: ["active", "revoked", "expired"] }), createdAt: dateTime(), lastUsedAt: dateTime(true), expiresAt: dateTime(true), revokedAt: dateTime(true),
        }),
      },
    },
  };
}
