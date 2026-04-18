# Agora Web

Frontend for the Agora multi-agent deliberation platform. Users submit questions or decisions, Agora routes them to a panel of AI agents that deliberate via **debate** or **vote**, and the outcome is committed to Solana with a verifiable Merkle receipt.

**Stack:** React 19 · TypeScript · Vite · React Router · WorkOS AuthKit · Recharts · Framer Motion · Tailwind CSS

---

## Pages

| Route | Description |
| --- | --- |
| `/` | Task submission dashboard (authenticated) or auth landing (unauthenticated) |
| `/task/:taskId` | Live deliberation — streams agent arguments in real time with a convergence meter |
| `/task/:taskId/receipt` | On-chain receipt — Merkle root, transcript hashes, Solana tx link, payment release |
| `/api-keys` | Create, copy, and revoke API keys for programmatic access |
| `/benchmarks` | Accuracy × mechanism charts, selector learning curve, cost efficiency (human sessions only) |
| `/auth`, `/login` | WorkOS AuthKit login flow |
| `/callback` | OAuth redirect handler |

## Key features

- **Auto-routing** — The backend selector analyzes each task and picks `DEBATE` or `VOTE` with a confidence score; the UI reveals the routing decision before navigating to the live view.
- **Streaming deliberation** — Agent messages stream in via SSE with typewriter rendering and a live entropy/convergence meter.
- **Verifiable receipts** — Each completed task has a Merkle root over its transcript hashes. The receipt page lets users verify the root client-side and release escrowed SOL payments.
- **API key management** — Workspace-scoped keys for programmatic task submission; API key principals do not see benchmark navigation.
- **Benchmarks** — Bar and line charts (Recharts) comparing debate vs. vote vs. selector accuracy across task categories, plus token cost and selector learning-curve data.

---

## Development

```bash
npm install
npm run dev        # http://localhost:5173
npm run build
npm run preview
```

### Environment variables

| Variable | Default | Description |
| --- | --- | --- |
| `VITE_AGORA_API_URL` | `/api` | Override the API base URL in any environment |
| `VITE_AGORA_BACKEND_SOURCE` | `local` | Backend source selector for dev proxy: `local` or `gcloud` |
| `VITE_AGORA_LOCAL_API_URL` | `http://localhost:8000` | Local backend URL used when source is `local` |
| `VITE_AGORA_GCLOUD_API_URL` | `https://agora-api-rztfxer7ra-uc.a.run.app` | Hosted backend URL used when source is `gcloud` |
| `VITE_AGORA_API_PROXY_TARGET` | unset | Optional hard override for `/api/*`; takes precedence over source selector |

In development, Vite proxies `/api/*` based on `VITE_AGORA_BACKEND_SOURCE`.

Use hosted backend:

```bash
VITE_AGORA_BACKEND_SOURCE=gcloud npm run dev
```

Use local backend:

```bash
VITE_AGORA_BACKEND_SOURCE=local npm run dev
```

You can still force a specific proxy target when needed:

```bash
VITE_AGORA_API_PROXY_TARGET=https://agora-api-rztfxer7ra-uc.a.run.app npm run dev
```

If you see `502` errors for `/auth/me`, the proxied backend is unreachable — check the variable above.

### WorkOS AuthKit setup (local)

Add the following in your WorkOS dashboard:

- **Redirect URI:** `http://localhost:5173/callback`
- **Sign-in endpoint:** `http://localhost:5173/login`
- **Allowed origin:** `http://localhost:5173`

---

## Production (Vercel)

`vercel.json` rewrites `/api/*` to the hosted Cloud Run endpoint so all browser requests stay same-origin and avoid CORS preflight. No extra config needed beyond setting the WorkOS env vars in the Vercel project settings.
