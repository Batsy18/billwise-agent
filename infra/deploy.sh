#!/usr/bin/env bash
# billwise — reproducible Google Cloud deployment (see infra/README.md).
#
#   infra/deploy.sh <step>...        e.g. infra/deploy.sh apis registry images
#   infra/deploy.sh all              every step in order
#   DRY_RUN=1 infra/deploy.sh <step> print the commands, change nothing
#
# Steps (in order): apis registry images sql secrets iam db-init run gateway env-cloud verify
# Read-only helpers:  status   urls
#
# Idempotent where possible: existing resources are kept (describe || create); secrets are
# never rotated by a re-run; Cloud Run deploys and gateway configs create new revisions.
# Secret VALUES are generated here and piped straight into Secret Manager — never printed.
set -euo pipefail
shopt -s inherit_errexit  # a failing command inside $(…) must stop the script too (bash ≥ 4.4)

# ---------------- settings (override via env) ----------------
PROJECT_ID="${PROJECT_ID:-project-b81d9425-6ed1-4fb6-a4e}"
REGION="${REGION:-europe-west1}"
REPO="${REPO:-billwise}"                       # Artifact Registry repository
SQL_INSTANCE="${SQL_INSTANCE:-billwise-pg}"
SQL_TIER="${SQL_TIER:-db-f1-micro}"
DB_NAME="${DB_NAME:-billwise}"
DB_USER="${DB_USER:-billwise}"
API_SERVICE="${API_SERVICE:-billing-api}"
MCP_SERVICE="${MCP_SERVICE:-mcp-server}"
GATEWAY_API="${GATEWAY_API:-billwise-api}"
GATEWAY="${GATEWAY:-billwise-gw}"
JWT_ISSUER="${JWT_ISSUER:-billwise-billing-api}"
JWT_AUDIENCE="${JWT_AUDIENCE:-billwise-api}"
PROXY_PORT="${PROXY_PORT:-5433}"
GCLOUD="${GCLOUD:-gcloud}"                       # e.g. GCLOUD=gcloud.cmd on Git Bash
PROXY_BIN="${PROXY_BIN:-cloud-sql-proxy}"
DRY_RUN="${DRY_RUN:-0}"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
AR_HOST="${REGION}-docker.pkg.dev"
AR="${AR_HOST}/${PROJECT_ID}/${REPO}"
SQL_CONN="${PROJECT_ID}:${REGION}:${SQL_INSTANCE}"
SA_API="billing-api-run@${PROJECT_ID}.iam.gserviceaccount.com"
SA_MCP="mcp-server-run@${PROJECT_ID}.iam.gserviceaccount.com"
SA_GW="api-gateway@${PROJECT_ID}.iam.gserviceaccount.com"
TAG="${TAG:-$(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || echo dev)-$(date +%Y%m%d%H%M%S)}"

# ---------------- helpers ----------------
gc() { "$GCLOUD" --project="$PROJECT_ID" --quiet "$@"; }
log() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
# Print the exact command, then run it (DRY_RUN=1: print only).
run() {
  printf '+ %s\n' "$*"
  [[ "$DRY_RUN" == 1 ]] || "$@"
}
# Run a gcloud command (exact command printed).
rgc() { run "$GCLOUD" --project="$PROJECT_ID" --quiet "$@"; }
exists() { gc "$@" >/dev/null 2>&1; }
newsecret() { node -e "process.stdout.write(require('crypto').randomBytes(${1:-24}).toString('base64url'))"; }
service_url() { gc run services describe "$1" --region="$REGION" --format='value(status.url)' 2>/dev/null || true; }
gateway_host() { gc api-gateway gateways describe "$GATEWAY" --location="$REGION" --format='value(defaultHostname)' 2>/dev/null || true; }

# ---------------- steps ----------------
step_apis() {
  log "Enable APIs"
  rgc services enable run.googleapis.com sqladmin.googleapis.com secretmanager.googleapis.com \
    artifactregistry.googleapis.com apigateway.googleapis.com servicemanagement.googleapis.com \
    servicecontrol.googleapis.com iam.googleapis.com cloudresourcemanager.googleapis.com
}

step_registry() {
  log "Artifact Registry repository ${REPO} (${REGION})"
  if exists artifacts repositories describe "$REPO" --location="$REGION"; then
    echo "exists: ${AR}"
  else
    rgc artifacts repositories create "$REPO" --repository-format=docker --location="$REGION" \
      --description="billwise container images"
  fi
  # Lets the local Docker push to ${AR_HOST} with your gcloud login (edits ~/.docker/config.json).
  run "$GCLOUD" auth configure-docker "$AR_HOST" --quiet
}

