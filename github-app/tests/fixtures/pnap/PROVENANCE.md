# phoenixNAP API descriptions (test fixtures)

The fake phoenixNAP API of the tests (`tests/helpers/fake-pnap.ts`) validates every request our client sends and every
response it answers against these files. They are phoenixNAP's own OpenAPI descriptions (declared license: Apache
2.0, in each file's `info.license`), as published in phoenixNAP's generated Go SDK, branch `develop`, read 2026-11-18:

| File | Source | SHA-256 |
|---|---|---|
| `bmc-api.yaml` | https://raw.githubusercontent.com/phoenixnap/go-sdk-bmc/develop/bmcapi/api/openapi.yaml ("Bare Metal Cloud API", server https://api.phoenixnap.com/bmc/v1) | `0f10e5b5c7d270dd25ca8459c6612fd3444fceed432387c041928c23e9b8b20f` |
| `billing-api.yaml` | https://raw.githubusercontent.com/phoenixnap/go-sdk-bmc/develop/billingapi/api/openapi.yaml ("Billing API", server https://api.phoenixnap.com/billing/v1) | `cc2660dd1322d0031f8780726909a2ef4fc756e3b315fe4857d6c409fcf5adfb` |

developers.phoenixnap.com renders the same descriptions in the browser (a client-side portal); its raw spec download
was not reachable from the session that added these files, so the SDK copies were used. OAuth: client credentials at
`https://auth.phoenixnap.com/auth/realms/BMC/protocol/openid-connect/token`, scopes `bmc` and `bmc.read` (both files'
`securitySchemes`).
