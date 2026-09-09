# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Signal 40 is an evidence-first finance short-video production system: authorized source subscription → ingestion → topic radar → claim-level research → editorial approval → script/storyboard → assets/TTS/subtitles → Remotion render → QC → publish → corrections/takedown → metrics. Docs (`docs/`), the README, and user-facing strings (including error messages thrown from `lib/`) are in Chinese — keep that convention.

`docs/IMPLEMENTATION_STATUS.md` is the acceptance ledger and uses a fixed vocabulary: `Implemented locally → Delivered → Deployed → Integrated → Accepted` (`Blocked`/`Experimental` are orthogonal tags). "Implemented locally" means code plus local evidence exists; "Accepted" additionally requires the target environment, real upstream, and a named owner. Never upgrade a status in the docs without that evidence, and never invent "Integrated locally".

## Commands

Requires Node 22.13+ (native TS via `--experimental-strip-types`), FFmpeg, Docker for real renders.

`make help` lists every target (Chinese). The Makefile is the front door; `npm run` works too.

```bash
make setup                    # npm ci + verify/apply migrations
make dev                      # migrate, then dev server on 127.0.0.1:3001 (HOST/PORT override)
make check                    # lint + typecheck + openapi-lint + test + test-evaluation + build
make verify                   # check + test-render + drill-restore + audit (full local release gate)
docker compose up -d          # local PostgreSQL (host port 55432), control plane, workers, scheduler

npm test                                                       # node --test test/*.test.ts (56 files)
node --test --experimental-strip-types test/workflow.test.ts   # single test file
npm run test:evaluation       # 100-scenario synthetic gate-contract regression
npm run test:render           # render smoke test (needs Chromium/FFmpeg; CI runs it in Docker)
npm exec tsc -- --noEmit      # typecheck (not part of `npm run lint`)
npm run lint / format         # oxlint / oxfmt
npm run openapi:lint          # redocly lint contracts/openapi.yaml
npm run openapi:breaking -- --baseline-git-ref <ref>   # reject breaking API changes vs a baseline

npm run db:generate           # drizzle-kit: emit SQL migration from db/schema.ts changes
npm run db:migrations:verify  # immutable-checksum check on already-registered migrations
npm run db:migrate            # apply drizzle/ migrations to $DATABASE_URL
```

Long-running processes (each needs `SIGNAL40_CONTROL_URL` plus its own token):

```bash
npm run worker:source   # leases only 'ingestion' jobs
npm run worker:render   # leases voice/render/publish jobs
npm run worker          # combined; development only — forbidden in production mode
npm run scheduler       # resident orchestration loop (needs SIGNAL40_AUTOMATION_ACTOR_ID to write anything)
```

Operational / diagnostic scripts: `walk` (drive a project through the workflow), `ingest:real`, `check:storage`, `source-slo:report`, `source:chaos`, `source:sensitive-canary`, `social-evidence:evaluate`, `drill:restore`, `image:verify`, `compose:env:verify`.

Local video pipeline from an exported project: `project:migrate` → `voice:local` → `render` → `qc:media` (see README). `qc:media` exits non-zero when narration/subtitles/music don't cover the timeline — that is a publish blocker by design, never silently shorten target duration.

CI (`.github/workflows/ci.yml`) has two jobs. `application` runs against a PostgreSQL service container (object-storage contract tests hit a real R2 test bucket when the `R2_*` secrets are set, and skip otherwise — no local S3 double, because a double's multipart/checksum behavior wouldn't prove anything): audit, lint, OpenAPI lint + breaking-change gate, tests, sensitive-canary scan, evaluation, migration checksum verify, migrate twice (idempotency), `drill:restore`, build, render smoke. `workload-images` builds all three images (control / source-worker / render-worker), then runs image verification (non-root, prod defaults, layer scan), Compose secret-visibility verification, Trivy secret + vuln/misconfig scans, and SBOM generation.

## Architecture

Three runtimes sharing `lib/`:

1. **Control plane** — vinext (Next-style App Router on Vite) served by a plain Node process (`vinext start`, `Dockerfile`). PostgreSQL and Cloudflare R2 (via its S3-compatible endpoint) are wired up in `lib/runtime.ts` — the only `lib/` module that reads `process.env`. REST API under `app/api/v1/` (contract: `contracts/openapi.yaml`); UI pages: `/` topic radar, `/sources`, `/projects/[id]` workbench, `/automation`, `/inbox`, `/operations`, `/governance`, `/settings/diagnostics`.
2. **Source worker** (`source-worker/Dockerfile`, same `render-worker/worker.ts` entrypoint under `SIGNAL40_WORKER_PROFILE=source`) — leases only `ingestion` jobs. It has no database, object-storage, or media credentials.
3. **Render worker** (`render-worker/`) — Docker image with Chromium/FFmpeg; runs Remotion renders (`video/` compositions via `render-worker/render.ts`), OpenAI TTS, media QC, and publish.

