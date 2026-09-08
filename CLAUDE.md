# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Signal 40 is an evidence-first finance short-video production system: authorized ingestion → topic radar → claim-level research → editorial approval → script/storyboard → assets/TTS/subtitles → Remotion render → QC → publish → corrections/takedown → metrics. Docs (`docs/DEVELOPMENT_PLAN.md`, `docs/IMPLEMENTATION_STATUS.md`, `docs/OPERATIONS_RUNBOOK.md`), the README, and user-facing strings (including error messages thrown from `lib/`) are in Chinese — keep that convention.

## Commands

Requires Node 22.13+ (native TS via `--experimental-strip-types`), FFmpeg, Docker for real renders.

```bash
docker compose up -d                           # optional local PostgreSQL (host port 55432)
npm run dev -- --host 127.0.0.1 --port 3001   # dev server (vinext, Node runtime)
npm test                                       # node --test test/*.test.ts
node --test --experimental-strip-types test/workflow.test.ts   # single test file
npm run test:evaluation                        # 100-scenario synthetic gate-contract regression
npm run lint                                   # oxlint
npm run format                                 # oxfmt
npm run build                                  # vinext build
npm run test:render                            # render smoke test (needs Chromium/FFmpeg; CI runs it in Docker)
npm run db:generate                            # drizzle-kit: emit SQL migration from db/schema.ts changes
npm run db:migrate                             # apply drizzle/ migrations to $DATABASE_URL
npm run worker                                 # render worker loop (needs SIGNAL40_CONTROL_URL + SIGNAL40_WORKER_TOKEN)
npm run scheduler                              # resident orchestration loop (lib/orchestrator.ts; needs SIGNAL40_AUTOMATION_ACTOR_ID to write anything)
```

Local video pipeline from an exported project: `project:migrate` → `voice:local` → `render` → `qc:media` (see README). `qc:media` exits non-zero when narration/subtitles/music don't cover the timeline — that is a publish blocker by design, never silently shorten target duration.

CI (`.github/workflows/ci.yml`) runs against a PostgreSQL service container (object-storage contract tests run against a real R2 test bucket when the `R2_*` secrets are configured, and skip otherwise): `npm audit --omit=dev`, lint, both test suites, migrations (twice, for idempotency), `drill:restore`, build, render smoke, and Docker builds of both the control plane and the render worker.

## Architecture

Two runtimes sharing `lib/`:

1. **Control plane** — vinext (Next-style App Router on Vite) served by a plain Node process (`vinext start`, `Dockerfile`). PostgreSQL and Cloudflare R2 (via its S3-compatible endpoint) are wired up in `lib/runtime.ts` — the only module that reads `process.env`. REST API under `app/api/v1/` (contract: `contracts/openapi.yaml`); UI pages: `/` topic radar, `/sources`, `/projects/[id]` workbench, `/operations`, `/governance`.
2. **Render worker** (`render-worker/`) — a standalone Node process (Docker image with Chromium/FFmpeg) that polls the control plane's job-lease API (`/api/v1/jobs/lease`) with `x-worker-token`, runs Remotion renders (`video/` compositions via `render-worker/render.ts`), OpenAI TTS, and media QC, then reports back. Job queue is PostgreSQL leases (`SELECT ... FOR UPDATE SKIP LOCKED`) with heartbeat renewal, backoff and DLQ (at-least-once semantics).

Key layers in `lib/` (framework-free, imported by routes, worker, scripts, and tests):

