# Week 2 Frontend Acceptance Report

## Execution Metadata

- Date: 2026-04-14
- Frontend runtime: `VITE_AGORA_API_URL=https://agora-api-rztfxer7ra-uc.a.run.app npm run dev -- --host 0.0.0.0 --port 4173`
- Browser: VS Code integrated browser session
- API trace artifact: `.codex/week2_acceptance_api_trace.json`

## Evidence Summary

- Browser-level checks were run for all five flows.
- Direct API probes were run against:
  - `https://agora-api-rztfxer7ra-uc.a.run.app`
  - `https://agora-api-202872251304.us-central1.run.app`
- Frontend build status: `npm run build` passed.

## Flow Checklist

### 1. Login/Auth gate (demo auth)

- Result: PASS
- Evidence:
  - Landing page showed sign-in controls.
  - Sign-in transitioned to authenticated dashboard with `Demo User` and `Sign Out` visible.
- Notes:
  - Current frontend auth is demo/local-storage auth, not WorkOS.

### 2. Task submit flow

- Result: BLOCKED (external)
- Evidence:
  - UI submit path invoked `POST /tasks/`.
  - Browser showed CORS failure for hosted API from localhost origin.
  - Direct API probe on primary hosted URL returned HTTP 502 with `Failed to initialize task on Solana`.
- Impact:
  - New task creation unavailable from both UI localhost origin and direct primary endpoint task init.

### 3. Live deliberation flow (`/task/:taskId`)

- Result: PARTIAL (route-level pass, data-path blocked)
- Evidence:
  - Route rendered with expected layout sections and loading state.
  - Data fetch to `GET /tasks/{id}?detailed=true` failed in browser due CORS.
- Impact:
  - Real event/replay validation could not be completed from localhost browser origin.

### 4. Receipt and payment flow (`/task/:taskId/receipt`)

- Result: BLOCKED (external)
- Evidence:
  - Receipt page route rendered core UI sections.
  - Browser task fetch blocked by CORS.
  - Direct API probes show no tasks available for `demo-user`, and task creation blocked.
  - Primary endpoint task creation failed at Solana init (HTTP 502), preventing real devnet payment release testing.
- Requested mode alignment:
  - Required mode was real devnet-backed payment validation; not achievable under current hosted API behavior.

### 5. Benchmarks flow (`/benchmarks`)

- Result: PARTIAL (API reachable server-to-server, browser localhost blocked)
- Evidence:
  - Benchmarks page route rendered expected headings/charts shell.
  - Direct API probes returned HTTP 200 for `/benchmarks` on both primary and alternate URLs.
  - Browser fetch from localhost origin failed due CORS.

## API Probe Snapshot

From `.codex/week2_acceptance_api_trace.json`:

- Primary URL:
  - `GET /tasks/` -> 200 (`[]`)
  - `GET /benchmarks` -> 200
  - `POST /tasks/` -> 502 (`Failed to initialize task on Solana`)
- Alternate URL:
  - `GET /tasks/` -> 200 (`[]`)
  - `GET /benchmarks` -> 200
  - `POST /tasks/` with full payload timed out in this environment

## Blocking Issues To Unblock Full Pass

- CORS configuration
  - Hosted API responses need `Access-Control-Allow-Origin` support for the localhost development origin used during manual acceptance.
- Solana task initialization health
  - Primary hosted API currently fails task initialization for create requests with `Failed to initialize task on Solana`.
- Alternate endpoint task creation reliability
  - Alternate endpoint timed out on task creation with full payload.

## Acceptance Verdict

- Full five-flow manual acceptance with real devnet-backed payment is not yet passable due external runtime blockers.
- Route-level UI wiring and frontend build health are confirmed.
- Back-end benchmark endpoint reachability is confirmed via direct API probe.