step_images() {
  log "Build (linux/amd64) and push images, tag ${TAG}"
  for svc in billing-api mcp-server; do
    run docker build --platform linux/amd64 -f "${ROOT}/packages/${svc}/Dockerfile" \
      -t "${AR}/${svc}:${TAG}" -t "${AR}/${svc}:latest" "$ROOT"
    run docker push "${AR}/${svc}:${TAG}"
    run docker push "${AR}/${svc}:latest"
  done
  echo "images: ${AR}/{billing-api,mcp-server}:${TAG}"
}

step_sql() {
  log "Cloud SQL ${SQL_INSTANCE}: PostgreSQL 16, ${SQL_TIER}, connector-only access"
  if exists sql instances describe "$SQL_INSTANCE"; then
    echo "exists: ${SQL_CONN}"
  else
    # Public IP but NO authorized networks + connector enforcement: only IAM-authorized Cloud SQL
    # connectors (Cloud Run's built-in socket, the Auth Proxy) can connect. See ADR.
    rgc sql instances create "$SQL_INSTANCE" \
      --database-version=POSTGRES_16 --edition=ENTERPRISE --tier="$SQL_TIER" \
      --region="$REGION" --availability-type=ZONAL \
      --storage-type=HDD --storage-size=10 --no-storage-auto-increase \
      --no-backup --connector-enforcement=REQUIRED --ssl-mode=ENCRYPTED_ONLY \
      --deletion-protection
  fi
  if exists sql databases describe "$DB_NAME" --instance="$SQL_INSTANCE"; then
    echo "exists: database ${DB_NAME}"
  else
    rgc sql databases create "$DB_NAME" --instance="$SQL_INSTANCE"
  fi
}

step_secrets() {
  log "Secret Manager: DATABASE_URL, JWT_PRIVATE_KEY, MCP_API_KEY (generated here, never printed)"
  if exists secrets describe DATABASE_URL; then
    echo "exists: DATABASE_URL (not rotated)"
    # Recreated instance: the DB user is gone but the secret is not → recreate it with the
    # password from the secret.
    if [[ "$DRY_RUN" != 1 ]] && ! exists sql users describe "$DB_USER" --instance="$SQL_INSTANCE"; then
      local pw
      pw="$(gc secrets versions access latest --secret=DATABASE_URL |
        node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>process.stdout.write(decodeURIComponent(new URL(s).password)))")"
      gc sql users create "$DB_USER" --instance="$SQL_INSTANCE" --password="$pw" >/dev/null
      unset pw
      echo "recreated: DB user ${DB_USER} (password from the DATABASE_URL secret)"
    fi
  else
    echo "+ $GCLOUD sql users create ${DB_USER} --instance=${SQL_INSTANCE} --password=<generated>"
    echo "+ <DATABASE_URL with that password> | $GCLOUD secrets create DATABASE_URL --data-file=-"
    if [[ "$DRY_RUN" != 1 ]]; then
      local pw
      pw="$(newsecret 24)"
      if exists sql users describe "$DB_USER" --instance="$SQL_INSTANCE"; then
        gc sql users set-password "$DB_USER" --instance="$SQL_INSTANCE" --password="$pw" >/dev/null
      else
        gc sql users create "$DB_USER" --instance="$SQL_INSTANCE" --password="$pw" >/dev/null
      fi
      printf 'postgresql://%s:%s@localhost/%s?host=/cloudsql/%s' "$DB_USER" "$pw" "$DB_NAME" "$SQL_CONN" |
        gc secrets create DATABASE_URL --replication-policy=automatic --data-file=- >/dev/null
      unset pw
      echo "created: DATABASE_URL"
    fi
  fi
  if exists secrets describe JWT_PRIVATE_KEY; then
    echo "exists: JWT_PRIVATE_KEY (not rotated)"
  else
    echo "+ <new RSA-2048 private key (PEM)> | $GCLOUD secrets create JWT_PRIVATE_KEY --data-file=-"
    if [[ "$DRY_RUN" != 1 ]]; then
      node -e "const {generateKeyPairSync}=require('crypto');process.stdout.write(generateKeyPairSync('rsa',{modulusLength:2048}).privateKey.export({type:'pkcs8',format:'pem'}))" |
        gc secrets create JWT_PRIVATE_KEY --replication-policy=automatic --data-file=- >/dev/null
      echo "created: JWT_PRIVATE_KEY"
    fi
  fi
  if exists secrets describe MCP_API_KEY; then
    echo "exists: MCP_API_KEY (not rotated)"
  else
    echo "+ <random 32-byte key> | $GCLOUD secrets create MCP_API_KEY --data-file=-"
    if [[ "$DRY_RUN" != 1 ]]; then
      newsecret 32 | gc secrets create MCP_API_KEY --replication-policy=automatic --data-file=- >/dev/null
      echo "created: MCP_API_KEY"
    fi
  fi
}