- `workflow.ts` — the core domain: roles, the DRAFT→…→MEASURED content state machine, per-transition role permissions, required gates G0–G8, ETag/If-Match version parsing, and `resolveActor`. Any state/gate/permission change starts here and in `test/workflow.test.ts`.
- `control-plane.ts` — persistence + audit trail for projects/transitions/approvals; every mutation writes an audit statement.
- `sql.ts` / `sql-pg.ts` — backend-agnostic SQL client interface and its PostgreSQL implementation (`?` placeholders are rewritten to `$n`); `storage.ts` / `storage-s3.ts` do the same for object storage; `createS3Client` there holds the R2 quirks (region `auto`, and `WHEN_REQUIRED` checksums because R2 rejects the SDK's default CRC32 headers).
- `project-v2.ts` / `video-project.ts` — project.json schema v2 validation and v1 compat (JSON Schema in `contracts/video-project.schema.json`); deterministic SHA-256 snapshot hashes bind approvals and QC reports to exact content.
- `idempotency.ts` — same key + same payload replays the first result exactly; same key + different payload is rejected.
- `source-adapters.ts` — RSS/Atom, HTTP JSON, CSV ingestion with SSRF guards (URL/redirect/DNS-private-range checks).
- `orchestrator.ts` — the automation tick run by `scripts/scheduler.ts` (and by `POST /api/v1/scheduler/run` as a bounded manual wrapper). It only ever calls the same `transitionContentProject` the UI does: no gate is skipped or relaxed. Bounded per tick, idempotent keys, per-stage circuit breaker, and a `pg_try_advisory_xact_lock` short lock when selecting the project set.
- `automation.ts` — automation policies: stage modes, pre-authorized approvals, guardrails. The research and publish authorizers must be **different** active members, checked when saving a policy and again at every auto-approval — G7's separation of duties is exactly `publishApproval.actor_id !== researchApproval.actor_id`.
- `attention.ts` / `workers.ts` / `diagnostics.ts` — the inbox (with HMAC notification), worker heartbeats and orphaned-job detection, and the `/settings/diagnostics` self-check.
- `topic-quality.ts` — cluster coherence, claim↔evidence distinctness, and language/lexicon match written to `topics.quality_json`. Auto project creation stays off until a topic passes; the metric is the gate, not a fix for the clustering.
- `script-duration.ts` — narration length estimate shown in the script editor (Chinese ≈3.86 chars/s). Advisory only: never let it shorten `render.durationSeconds`.

**No seed or sample data ships in production paths.** The home page and `GET /api/topics` read the database and return an empty list when nothing has been ingested; the old `mode: 'sample'` pipeline was removed. Deterministic article fixtures live in `test/fixtures/sample-articles.ts` and are imported only by tests and `scripts/render-smoke.ts`. Never wire a fixture into `app/` or `lib/` — in an evidence-first system, data that cannot be told apart from real ingestion is worse than no data.

Database: PostgreSQL. Drizzle schema in `db/schema.ts` (36 tables), generated SQL migrations in `drizzle/`, applied by `scripts/migrate-pg.ts` (tracked in `schema_migrations`). Never edit applied migrations; change the schema and run `db:generate`. The schema deliberately declares **no foreign keys** — referential integrity is enforced in application code, and every delete path removes its child rows explicitly.

## Invariants to preserve

- **Auth model**: local requests (localhost) may forge roles via `x-signal-role` headers for development; non-local requests resolve identity only from `oai-authenticated-user-*` headers plus the `team_members` table — client role headers are ignored. Don't weaken this split.
  The header names are configurable (`SIGNAL40_IDENTITY_HEADER_ID` / `SIGNAL40_IDENTITY_HEADER_EMAIL`) and `SIGNAL40_ALLOW_LOCAL_ROLE_HEADERS=false` disables the localhost role-forging path; the UI reads its identity from `GET /api/v1/session` instead of hardcoding roles.
  **Open item after the move off OpenAI Sites**: the authenticating reverse proxy that injects those headers still lives outside this repo. Without it every non-local request resolves to no actor and gets 403. Fail direction is closed, not open.
- **Automation never fakes identity**: mechanical steps run as the service account in `team_members` (`SIGNAL40_AUTOMATION_ACTOR_ID`, must be an active admin — unset means the engine writes nothing); auto-approvals are written under the policy's real member. Every automated write carries `trigger: 'automation'` and `policyId` in audit metadata, and any human edit/approval/incident flips the project to `automation_mode = 'manual'` with a stored reason.
- **Gates are contracts**: transitions fail with typed `WorkflowError`s (`INVALID_TRANSITION`/`FORBIDDEN`/`GATE_FAILED`/`VERSION_CONFLICT`); routes use optimistic concurrency via ETag versions.
- **Fail-safe publishing**: without `SIGNAL40_ALLOW_PUBLIC_PUBLISH=true`, YouTube uploads stay private. Unknown-copyright assets cannot pass G5. Manual imports require explicit rights confirmation.
- **Secrets** (worker token, scheduler token, webhook HMAC, OpenAI, YouTube) live only in env/managed secrets — see `.env.example` for the full set.
- `evaluation/finance-events.ts` is a synthetic regression set, not a real finance gold standard; don't present it as acceptance evidence. `docs/IMPLEMENTATION_STATUS.md` tracks the Implemented-vs-Accepted distinction — external acceptance items (staging, real credentials) are out of scope for this repo without owner authorization.
