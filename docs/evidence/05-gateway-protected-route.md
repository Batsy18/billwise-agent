# Protected gateway route — 401 without a token, 200 with a token

Live run against GCP API Gateway on 2026-11-20 (read-only requests; a login issues a token
but changes nothing). The access token is truncated; the demo password is replaced by a placeholder.

- Gateway: `https://billwise-gw-28mjkppx.ew.gateway.dev` (config: [infra/gateway/openapi-gateway.tmpl.yaml](../../infra/gateway/openapi-gateway.tmpl.yaml))
- `POST /api/v1/payments` and `GET /api/v1/bills/{subscriberNo}/detailed` are **JWT routes**: the gateway
  validates the RS256 token (issuer, audience, signature via the JWKS served through the gateway itself)
  before the request reaches Cloud Run.
- The billing-api Cloud Run service **requires authentication**; only the gateway's service account holds
  `roles/run.invoker`, so the direct URL answers **403** — the gateway cannot be bypassed.

## 1. No token → 401 from the gateway (the request never reaches the API)

```text
$ curl -i -X POST -H "content-type: application/json" -d "{}" https://billwise-gw-28mjkppx.ew.gateway.dev/api/v1/payments
HTTP/1.1 401 Unauthorized
content-type: application/json
{"code":401,"message":"Jwt is missing"}


$ curl -s -X POST -H "content-type: application/json" -d "{\"subscriberNo\":\"5551000002\",\"password\":\"<demo password>\"}" https://billwise-gw-28mjkppx.ew.gateway.dev/api/v1/auth/login
{"accessToken":"eyJhbGciOiJSUzI1NiIsInR5…(truncated)","tokenType":"Bearer","expiresIn":3600}
```

The same body is saved byte-for-byte in [infra/gateway-401-example.json](../../infra/gateway-401-example.json).

## 2. With the token → 200, tampered token → 401, someone else's account → 403 (API rule), direct Cloud Run → 403

```text
$ curl -i -H "Authorization: Bearer $TOKEN" "https://billwise-gw-28mjkppx.ew.gateway.dev/api/v1/bills/5551000002/detailed?month=10&year=2026&pageSize=2"
HTTP/1.1 200 OK
x-trace-id: a9345096e3dbdf8e455567960099f7df
{
  "subscriberNo": "5551000002",
  "month": 10,
  "year": 2026,
  "total": 80,
  "paidAmount": 0,
  "remainingBalance": 80,
  "status": "UNPAID",
  "dueDate": "2026-11-15",
  "usage": {
    "phoneMinutes": 1350,
    "internetMB": 35000,
    "internetGB": 35
  },
  "charges": {
    "phone": {
      "includedMinutes": 1000,
      "extraBlocks": 1,
      "amount": 10
    },
    "internet": {
      "base": 50,
      "extraBlocks": 2,
      "amount": 70
    }
  },
  "usageEvents": {
    "items": [
      {
        "id": "0114d939-fa11-4fc1-88f5-50e4b3148a9f",
        "usageType": "PHONE",
        "amount": 10,
        "unit": "MIN",
        "createdAt": "2026-11-18T20:06:46.475Z"
      },
      {
        "id": "0519213b-9c5d-4ac6-ab3c-761219e8a450",
        "usageType": "PHONE",
        "amount": 10,
        "unit": "MIN",
        "createdAt": "2026-11-18T20:06:46.475Z"
      }
    ],
    "page": 1,
    "pageSize": 2,
    "totalItems": 35135,
    "totalPages": 17568
  },
  "calculatedAt": "2026-11-18T20:06:53.572Z"
}


$ curl -i -H "Authorization: Bearer ${TOKEN}x" "https://billwise-gw-28mjkppx.ew.gateway.dev/api/v1/bills/5551000002/detailed?month=10&year=2026"   # tampered signature
HTTP/1.1 401 Unauthorized
{"code":401,"message":"Jwt verification fails"}


$ curl -i -H "Authorization: Bearer $TOKEN" "https://billwise-gw-28mjkppx.ew.gateway.dev/api/v1/bills/5551000001/detailed?month=10&year=2026"   # someone else's account
HTTP/1.1 403 Forbidden
{"error":{"code":"FORBIDDEN","message":"You can only access your own account","traceId":"aeb157514c6ec20776c1123a41f0de0a"}}


$ curl -i https://billing-api-175505721909.europe-west1.run.app/api/v1/health   # billing-api Cloud Run URL directly, NO credentials
HTTP/1.1 403 Forbidden
<title>403 Forbidden</title>


$ curl -i -X POST -H "content-type: application/json" -d "{}" https://billing-api-175505721909.europe-west1.run.app/api/v1/payments   # directly, NO credentials
HTTP/1.1 403 Forbidden
<title>403 Forbidden</title>
```

## 3. The user's token reached the API as `X-Forwarded-Authorization`

The gateway calls Cloud Run with **its own** Google ID token in `Authorization` and forwards the user's
header as `X-Forwarded-Authorization`; the API reads that one first. Structured request log of the 200
request above (Cloud Logging, same trace id as the `x-trace-id` response header). `auth` records
**which header** carried the token — never the token itself:

```json
{
  "timestamp": "2026-11-20T18:41:44.542734Z",
  "severity": "INFO",
  "resource": {
    "type": "cloud_run_revision",
    "service_name": "billing-api",
    "revision_name": "billing-api-00002-v5v"
  },
  "trace": "projects/project-b81d9425-6ed1-4fb6-a4e/traces/a9345096e3dbdf8e455567960099f7df",
  "jsonPayload": {
    "auth": "x-forwarded-authorization",
    "message": "GET /api/v1/bills/5551000002/detailed 200 485.0 ms",
    "traceId": "a9345096e3dbdf8e455567960099f7df"
  },
  "httpRequest": {
    "latency": "0.485s",
    "requestMethod": "GET",
    "requestUrl": "/api/v1/bills/5551000002/detailed",
    "status": 200,
    "userAgent": "curl/8.23.0"
  }
}
```

Read with:

```bash
gcloud logging read 'resource.type="cloud_run_revision" AND resource.labels.service_name="billing-api" AND jsonPayload.auth="x-forwarded-authorization"' --project=<project-id> --limit=1
```
