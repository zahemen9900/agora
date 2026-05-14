# Agora AI 9900 Architecture Plan

## Purpose

This document defines the target production architecture for migrating Agora to the new Google Cloud project `agora-ai-9900`.

The goals are:
- remove direct public exposure of raw Cloud Run origins
- provide a standard public API surface for both the dashboard and the SDK
- reduce abuse and hijack risk
- isolate internal services from internet traffic
- adopt reproducible, auditable, least-privilege deployment practices

---

## Executive Summary

The new project should expose Agora through a controlled public API edge on a custom domain, while keeping backend Cloud Run services non-public and reachable only through approved infrastructure paths.

### Recommended public surfaces
- Dashboard frontend: `app.agora...`
- Public API for dashboard + SDK: `api.agora...`

### Recommended private surfaces
- Internal orchestration/worker services
- sandbox runner service
- Redis, storage, secret access paths
- any background recovery/job-only endpoints

### Core rule
Do **not** expose the default `run.app` service URL as the production API surface for either the app dashboard or the SDK.

Instead:
1. expose a managed public API edge on `api.agora...`
2. place Cloud Run behind the edge
3. restrict direct Cloud Run origin access as much as possible
4. enforce auth, rate limits, logging, and abuse controls at the edge and app layers

---

## Problems With the Old Shape

The previous deployment shape had several risk factors:
- direct public Cloud Run exposure via `--allow-unauthenticated`
- direct public Cloud Run exposure via `--no-invoker-iam-check`
- frontend rewrites targeting the raw `run.app` backend URL
- public backend origin documented broadly in repo/docs
- privileged backend behaviors controlled by static bearer-style admin tokens
- high-value secrets present across multiple platforms without a consolidated rotation/ops model

This created a setup where:
- the dashboard could reach the backend
- the SDK could reach the backend
- attackers and scanners could also directly reach the same origin
- there was no strong edge boundary separating legitimate API consumers from arbitrary internet traffic

---

## Target Architecture

## 1. Public entrypoints

### `app.agora...`
Purpose:
- browser dashboard
- static frontend hosting
- user login flow
- dashboard UI only

Recommended platform:
- Vercel or Cloud Run static/frontend host

Constraints:
- should not directly expose backend origins to the browser except through `api.agora...`
- no provider secrets or internal admin secrets in browser env
- use backend-driven auth bootstrap only for frontend-safe values

### `api.agora...`
Purpose:
- single public API endpoint for:
  - browser dashboard requests
  - SDK requests
  - server-to-server customers using Agora API keys

Recommended platform:
- HTTPS Load Balancer or API Gateway in front of backend services
- custom managed TLS cert
- Cloud Armor enabled

Controls at this layer:
- request logging
- IP and geo policy if needed
- WAF / managed protection
- rate limiting
- header normalization
- optional request size limits
- bot / abuse filtering where supported

This is the only internet-facing API origin that third parties should know about.

---

## 2. Backend services

## 2.1 API service
Purpose:
- authenticated public application/API surface
- tasks, sources, auth session bootstrap, API keys, benchmark user flows

Recommended platform:
- Cloud Run service `agora-api`

Requirements:
- not treated as the public origin
- no product docs or frontend config should advertise raw `run.app`
- ingress should be restricted to the selected edge path as tightly as GCP allows for the chosen networking model
- app-level auth remains mandatory for protected routes
- health endpoint can remain minimal/public if required, but should reveal minimal metadata

### Auth model
Support these callers:
- dashboard users via WorkOS JWTs
- SDK/programmatic callers via first-party Agora API keys
- internal service callers via service identity, not shared static tokens

Do not use:
- static global admin bearer tokens for user-visible control paths
- demo auth in production

## 2.2 Internal worker service(s)
Purpose:
- long-running orchestration helpers
- expensive model/provider work
- recovery or async operations if split from API service

Recommended platform:
- separate Cloud Run service(s) with internal-only invocation

Requirements:
- not internet-facing
- callable only by approved service accounts
- no browser or SDK traffic

## 2.3 Sandbox runner
Purpose:
- controlled code execution for tooling/sandbox tasks

Recommended platform:
- separate Cloud Run service or isolated compute target

Requirements:
- private/internal only
- no public ingress
- callable only from the main API/worker service account
- no static shared bearer token as the primary trust boundary if service-to-service IAM is possible
- strict runtime isolation, timeout, CPU/memory, egress, filesystem, and artifact controls

