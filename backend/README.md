# ELVA Notify Backend

Express microservice for OTP generation/verification, SMS (legacy + DLT), and email notifications.

## Setup

```bash
cd backend
npm install
cp .env.example .env
# Edit .env with your Redis, Fast2SMS, email providers, and APP_CREDENTIALS_JSON values
```

## Scripts

| Script | Description |
|--------|-------------|
| `npm run dev` | Start with file watch (default port from `.env`) |
| `npm start` | Production start |
| `npm test` | Run unit tests |
| `npm run migrate:mongodb` | Import JSON config into MongoDB (idempotent) |
| `npm run migrate:mongodb:dry-run` | Preview migration without writing |
| `npm run migrate:mongodb:verify` | Compare JSON sources vs MongoDB |
| `npm run db:indexes` | Ensure MongoDB indexes |

## Phase 3 — Email provider architecture (complete)

Provider-independent **EMAIL** delivery with config-driven selection, safe failover, transaction tracking, and duplicate protection. **SMS / Fast2SMS is unchanged.** Provider health monitoring (Phase 3I), Phase 4 alerts/reports, and ELVA SMTP are **not** implemented.

```text
POST /notify
  → auth (legacy APP_CREDENTIALS_JSON or Mongo apiCredentials)
  → brand / scope gate (notify:email)
  → notification.service
  → email orchestrator
  → Brevo | Resend | SendGrid (EMAIL_PROVIDER_ORDER)
  → normalized outcome + emailTransactions / messages / deliveryEvents
  → API response (caller never selects provider)
```

### Configuration

| Variable | Description |
|----------|-------------|
| `EMAIL_PROVIDER_ORDER` | Comma-separated order (default `brevo,resend,sendgrid`). Changing order requires **no code changes**. |
| `EMAIL_FAILOVER_ON_TEMPORARY_FAILURE` | Fail over on `TEMPORARY_FAILURE` (default `true`) |
| `EMAIL_PROVIDER_TIMEOUT_MS` | Per-provider timeout (default `15000`). Timeouts → `UNKNOWN` |
| `BREVO_ENABLED`, `BREVO_API_KEY`, `BREVO_FROM_EMAIL`, `BREVO_FROM_NAME` | Brevo |
| `RESEND_ENABLED`, `RESEND_API_KEY`, `RESEND_FROM_EMAIL`, `RESEND_FROM_NAME` | Resend |
| `SENDGRID_ENABLED`, `SENDGRID_API_KEY`, `SENDGRID_FROM_EMAIL` / `EMAIL_FROM` | SendGrid (auto-enabled when key+from exist unless `SENDGRID_ENABLED=false`) |

Provider API keys belong **only** in backend env (never `NEXT_PUBLIC_*` / frontend).

Disabled or incomplete providers are skipped. If none are enabled → controlled `email_providers_not_configured` (HTTP 503).

### Delivery outcomes

| Outcome | Meaning | Failover? |
|---------|---------|-----------|
| `ACCEPTED` | Provider definitely accepted | **No** — stop |
| `REJECTED` | Provider definitely rejected | **Yes** — next eligible |
| `TEMPORARY_FAILURE` | Definite non-accept; may be temporary (e.g. 503, ECONNREFUSED) | **Yes** (policy) |
| `UNKNOWN` | Cannot determine acceptance (e.g. timeout after dispatch) | **No** — stop |

**UNKNOWN does not automatically fail over** because the first provider may already have accepted the message; failing over could create a duplicate. This is intentional. Email is not exactly-once.

### Transactions & duplicate protection

- Each email send gets a stable Notify transaction id: `ntf_YYYYMMDD_<hex>`.
- Provider attempts are recorded (provider, outcome, statusCode, providerMessageId, timestamps).
- MongoDB `emailTransactions` (unique `transactionId`) blocks concurrent / replayed duplicate submissions when Mongo is configured.
- Resend/Brevo receive `Idempotency-Key` = transaction id when supported.

### Persistence vs provider success

If the provider returns **ACCEPTED** but Mongo persistence fails afterward, the API still treats delivery as **success**. Persistence errors are logged separately (`message_persist_after_accept_failed`) and must not be reported as provider failure.

### Credential compatibility

- **Legacy** `APP_CREDENTIALS_JSON` clients: unchanged auth + `POST /notify` email payload; default scopes include `notify:email`.
- **New Mongo apps**: hashed credentials, application/credential status, brand binding, `notify:email` scope — email still goes through the same orchestrator.