Workers poll the control plane's job-lease API (`/api/v1/jobs/lease`) with `x-worker-token`. The queue is PostgreSQL leases (`SELECT ... FOR UPDATE SKIP LOCKED`) with heartbeat renewal, lease epochs, backoff and DLQ (at-least-once). Leases are also gated on declared worker `capabilities` (`source:rss`, `source:http-json`, …) and an integer `capabilityProtocolVersion` per capability — the connector's *protocol* version gates lease authorization; its product version does not.

### Key layers in `lib/` (framework-free; imported by routes, workers, scripts, and tests)

Core workflow:

- `workflow.ts` — the core domain: roles, the DRAFT→…→MEASURED content state machine, per-transition role permissions, required gates G0–G8, ETag/If-Match version parsing, `stableHash`, and `resolveActor`. Any state/gate/permission change starts here and in `test/workflow.test.ts`.
- `control-plane.ts` — persistence + audit trail for projects/transitions/approvals and `leaseNextJob`; every mutation writes an audit statement.
- `project-v2.ts` / `video-project.ts` — project.json schema v2 validation and v1 compat (JSON Schema in `contracts/video-project.schema.json`); deterministic SHA-256 snapshot hashes bind approvals and QC reports to exact content.
- `idempotency.ts` — same key + same payload replays the first result exactly; same key + different payload is rejected. The source modules reimplement this pattern against `audit_events.metadata_json ->> 'idempotencyKey'`.
- `automation.ts` / `orchestrator.ts` — automation policies (stage modes, pre-authorized approvals, guardrails) and the tick run by `scripts/scheduler.ts` (and by `POST /api/v1/scheduler/run` as a bounded manual wrapper). The orchestrator only ever calls the same `transitionContentProject` the UI does: no gate is skipped or relaxed. Bounded per tick, idempotent keys, per-stage circuit breaker, `pg_try_advisory_xact_lock` when selecting the project set.
- `attention.ts` / `workers.ts` / `diagnostics.ts` — the `/inbox` (with HMAC notification), worker heartbeats and orphaned-job detection, and the `/settings/diagnostics` self-check.
- `topic-quality.ts` — cluster coherence, claim↔evidence distinctness, and language/lexicon match written to `topics.quality_json`. Auto project creation stays off until a topic passes; the metric is the gate, not a fix for the clustering.
- `script-duration.ts` — narration length estimate shown in the script editor (Chinese ≈3.86 chars/s). Advisory only: never let it shorten `render.durationSeconds`.

Infrastructure adapters:

- `sql.ts` / `sql-pg.ts` — backend-agnostic SQL client interface and its PostgreSQL implementation (`?` placeholders rewritten to `$n`); `storage.ts` / `storage-s3.ts` do the same for object storage. `createS3Client` holds the R2 quirks (region `auto`, `WHEN_REQUIRED` checksums because R2 rejects the SDK's default CRC32 headers).
- `workload-env.ts` — resolves the worker profile and its token, and in production mode *refuses to start* a combined worker, a shared worker token, or a process whose environment carries variables outside its profile's blast radius. Adding an env var to a worker means updating the forbidden lists here.
- `net-guard.ts` — SSRF guards (URL scheme/redirect/DNS-private-range checks) used by every outbound fetch.

Source subscription and ingestion (the largest subsystem, ~40 `lib/source-*.ts` modules, one test file each):

- `source-lifecycle-status.ts` is the vocabulary hub — lifecycle (`draft/connecting/tested/enabled/degraded/paused/archived`), rights (`pending/approved/revoked/expired`), run status (incl. `rights_blocked`), quarantine, connector release modes, acceptance states. Import these constants; don't restate the strings.
- `source-connectors/registry.ts` — the connector catalog (RSS/Atom, HTTP JSON, public web page, WeChat, Xiaohongshu), each with its adapter, capability, minimum interval, and support matrix. `source-adapters.ts` implements the parsing/mapping.
- `source-rights.ts` — `ingestionRightsBlockReason` is a **pure decider evaluated at the commit boundary**: the caller must lock the run and source in the same transaction and only write articles/origins/checkpoints after it returns `null`. A grant is bound to the source's `config_hash` and version, so editing a source invalidates its authorization.
- `source-authorization.ts` — `SOURCE_ACTION_ROLES` maps every source action to allowed roles. Add new source endpoints here rather than inlining role checks.
- `source-ownership.ts`, `source-quarantine.ts`, `source-legal-deletion.ts`, `source-retention.ts`, `source-raw-payloads.ts` — business-owner assignment, ingestion-run hold/release/discard, legal holds and deletion requests, retention modes and raw-payload custody.
- `source-slo.ts` / `source-slo-exclusions.ts` / `source-schedule-throttle.ts` / `source-budget.ts` — a versioned SLO policy (99% success, 7/28-day windows, minimum sample sizes, burn alerts, `insufficient_data` for low-frequency sources), plus scheduling throttles and per-source cost budgets.
- `source-release-control.ts` — connector rollout as `disabled/shadow/enabled` with canary percent, failure-rate and minimum-run thresholds.
- `source-checkpoint-cutover.ts`, `source-pagination.ts`, `source-page-protocol.ts`, `source-fetch-outcome.ts` — content-fingerprint checkpoints, paged fetch protocol, and `modified/not_modified/unknown` outcomes.
- `source-proposals.ts`, `source-lifecycle.ts` — the propose → approve → connect → test → enable path, and disable/withdraw (which cancels not-yet-started runs and queues a withdrawal pipeline job).
- `opencli-social.ts` / `social-evidence.ts` / `source-relationship-classifier.ts` — social candidate discovery via OpenCLI, and the conservative evidence classifier (`original/repost/quote/syndicated/unknown`). Unknown and low-confidence classifications **fail closed**; the calibration policy in `social-evidence.ts` (false-independent rate, independent recall, minimum production sample) is a frozen, approved gate — `/governance` operates it.

Database: PostgreSQL. Drizzle schema in `db/schema.ts` (55 tables), generated SQL migrations in `drizzle/` (33 files), applied by `scripts/migrate-pg.ts` (tracked in `schema_migrations`, checksum-verified by `lib/migration-integrity.ts`). Never edit applied migrations; change the schema and run `db:generate`. The schema deliberately declares **no foreign keys** — referential integrity is enforced in application code, and every delete path removes its child rows explicitly.

**No seed or sample data ships in production paths.** The home page and `GET /api/topics` read the database and return an empty list when nothing has been ingested. Deterministic article fixtures live in `test/fixtures/sample-articles.ts` and are imported only by tests and `scripts/render-smoke.ts`. Never wire a fixture into `app/` or `lib/` — in an evidence-first system, data that cannot be told apart from real ingestion is worse than no data.

## Invariants to preserve

- **Auth model**: local requests (localhost) may forge roles via `x-signal-role` headers for development; non-local requests resolve identity only from `oai-authenticated-user-*` headers plus the `team_members` table — client role headers are ignored. Don't weaken this split.
  The header names are configurable (`SIGNAL40_IDENTITY_HEADER_ID` / `SIGNAL40_IDENTITY_HEADER_EMAIL`) and `SIGNAL40_ALLOW_LOCAL_ROLE_HEADERS=false` disables the localhost role-forging path; the UI reads its identity from `GET /api/v1/session` instead of hardcoding roles.
  **Open item**: the authenticating reverse proxy that injects those headers still lives outside this repo. Without it every non-local request resolves to no actor and gets 403. Fail direction is closed, not open.
- **Worker blast radius**: production (`SIGNAL40_DEPLOYMENT_MODE=production`) forbids the combined profile and the shared `SIGNAL40_WORKER_TOKEN`; each profile gets its own token and a restricted environment enforced by `lib/workload-env.ts` and re-verified in CI against the built images and Compose files. The source worker must never gain database or object-storage credentials.
- **Automation never fakes identity**: mechanical steps run as the service account in `team_members` (`SIGNAL40_AUTOMATION_ACTOR_ID`, must be an active admin — unset means the engine writes nothing); auto-approvals are written under the policy's real member. Every automated write carries `trigger: 'automation'` and `policyId` in audit metadata, and any human edit/approval/incident flips the project to `automation_mode = 'manual'` with a stored reason.
- **Separation of duties**: the research and publish authorizers must be **different** active members, checked when saving a policy and again at every auto-approval — G7's rule is exactly `publishApproval.actor_id !== researchApproval.actor_id`. Source rights approval is likewise a different-person decision.
- **Gates are contracts**: transitions fail with typed `WorkflowError`s (`INVALID_TRANSITION`/`FORBIDDEN`/`GATE_FAILED`/`VERSION_CONFLICT`); routes use optimistic concurrency via ETag versions. Source mutations use the same `expectedVersion` pattern.
- **The API contract is versioned**: `contracts/openapi.yaml` is linted and diffed against the published baseline in CI. A breaking change must be an intentional, contract-first edit, not a side effect of a route change.
- **Fail-safe publishing**: without `SIGNAL40_ALLOW_PUBLIC_PUBLISH=true`, YouTube uploads stay private. Unknown-copyright assets cannot pass G5. Manual imports require explicit rights confirmation.
- **Ingestion is authorized, not opportunistic**: no fetch without an approved, unexpired, unrevoked rights grant bound to the current source config hash; SSRF/size/field/time limits apply to every adapter; unknown-provenance social evidence does not qualify a claim.
- **Secrets** (worker tokens, scheduler token, webhook HMAC, media signing, OpenAI, YouTube) live only in env/managed secrets — see `.env.example` for the full set. CI scans built images for canary strings and secrets.
- `evaluation/finance-events.ts` is a synthetic regression set, not a real finance gold standard, and does not count as Social Evidence acceptance evidence; don't present it as acceptance. External acceptance items (staging, real credentials, real upstreams) are out of scope for this repo without owner authorization.