This service should be treated as especially sensitive.

---

## 3. Networking and exposure model

## Preferred model
1. Client calls `api.agora...`
2. Edge layer receives request
3. Edge forwards to backend service
4. Backend validates JWT/API key and performs business logic
5. Internal backend-to-backend calls use service identity only

## Exposure rules
- `app.agora...`: public
- `api.agora...`: public
- raw `*.run.app`: not published, not documented, not used as canonical API URL
- worker services: private/internal
- sandbox services: private/internal
- Redis: private only
- GCS: private only
- Secret Manager: private only

If a service must be reachable from the internet, it should be reachable through the custom domain boundary, not directly through the default Cloud Run origin.

---

## 4. Dashboard request path

Browser flow:
1. user signs in through WorkOS
2. browser app at `app.agora...` receives frontend-safe auth config
3. browser calls `https://api.agora...`
4. API validates WorkOS JWT via JWKS
5. API serves user-scoped resources

Requirements:
- CORS should allow only approved app origins
- no direct browser calls to internal services
- no browser knowledge of internal service URLs
- no privileged admin-token bypasses on user routes

Recommended frontend rule:
- all `/api/*` traffic should point to `api.agora...`, never to raw Cloud Run

---

## 5. SDK request path

SDK flow:
1. SDK targets `https://api.agora...`
2. SDK sends Agora API key or approved bearer credential
3. edge forwards request to `agora-api`
4. API validates auth and applies quotas/rate limits
5. API performs orchestration or dispatches to internal services

Requirements:
- SDK should have configurable `base_url`
- default production `base_url` should be the custom API domain
- SDK should not default to raw `run.app`
- SDK docs should reference only the custom API domain

Important principle:
The SDK still uses a public API, but that public API should be the managed edge domain, not the Cloud Run origin.

---

## 6. Auth and authorization design

## Dashboard auth
- WorkOS-issued JWTs
- signature verification via JWKS
- strict issuer/audience validation
- no demo mode in production

## Programmatic auth
- Agora first-party API keys
- hashed-at-rest secret component
- scoped permissions
- workspace-scoped ownership
- rotation and revocation support
- usage tracking and last-used timestamps

## Internal service auth
- GCP service account identity
- IAM-based service-to-service authorization where possible
- no long-lived shared admin headers for internal trust

## Remove or avoid
- benchmark or ops access via global static header secret
- auth fallback that silently converts bad tokens into usable principals
- any production path dependent on `AUTH_REQUIRED=false`

---

## 7. Secrets management

Use Google Secret Manager as the source of truth for runtime secrets.

### Secret classes
- WorkOS secrets
- provider keys: Gemini, Anthropic, OpenRouter, Helius
- Redis URL/auth
- webhook secret
- API key pepper
- any internal service auth material

### Rules
- secrets injected at runtime, never committed
- access granted at the secret level, not broad project-wide if avoidable
- separate secrets by environment where appropriate
- rotate on incident, then on a regular schedule
- avoid duplicating the same secret in multiple platforms unless required

### Special rule for frontend hosts
- Vercel/frontend env should contain only browser-safe values
- server-side frontend secrets should be minimized and documented
- anything sensitive should remain in GCP when possible

---

## 8. IAM model

## Service accounts
Create dedicated service accounts at minimum for:
- API runtime
- internal worker runtime
- sandbox runner runtime
- CI deployer via Workload Identity Federation
- optional scheduled jobs/recovery jobs

## IAM principles
- no default compute service account for runtime
- no `roles/editor`
- no user-managed service-account JSON keys unless absolutely unavoidable
- least-privilege Secret Manager access
- least-privilege GCS access
- least-privilege Cloud Run invocation rights between services

## CI/CD auth
Use:
- GitHub Actions OIDC / Workload Identity Federation

Do not use:
- checked-in GCP service account keys
- manually copied JSON credentials in CI

---

## 9. CI/CD and deployment model

## Build/deploy flow
1. push to main or approved release branch
2. GitHub Actions authenticates to GCP through OIDC
3. build image via Cloud Build
4. push to Artifact Registry
5. deploy to Cloud Run with dedicated runtime service account
6. verify health and auth behavior through approved checks

## Required deployment rules
- no production deploy command should include `--allow-unauthenticated`
- no production deploy command should include `--no-invoker-iam-check` unless there is a documented exception and compensating controls
- docs/runbooks must match real secure deploy behavior
- rollout should support quick rollback