### Explicitly out of Phase 3

- SMS abstraction / failover / health
- Provider health monitor / circuit breaker (Phase 3I)
- Phase 4 alerts / daily reports
- ELVA own SMTP

## Phase 4 — Ops failure alerts (Prompt 1)

Observer-only alerts when a notification reaches a **genuine final failure**. Does **not** change SMS or email delivery/failover.

| Variable | Description |
|----------|-------------|
| `NOTIFY_FAILURE_ALERT_ENABLED` | Enable/disable (default `true`) |
| `NOTIFY_FAILURE_ALERT_EMAIL` | Ops recipient (default from env config) |

- **EMAIL:** alert only when final outcome is `FAILED` (after failover exhausted). No alert on intermediate attempts, successful failover, or `UNKNOWN`.
- **SMS:** alert on final failed delivery only; SMS send path unchanged.
- Alerts go through the existing email orchestrator.
- If the alert email itself fails: log only — **no recursive alert**.
- Deduped via MongoDB `notificationAlerts.dedupeKey` (unique).

## Phase 4 — Daily transaction report (Prompt 2)

Observer/aggregation email summarizing the **previous calendar day** (not part of the delivery path).

| Variable | Description |
|----------|-------------|
| `NOTIFY_DAILY_REPORT_ENABLED` | Enable scheduler (default `true`) |
| `NOTIFY_REPORT_TIMEZONE` | IANA timezone (default `Asia/Kolkata`) |
| `NOTIFY_DAILY_REPORT_HOUR` / `NOTIFY_DAILY_REPORT_MINUTE` | Local send time (default `08:00`) |
| `NOTIFY_FAILURE_ALERT_EMAIL` | Report recipient (same as failure alerts) |

Counting: **one row in `emailTransactions` = one EMAIL transaction** (provider attempts are not transactions). Ops/report/alert mail (`ELVA_OPS`, `ops_*` templates, `opsreport_` / `opsalert_` ids) is excluded. SMS metrics come from `messages` (`channel=SMS`) using existing statuses only.

Multi-instance safety: unique index on `dailyReports (reportDate, reportType, timezone)`.

## Phase 4 — Ops monitoring (Prompt 3)

Authenticated Ops APIs (all require `requireOpsAdmin` / `X-Ops-Admin-Token`):

| Endpoint | Purpose |
|----------|---------|
| `GET /ops/notify/summary` | Bounded period totals (today / yesterday / custom ≤ 31 days) |
| `GET /ops/notify/failures` | Recent failures (masked recipients, limited) |
| `GET /ops/notify/alerts` | Operational DELIVERY_FAILURE alerts |
| `GET /ops/notify/reports/daily` | Persisted daily report rows (no regenerate) |

Frontend: `/platform/notify` (ApprovalsGate + same sessionStorage ops token as Live Logs). Polls every 15s; stops on 401/403; pauses when the tab is hidden.

## Phase 2 — Application approval + secure API access

Phase 2 adds application-specific MongoDB credentials for **new** approved applications while keeping existing `APP_CREDENTIALS_JSON` clients unchanged.

### Dual credential worlds

| Path | Who | Auth source |
|------|-----|-------------|
| Legacy | Existing apps (`ELVA_NOTIFY`, etc.) | `APP_CREDENTIALS_JSON` |
| Phase 2 | Newly approved applications | MongoDB `apiCredentials` (hashed secrets) |

`CREDENTIAL_SOURCE=hybrid` (Phase 2 default):

1. If a **Phase 2** Mongo credential exists for `appId` → Mongo is authoritative (no env fallback).
2. Otherwise → legacy `APP_CREDENTIALS_JSON`.

Phase 1 migration mirrors (`legacyEnvCredential: true`) are **not** used for auth — they remain archival.

### Approval flow

```text
Access request → OPS approve → Mongo transaction:
  application + credential + request approved + audit
→ one-time apiKey (portal + SendGrid email)
```

Requires MongoDB transactions (Atlas / replica set). Failed transactions do **not** silently retry.

### Ops credential lifecycle

| Endpoint | Purpose |
|----------|---------|
| `POST /ops/credentials/:credentialId/suspend` | Temporarily block |
| `POST /ops/credentials/:credentialId/revoke` | Permanently revoke |
| `POST /ops/applications/:applicationId/status` | Set application status |

