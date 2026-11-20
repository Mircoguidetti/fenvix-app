/**
 * What a smoke check that never answered as expected means for the deploy (audit G-2284). With the Cloudflare
 * token, the pipeline made the DNS records itself: any failure stops the run. Without it, step 9 already waited for
 * the records the founder adds and stopped if they were missing; so here only a name that does not resolve yet (DNS
 * still spreading) is a warning, and anything else (an error status, a refused connection, a TLS error, a timeout)
 * stops the run like with the token.
 * @param {{ strict: boolean, last: string }} o  last: the last HTTP status ("HTTP 502") or the error code seen
 * @returns {"stop" | "warn"}
 */
export function smokeVerdict({ strict, last }) {
  if (strict) return "stop";
  return /^(ENOTFOUND|EAI_AGAIN)$/.test(last) ? "warn" : "stop";
}