ensure_sa() {
  local name="$1" display="$2"
  if exists iam service-accounts describe "${name}@${PROJECT_ID}.iam.gserviceaccount.com"; then
    echo "exists: ${name}"
  else
    rgc iam service-accounts create "$name" --display-name="$display"
  fi
}

step_iam() {
  log "Service accounts + least-privilege roles"
  ensure_sa billing-api-run "billing-api (Cloud Run)"
  ensure_sa mcp-server-run "mcp-server (Cloud Run)"
  ensure_sa api-gateway "API Gateway backend caller"
  rgc projects add-iam-policy-binding "$PROJECT_ID" --member="serviceAccount:${SA_API}" \
    --role=roles/cloudsql.client --condition=None --format=none
  for s in DATABASE_URL JWT_PRIVATE_KEY; do
    rgc secrets add-iam-policy-binding "$s" --member="serviceAccount:${SA_API}" \
      --role=roles/secretmanager.secretAccessor --format=none
  done
  rgc secrets add-iam-policy-binding MCP_API_KEY --member="serviceAccount:${SA_MCP}" \
    --role=roles/secretmanager.secretAccessor --format=none
  # roles/run.invoker for the gateway is granted on the billing-api SERVICE in step "run".
}

# Starts the Cloud SQL Auth Proxy on localhost:${PROXY_PORT} with your gcloud login (no keys).
start_proxy() {
  if ! command -v "$PROXY_BIN" >/dev/null; then
    echo "cloud-sql-proxy not found: run \`gcloud components install cloud-sql-proxy\` or set PROXY_BIN" >&2
    exit 1
  fi
  echo "+ $PROXY_BIN --gcloud-auth --port ${PROXY_PORT} ${SQL_CONN} &"
  [[ "$DRY_RUN" == 1 ]] && return
  "$PROXY_BIN" --gcloud-auth --port "$PROXY_PORT" "$SQL_CONN" >"${ROOT}/infra/.proxy.log" 2>&1 &
  PROXY_PID=$!
  trap 'kill "$PROXY_PID" 2>/dev/null || true' EXIT
  for _ in $(seq 1 30); do
    (echo >"/dev/tcp/127.0.0.1/${PROXY_PORT}") 2>/dev/null && return
    sleep 1
  done
  echo "Auth Proxy did not start (see infra/.proxy.log)" >&2
  exit 1
}

# DATABASE_URL for the proxy (localhost:${PROXY_PORT}), derived from the secret; never printed.
proxy_database_url() {
  gc secrets versions access latest --secret=DATABASE_URL |
    node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const u=new URL(s);process.stdout.write('postgresql://'+u.username+':'+u.password+'@127.0.0.1:${PROXY_PORT}'+u.pathname)})"
}

step_db_init() {
  log "Migrate + seed Cloud SQL through the Auth Proxy (from this machine)"
  run npm run build -w @billwise/billing-api --prefix "$ROOT"
  start_proxy
  echo "+ DATABASE_URL=<proxy url> npm run db:deploy -w @billwise/billing-api"
  echo "+ DATABASE_URL=<proxy url> node packages/billing-api/dist/db/seed.js --force"
  [[ "$DRY_RUN" == 1 ]] && return
  (
    cd "$ROOT"
    DATABASE_URL="$(proxy_database_url)"
    export DATABASE_URL
    npm run db:deploy -w @billwise/billing-api
    node packages/billing-api/dist/db/seed.js --force
  )
}

# Read-only: row counts per table through the proxy (SELECT only).
step_db_counts() {
  log "Row counts in Cloud SQL (read-only, through the Auth Proxy)"
  start_proxy
  [[ "$DRY_RUN" == 1 ]] && return
  (
    cd "${ROOT}/packages/billing-api"
    DATABASE_URL="$(proxy_database_url)" node -e "
      const { Client } = require('pg');
      const c = new Client({ connectionString: process.env.DATABASE_URL });
      (async () => {
        await c.connect();
        await c.query('SET default_transaction_read_only = on');
        const q = async (sql) => (await c.query(sql)).rows;
        for (const t of ['subscriber', 'usage_event', 'bill', 'payment']) {
          const [r] = await q('SELECT count(*)::int AS n FROM ' + t);
          console.log(t.padEnd(12), r.n);
        }
        const m = await q('SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL ORDER BY started_at');
        console.log('migrations  ', m.map((x) => x.migration_name).join(', '));
        await c.end();
      })().catch((e) => { console.error(e.message); process.exit(1); });"
  )
}

