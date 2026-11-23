# Evidence

Text logs and traces for the deliverables the course asks to show "with screenshots or logs".
Everything here comes from real runs. Secrets were removed: access tokens are truncated, passwords are
replaced by placeholders, and the trace files contain no tokens, passwords or keys.

| #   | Deliverable                                                                                                                     | File                                                                         | Source                                         |
| --- | ------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ---------------------------------------------- |
| 1   | Agent scenario: **MCP-only** + tool trace                                                                                       | [01-agent-mcp-only.md](01-agent-mcp-only.md)                                 | cloud demo, 2026-11-18                         |
| 2   | Agent scenario: **API-only** + tool trace                                                                                       | [02-agent-api-only.md](02-agent-api-only.md)                                 | cloud demo, 2026-11-18                         |
| 3   | Agent scenario: **combined** + tool trace                                                                                       | [03-agent-combined.md](03-agent-combined.md)                                 | cloud demo, 2026-11-18                         |
| 4   | **3 MCP retrieval tests** (+ negative test, tool schema, 5b robustness table)                                                   | [04-mcp-retrieval.md](04-mcp-retrieval.md)                                   | live calls to the cloud MCP server, 2026-11-20 |
| 5   | **Protected gateway route**: 401 without a token, 200 with a token, 403 direct to Cloud Run, X-Forwarded-Authorization log line | [05-gateway-protected-route.md](05-gateway-protected-route.md)               | live calls to the gateway, 2026-11-20          |
| 6   | **Confirmed simulated payment** (payment gate steps)                                                                            | [06-confirmed-payment.md](06-confirmed-payment.md)                           | cloud demo, 2026-11-18                         |
| 7   | **Unit test run** + coverage                                                                                                    | [07-unit-tests.txt](07-unit-tests.txt)                                       | `npm run test:coverage`, 2026-11-20            |
| 8   | Integration test run (real PostgreSQL)                                                                                          | [08-integration-tests.txt](08-integration-tests.txt)                         | `npm run test:int`, 2026-11-20                 |
| –   | Full cloud demo trace (scenarios a–h)                                                                                           | [traces/2026-11-18-cloud-demo.json](traces/2026-11-18-cloud-demo.json)       | `npm run demo:cloud -- --reseed`               |
| –   | Raw gateway 401 response                                                                                                        | [../../infra/gateway-401-example.json](../../infra/gateway-401-example.json) | `infra/deploy.sh verify`                       |

## Screenshots (optional; the text logs above are the evidence)

Put the images in `docs/evidence/screenshots/` using the file names below.

Before you start:

- Warm up the services first, so no cold start shows: `curl https://billwise-gw-28mjkppx.ew.gateway.dev/api/v1/health/ready` and `curl https://mcp-server-rswe5l4uia-ew.a.run.app/health`.
- Never show `.env` / `.env.cloud`, keys, full tokens or billing/payment-method pages.

- [ ] `swagger-gateway.png`
  - Open `https://billwise-gw-28mjkppx.ew.gateway.dev/api/v1/docs` in a browser.
  - Take a full-window shot showing the gateway URL in the address bar and the list of operations.
- [ ] `gateway-401-200.png`
  - In a terminal, run the commands from section 1 and 2 of [05-gateway-protected-route.md](05-gateway-protected-route.md).
  - Set the token with `TOKEN=$(curl … | node -p "JSON.parse(require('fs').readFileSync(0)).accessToken")`, so it's never printed.
  - Capture the 401 and the 200.
- [ ] `cloud-run-services.png`
  - GCP Console → Cloud Run → Services (project `billwise-cloud`).
  - Shows `billing-api` (Authentication: Require authentication) and `mcp-server` (Allow unauthenticated).
- [ ] `api-gateway.png`
  - GCP Console → API Gateway → Gateways → `billwise-gw`.
  - Shows the gateway URL, the active config and the region `europe-west1`.
- [ ] `cloud-sql.png`
  - GCP Console → SQL → `billwise-pg` overview.
  - Shows PostgreSQL 16, `db-f1-micro`, `europe-west1`. Don't open "Users" or "Connections → passwords".
- [ ] `logging-x-forwarded-authorization.png`
  - GCP Console → Logging → Logs Explorer.
  - Run the query `resource.type="cloud_run_revision" AND resource.labels.service_name="billing-api" AND jsonPayload.auth="x-forwarded-authorization"` and expand one entry.
- [ ] `chat-scenarios.png` (one or more shots)
  - Run `npm run chat:cloud` and log in as `5551000002`.
  - Ask "Ek internet ne kadar?", then "Ekim faturam ne kadar?", then "Ekim faturam neden yüksek?".
  - Capture the `▶` tool lines and the answers.
- [ ] `chat-payment.png`
  - In the same chat, ask "Ekim faturamın 30 dolarını öde" and type `EVET`.
  - Capture the confirmation box, the `↳` gate lines and the answer.
  - Afterwards, re-seed Cloud SQL (proxy + seed, see [infra/README.md](../../infra/README.md)) to get back to $80 UNPAID.
- [ ] `unit-tests.png`
  - Run `npm run test:coverage` in a terminal.
  - Capture the end of the output: the `Tests: 366 passed` line and the coverage summary.