All require `OPS_ADMIN_TOKEN`. Credentials never auto-expire.

### Local flags

```env
BRAND_SOURCE=json
CREDENTIAL_SOURCE=hybrid
API_SECRET_PEPPER=your-pepper
```

## Phase 1 — MongoDB foundation (zero impact)

Phase 1 introduces MongoDB as a **persistent foundation** without changing existing client behavior.

### Guarantees

- Existing `APP_CREDENTIALS_JSON` credentials remain valid and unchanged
- Existing `appId` / `apiKey` / `brandId` / `templateKey` values are not modified
- Runtime auth uses `CREDENTIAL_SOURCE=env` (default)
- Runtime brands use `BRAND_SOURCE=json` (default)
- JSON config files are never deleted or rewritten by migration
- MongoDB downtime does **not** break `/notify` or OTP APIs when Phase 1 defaults are used

### Local setup

1. Run MongoDB locally (or use MongoDB Atlas).
2. Set in `backend/.env`:

```env
MONGODB_URI=mongodb://127.0.0.1:27017
MONGODB_DATABASE=elva_notify
BRAND_SOURCE=json
CREDENTIAL_SOURCE=env
API_SECRET_PEPPER=your-local-pepper
RECIPIENT_HASH_PEPPER=your-local-pepper
```

3. Preview then import existing JSON configuration:

```bash
npm run migrate:mongodb:dry-run
npm run migrate:mongodb
npm run migrate:mongodb:verify
```

4. Start the backend — indexes are ensured on startup when MongoDB is configured.
   If MongoDB is unavailable and `MONGODB_REQUIRED` is not `true`, the service still starts.

### Migration flags

| Variable | Values | Phase 1 default | Notes |
|----------|--------|-----------------|-------|
| `BRAND_SOURCE` | `json`, `mongodb`, `hybrid` | `json` | Keep `json` until Phase 2 cutover |
| `CREDENTIAL_SOURCE` | `env`, `mongodb`, `hybrid` | `env` | Keep `env` until Phase 2 cutover |

Do **not** enable `hybrid`/`mongodb` credential or brand sources in production until Phase 2 is intentionally started.

### What Phase 1 does NOT do

- No application-specific credential provisioning on approval
- No MongoDB-mandatory authentication
- No credential revocation/expiry of existing keys
- No provider routing / failover
- No change to Fast2SMS or SendGrid delivery

## Environment

Copy `backend/.env.example` to `backend/.env`. Do not use a shared root `.env`.

| Variable | Description |
|----------|-------------|
| `PORT` | HTTP port (use `4000` for local dev alongside frontend on `3000`) |
| `REDIS_*` | Redis connection |
| `FAST2SMS_*` | SMS provider (unchanged in Phase 3) |
| `EMAIL_PROVIDER_ORDER` | Email provider selection order |
| `BREVO_*` / `RESEND_*` / `SENDGRID_*` / `EMAIL_FROM` | Email providers (Phase 3) |
| `APP_CREDENTIALS_JSON` | `appId` → `apiKey` map (legacy; still used in hybrid) |
| `MONGODB_URI` | MongoDB connection string |
| `MONGODB_DATABASE` | Database name (default `elva_notify`) |
| `BRAND_SOURCE` | Brand registry read source (default `json`) |
| `CREDENTIAL_SOURCE` | API credential validation source (default `env`) |
| `API_SECRET_PEPPER` | Pepper for API secret hashing (migration / Phase 2) |
| `RECIPIENT_HASH_PEPPER` | Pepper for recipient audit hashes |

## API

| Endpoint | Auth |
|----------|------|
| `GET /health` | No (includes optional MongoDB reachability flags) |
| `POST /otp/send`, `/otp/resend`, `/otp/verify` | Yes |
| `POST /notify` | Yes |

See [root README](../README.md) for API details and [docs/](../docs/) for full documentation.

## OpenAPI specification

Machine-readable API contract (OpenAPI 3.1):

```text
backend/openapi/
├── openapi.yaml
└── components/
    ├── schemas.yaml
    ├── errors.yaml
    └── security.yaml
```

Validate from repository root:

```bash
npm run openapi:validate
```

Browse the interactive reference in the documentation portal at `/api-reference` (frontend-only; no Swagger route on the backend).

## From repository root

```bash
npm run backend:dev
npm run backend:start
```