step_run() {
  log "Cloud Run services (min 0 instances)"
  local image_tag="${IMAGE_TAG:-latest}"
  rgc run deploy "$API_SERVICE" --image="${AR}/billing-api:${image_tag}" --region="$REGION" \
    --service-account="$SA_API" --no-allow-unauthenticated \
    --add-cloudsql-instances="$SQL_CONN" \
    --set-secrets=DATABASE_URL=DATABASE_URL:latest,JWT_PRIVATE_KEY=JWT_PRIVATE_KEY:latest \
    --set-env-vars="LOG_FORMAT=json,GOOGLE_CLOUD_PROJECT=${PROJECT_ID},JWT_ISSUER=${JWT_ISSUER},JWT_AUDIENCE=${JWT_AUDIENCE}" \
    --cpu=1 --memory=512Mi --min-instances=0 --max-instances=2 --concurrency=80 --timeout=60 \
    --port=8080
  # Only the gateway may call billing-api (direct calls → 403).
  rgc run services add-iam-policy-binding "$API_SERVICE" --region="$REGION" \
    --member="serviceAccount:${SA_GW}" --role=roles/run.invoker --format=none
  rgc run deploy "$MCP_SERVICE" --image="${AR}/mcp-server:${image_tag}" --region="$REGION" \
    --service-account="$SA_MCP" --allow-unauthenticated \
    --set-secrets=MCP_API_KEY=MCP_API_KEY:latest --set-env-vars=MCP_PORT=8080 \
    --cpu=1 --memory=512Mi --min-instances=0 --max-instances=2 --concurrency=80 --timeout=60 \
    --port=8080
}

render_gateway() { # $1 backend url, $2 gateway host, $3 output file
  sed -e "s|__BACKEND_URL__|$1|g" -e "s|__GATEWAY_HOST__|$2|g" \
    -e "s|__JWT_ISSUER__|${JWT_ISSUER}|g" -e "s|__JWT_AUDIENCE__|${JWT_AUDIENCE}|g" \
    "${ROOT}/infra/gateway/openapi-gateway.tmpl.yaml" >"$3"
}

create_config() { # $1 gateway host → echoes the new config id
  local backend cfg file
  backend="$(service_url "$API_SERVICE")"
  [[ -n "$backend" || "$DRY_RUN" == 1 ]] || { echo "billing-api is not deployed (step run)" >&2; exit 1; }
  cfg="billwise-$(date +%Y%m%d-%H%M%S)"
  file="${ROOT}/infra/gateway/.rendered-${cfg}.yaml"
  render_gateway "${backend:-https://BACKEND}" "$1" "$file"
  rgc api-gateway api-configs create "$cfg" --api="$GATEWAY_API" \
    --openapi-spec="$file" --backend-auth-service-account="$SA_GW" >&2
  echo "$cfg"
}

step_gateway() {
  log "API Gateway ${GATEWAY} (${REGION})"
  if ! exists api-gateway apis describe "$GATEWAY_API"; then
    rgc api-gateway apis create "$GATEWAY_API"
  fi
  local host cfg
  host="$(gateway_host)"
  if [[ -z "$host" ]]; then
    # Pass 1: the host is unknown until the gateway exists → placeholder JWKS host.
    cfg="$(create_config "placeholder.invalid")"
    rgc api-gateway gateways create "$GATEWAY" --api="$GATEWAY_API" --api-config="$cfg" \
      --location="$REGION"
    host="$(gateway_host)"
  fi
  # Pass 2 (and every re-run): JWKS fetched through the gateway itself.
  cfg="$(create_config "${host:-GATEWAY_HOST}")"
  rgc api-gateway gateways update "$GATEWAY" --api="$GATEWAY_API" --api-config="$cfg" \
    --location="$REGION"
  # The gateway's own managed service must be enabled in the project.
  local managed
  managed="$(gc api-gateway apis describe "$GATEWAY_API" --format='value(managedService)' 2>/dev/null || true)"
  [[ -n "$managed" ]] && rgc services enable "$managed"
  echo "gateway: https://${host}"
}

