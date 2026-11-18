// Serves local GoTrue under /auth/v1, as a hosted Supabase project does (Kong does this there), so supabase-js in the
// dashboard and the API's token check use the same URLs locally as in production. Local development and tests only.
import http from "node:http";

const target = new URL(process.env.GOTRUE_URL ?? "http://127.0.0.1:54321");
const port = Number(process.env.PORT ?? 54320);

http.createServer((req, res) => {
  const cors = { "access-control-allow-origin": req.headers.origin ?? "*", "access-control-allow-headers": "authorization, apikey, content-type, x-client-info, x-supabase-api-version", "access-control-allow-methods": "GET, POST, PUT, DELETE, OPTIONS", "access-control-expose-headers": "x-supabase-api-version" };
  if (req.method === "OPTIONS") { res.writeHead(204, cors); return res.end(); }
  if (!req.url?.startsWith("/auth/v1")) { res.writeHead(404, cors); return res.end(); }
  const path = req.url.slice("/auth/v1".length) || "/";
  const up = http.request({ hostname: target.hostname, port: target.port, path, method: req.method, headers: { ...req.headers, host: target.host } }, (r) => {
    res.writeHead(r.statusCode ?? 502, { ...r.headers, ...cors });
    r.pipe(res);
  });
  up.on("error", () => { res.writeHead(502, cors); res.end(); });
  req.pipe(up);
}).listen(port, "127.0.0.1", () => console.log(`auth proxy: http://127.0.0.1:${port}/auth/v1 -> ${target.href}`));