## Environment separation
Maintain at least:
- dev
- staging
- prod

Do not reuse the exact same secrets or service accounts across all environments.

---

## 10. Abuse protection and rate limiting

## Edge protections
- Cloud Armor or equivalent WAF
- per-IP and per-path protections where feasible
- request size limits
- suspicious traffic logging

## App protections
- per-workspace rate limits
- per-route rate limits for expensive paths
- concurrency caps
- request validation before expensive work
- bounded task execution and bounded streaming ticket TTLs

## Recommended additional protections
- quotas per API key tier
- stronger protections on benchmark, tool, upload, and execution routes
- anomaly detection on spikes in model/provider usage

---

## 11. Logging, monitoring, and incident readiness

## Required telemetry
- request logs at edge and app
- auth failure metrics
- rate-limit trigger metrics
- provider usage/cost metrics
- Cloud Run revision/deploy history
- Secret Manager access audit logs
- IAM policy change audit logs

## Alerts
Create alerts for:
- sudden request spikes
- provider cost spikes
- repeated auth failures
- repeated sandbox execution attempts
- secret access anomalies
- new IAM bindings or service-account key creation

## Incident runbook requirements
Document:
- secret rotation order
- traffic cutoff steps
- service rollback steps
- access review steps
- evidence capture checklist

---

## 12. Migration plan for `agora-ai-9900`

## Phase 1: project bootstrap
- create project `agora-ai-9900`
- enable required APIs
- create dedicated service accounts
- configure Artifact Registry
- configure Secret Manager
- configure Cloud Logging/Monitoring
- configure Workload Identity Federation for GitHub Actions

## Phase 2: secure backend foundation
- deploy `agora-api` with dedicated runtime SA
- remove public Cloud Run origin assumptions from deploy configs
- deploy internal services separately
- keep sandbox private/internal
- connect Redis/GCS via least privilege

## Phase 3: public edge
- provision `api.agora...`
- provision TLS certs
- place edge in front of `agora-api`
- enable WAF/rate limits/logging
- update app dashboard to call `api.agora...`
- update SDK defaults/docs to call `api.agora...`

## Phase 4: auth and secret hardening
- rotate all existing secrets before cutover
- create new project-scoped secrets in `agora-ai-9900`
- validate JWT/API-key flows
- remove old admin-token bypass patterns
- ensure production disables demo auth

## Phase 5: cutover
- move dashboard traffic
- move SDK canonical API URL
- monitor logs closely
- keep rollback path for previous environment only as long as strictly necessary
- decommission old public exposures after verification

## Phase 6: post-cutover hardening
- audit IAM
- confirm no user-managed SA keys
- confirm no raw `run.app` URLs remain in docs/config/sdk defaults
- confirm alerts fire correctly
- run a security review and tabletop incident drill

---

## 13. Concrete repo implications

These repo-level changes should follow this architecture plan:
- deployment workflows should stop publishing raw public Cloud Run service patterns
- frontend rewrites/config should target `api.agora...`
- SDK canonical hosted URL should become `https://api.agora...`
- docs should remove raw `run.app` as the canonical endpoint
- internal service auth should move toward IAM-based trust where possible
- benchmark/admin control paths should require real authenticated principals

---

## 14. Non-negotiable standards going forward

1. No raw Cloud Run URL as the canonical public API.
2. No production deploys with public unauthenticated origin unless explicitly approved and fronted by compensating controls.
3. No static global admin token for user-facing privileged routes.
4. No demo auth behavior in production.
5. No plaintext secrets in repo, browser env, or CI logs.
6. No default compute SA runtime.
7. No user-managed SA keys unless formally approved and tracked.
8. All public traffic goes through the managed API edge.
9. SDK defaults only to the managed custom API domain.
10. Incident rotation and audit procedures must be tested, not just documented.

---

## Recommendation

Adopt this target shape for `agora-ai-9900`:
- `app.agora...` for the dashboard
- `api.agora...` for all browser + SDK API traffic
- Cloud Run backend services behind the public API edge
- internal workers and sandbox private only
- Secret Manager + dedicated service accounts + OIDC deploys
- WAF/rate limiting/logging at the edge and app layers

This gives Agora a normal, supportable production architecture for both the dashboard and the SDK without repeating the raw public-origin exposure problem.