step_env_cloud() {
  log "Write .env.cloud for the agent (gitignored; values not printed)"
  local file="${ROOT}/.env.cloud" host mcp
  host="$(gateway_host)"
  mcp="$(service_url "$MCP_SERVICE")"
  echo "+ write ${file}: BILLING_API_URL, MCP_URL, MCP_API_KEY, DATABASE_URL (proxy)"
  [[ "$DRY_RUN" == 1 ]] && return
  umask 077
  {
    echo "# Generated by infra/deploy.sh env-cloud — never commit."
    echo "BILLING_API_URL=https://${host}"
    echo "MCP_URL=${mcp}/mcp"
    echo "MCP_API_KEY=$(gc secrets versions access latest --secret=MCP_API_KEY)"
    echo "DATABASE_URL=$(proxy_database_url)"
  } >"$file"
  echo "written: .env.cloud"
}

step_verify() {
  log "Verify the security boundary"
  local host direct gw tok code
  host="$(gateway_host)"
  direct="$(service_url "$API_SERVICE")"
  gw="https://${host}"
  code="$(curl -s -o /dev/null -w '%{http_code}' "${direct}/api/v1/health")"
  echo "direct Cloud Run billing-api, no identity token  → ${code} (expect 403)"
  code="$(curl -s -o "${ROOT}/infra/gateway-401-example.json" -w '%{http_code}' -X POST \
    -H 'content-type: application/json' -d '{}' "${gw}/api/v1/payments")"
  echo "gateway POST /api/v1/payments without token     → ${code} (expect 401; body saved to infra/gateway-401-example.json)"
  cat "${ROOT}/infra/gateway-401-example.json"; echo
  tok="$(curl -s -X POST -H 'content-type: application/json' \
    -d "{\"subscriberNo\":\"5551000001\",\"password\":\"${SEED_USER_PASSWORD:-user-demo-pass}\"}" \
    "${gw}/api/v1/auth/login" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{process.stdout.write(JSON.parse(s).accessToken||'')}catch{}})")"
  [[ -n "$tok" ]] || { echo "login through the gateway failed" >&2; exit 1; }
  code="$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer ${tok}" \
    "${gw}/api/v1/bills/5551000001/detailed?month=10&year=2026")"
  echo "gateway GET detailed with token                 → ${code} (expect 200; API read X-Forwarded-Authorization)"
  code="$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer ${tok}x" \
    "${gw}/api/v1/bills/5551000001/detailed?month=10&year=2026")"
  echo "gateway GET detailed with a tampered token      → ${code} (expect 401)"
  for p in /api/v1/docs /api/v1/docs/index.html /api/v1/docs/swagger-ui-bundle.js /api/v1/docs/swagger-ui-init.js /api/v1/openapi.json /.well-known/jwks.json; do
    echo "gateway GET ${p} → $(curl -s -o /dev/null -w '%{http_code}' "${gw}${p}")"
  done
  echo "Cloud Logging (latest billing-api request that came with X-Forwarded-Authorization):"
  gc logging read "resource.type=\"cloud_run_revision\" AND resource.labels.service_name=\"${API_SERVICE}\" AND jsonPayload.auth=\"x-forwarded-authorization\"" \
    --limit=1 --freshness=1h --format='value(timestamp,jsonPayload.message,jsonPayload.auth)'
}

step_status() {
  log "Status (read-only)"
  gc sql instances list --format='table(name,databaseVersion,settings.tier,state,settings.activationPolicy)' || true
  gc run services list --region="$REGION" --format='table(metadata.name,status.url)' || true
  gc api-gateway gateways list --location="$REGION" --format='table(name,state,defaultHostname)' || true
  gc secrets list --format='table(name,createTime)' || true
}

step_urls() {
  echo "gateway:     https://$(gateway_host)"
  echo "mcp-server:  $(service_url "$MCP_SERVICE")/mcp"
  echo "billing-api: $(service_url "$API_SERVICE")  (direct, requires an identity token)"
}

# ---------------- main ----------------
[[ $# -gt 0 ]] || { sed -n '2,13p' "$0"; exit 1; }
if [[ "$1" == all ]]; then
  set -- apis registry images sql secrets iam db-init run gateway env-cloud verify
fi
echo "project ${PROJECT_ID}, region ${REGION}$([[ "$DRY_RUN" == 1 ]] && echo ', DRY RUN')"
for s in "$@"; do
  fn="step_${s//-/_}"
  declare -F "$fn" >/dev/null || { echo "unknown step: $s" >&2; exit 1; }
  "$fn"
done
