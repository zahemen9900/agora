# Per-Page SEO Meta Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add distinct `<title>` and `<meta name="description">` to every page in the Agora web app so each browser tab / search snippet is meaningful rather than defaulting to the landing page's generic copy.

**Architecture:** React 19 natively hoists `<title>` and `<meta>` elements rendered in any component to `<head>` — no library is needed. Each page component gets `<title>` and `<meta name="description">` at the top of its JSX return, wrapped in a Fragment. Dynamic pages (LiveDeliberation, OnChainReceipt, BenchmarkDetail) incorporate the route param into the title. The static `index.html` fallback description is updated to match the landing page's new copy.

**Tech Stack:** React 19.2.4 · Vite 8 · React Router v7 · TypeScript · Node built-in test runner

---

## File Map

| File | Action | Route |
|------|--------|-------|
| `agora-web/src/pages/Login.tsx` | Modify — add meta | `/` |
| `agora-web/src/pages/Login.route.tsx` | Modify — add meta | `/login` |
| `agora-web/src/pages/Callback.tsx` | Modify — add meta | `/callback` |
| `agora-web/src/pages/TaskSubmit.tsx` | Modify — add meta | `/tasks` |
| `agora-web/src/pages/LiveDeliberation.tsx` | Modify — add meta | `/task/:taskId` |
| `agora-web/src/pages/OnChainReceipt.tsx` | Modify — add meta | `/task/:taskId/receipt` |
| `agora-web/src/pages/ApiKeys.tsx` | Modify — add meta | `/api-keys` |
| `agora-web/src/pages/Benchmarks.tsx` | Modify — add meta | `/benchmarks` |
| `agora-web/src/pages/BenchmarksAll.tsx` | Modify — add meta | `/benchmarks/all` |
| `agora-web/src/pages/BenchmarkDetail.tsx` | Modify — add meta | `/benchmarks/:benchmarkId` |
| `agora-web/src/pages/SessionRecovery.tsx` | Modify — add meta | (auth recovery) |
| `agora-web/index.html` | Modify — update fallback | global |

> **Note on testing:** No component rendering test infrastructure exists in this project (no vitest, no jest, no jsdom). Existing tests use Node's built-in `node:test` runner for pure utility functions. Meta tag changes are verified manually in the browser (see Verification section). Each task includes a commit step.

---

### Task 1: Landing Page — `Login.tsx`

**Files:**
- Modify: `agora-web/src/pages/Login.tsx`

Find the `return (` inside `export function LoginPage()` and prepend the meta fragment.

- [ ] **Step 1: Locate the return in `LoginPage`**

The component exports at line 93. Find its `return (` and add the tags as the first children inside the root element (or wrap in a fragment if the root is a plain `<div>`).

- [ ] **Step 2: Add the meta block**

The root element in `LoginPage` is a `<div className="...">`. Because `<title>` and `<meta>` must be siblings (not children of a div), wrap the return in a React Fragment:

```tsx
export function LoginPage() {
  // ... existing hooks ...
  return (
    <>
      <title>Agora — Proof of Deliberation</title>
      <meta
        name="description"
        content="Multi-agent AI deliberation platform. Submit a task, watch agents debate or vote, and receive a cryptographic proof ready for on-chain submission."
      />
      <div className={/* existing root className */}>
        {/* existing JSX untouched */}
      </div>
    </>
  );
}
```

> If the existing return already uses a Fragment (`<>`) as its root, just insert the two tags at the top of the Fragment — no extra wrapping needed.

- [ ] **Step 3: Commit**

```bash
git add agora-web/src/pages/Login.tsx
git commit -m "feat(seo): add per-page meta to landing page"
```

---

### Task 2: Auth / Redirect Pages — `Login.route.tsx` and `Callback.tsx`

**Files:**
- Modify: `agora-web/src/pages/Login.route.tsx`
- Modify: `agora-web/src/pages/Callback.tsx`

Both are transitional pages — a loading state while OAuth completes. Simple static titles are enough.

- [ ] **Step 1: Update `Login.route.tsx`**

`LoginRoute` returns a `<div>` with a spinner/text. Wrap in a Fragment and prepend:

```tsx
export function LoginRoute() {
  const { signIn, isLoading, user } = useAuth();

  useEffect(() => {
    if (!isLoading && !user) {
      signIn();
    }
  }, [signIn, isLoading, user]);

  return (
    <>
      <title>Signing in — Agora</title>
      <meta name="description" content="Redirecting to authentication for Agora." />
      <div style={/* existing style */}>
        {/* existing JSX */}
      </div>
    </>
  );
}
```

- [ ] **Step 2: Update `Callback.tsx`**

`Callback` also renders a loading screen. Same pattern:

```tsx
export function Callback() {
  // ... existing code ...
  return (
    <>
      <title>Completing sign-in — Agora</title>
      <meta name="description" content="Finalising OAuth authentication for your Agora account." />
      {/* existing root element */}
    </>
  );
}
```

- [ ] **Step 3: Commit**

```bash
git add agora-web/src/pages/Login.route.tsx agora-web/src/pages/Callback.tsx
git commit -m "feat(seo): add per-page meta to auth transition pages"
```

---

### Task 3: Task Submission Dashboard — `TaskSubmit.tsx`

**Files:**
- Modify: `agora-web/src/pages/TaskSubmit.tsx`

`TaskSubmit` is the primary authenticated dashboard for submitting new deliberation tasks. It exports at line 121.

- [ ] **Step 1: Add meta fragment to `TaskSubmit` return**

Find the `return (` inside `export function TaskSubmit()` and prepend:

```tsx
export function TaskSubmit() {
  // ... existing hooks/state ...
  return (
    <>
      <title>New Deliberation — Agora</title>
      <meta
        name="description"
        content="Configure and submit a deliberation task. Choose your agents, mechanism, and models, then receive a cryptographic proof of the outcome."
      />
      {/* existing root element */}
    </>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add agora-web/src/pages/TaskSubmit.tsx
git commit -m "feat(seo): add per-page meta to task submission dashboard"
```

---

### Task 4: Live Deliberation Viewer — `LiveDeliberation.tsx`

**Files:**
- Modify: `agora-web/src/pages/LiveDeliberation.tsx`

`LiveDeliberation` exports at line 924 and uses `const { taskId } = useParams();`. The title should include the taskId so tabs for different deliberations are distinguishable.

- [ ] **Step 1: Add dynamic meta fragment**

`taskId` is available at the top of the component. Add to the return:

```tsx
export function LiveDeliberation() {
  const { taskId } = useParams();
  // ... existing state/hooks ...
  return (
    <>
      <title>{taskId ? `Deliberation · ${taskId} — Agora` : "Live Deliberation — Agora"}</title>
      <meta
        name="description"
        content="Live multi-agent deliberation in progress. Track convergence, quorum signals, and the full reasoning transcript as they unfold."
      />
      {/* existing root element */}
    </>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add agora-web/src/pages/LiveDeliberation.tsx
git commit -m "feat(seo): add dynamic per-page meta to live deliberation view"
```

---

### Task 5: On-Chain Receipt — `OnChainReceipt.tsx`

**Files:**
- Modify: `agora-web/src/pages/OnChainReceipt.tsx`

`OnChainReceipt` exports at line 195 and accesses `taskId` via `useParams`. Same dynamic pattern.

- [ ] **Step 1: Locate `useParams` in `OnChainReceipt`**

Check the file for `useParams` usage. If not yet destructuring `taskId`, add it:

```bash
grep -n "useParams\|taskId" agora-web/src/pages/OnChainReceipt.tsx | head -10
```

- [ ] **Step 2: Add dynamic meta fragment**

```tsx
export function OnChainReceipt() {
  const { taskId } = useParams();  // ensure this destructure exists
  // ... existing hooks ...
  return (
    <>
      <title>{taskId ? `Receipt · ${taskId} — Agora` : "On-Chain Receipt — Agora"}</title>
      <meta
        name="description"
        content="On-chain proof of deliberation for this task — Merkle root, transcript hash, and chain submission status."
      />
      {/* existing root element */}
    </>
  );
}
```

- [ ] **Step 3: Commit**

```bash
git add agora-web/src/pages/OnChainReceipt.tsx
git commit -m "feat(seo): add dynamic per-page meta to on-chain receipt page"
```

---

### Task 6: API Keys — `ApiKeys.tsx`

**Files:**
- Modify: `agora-web/src/pages/ApiKeys.tsx`

`ApiKeys` exports at line 176.

- [ ] **Step 1: Add meta fragment to `ApiKeys` return**

```tsx
export function ApiKeys() {
  // ... existing hooks ...
  return (
    <>
      <title>API Keys — Agora</title>
      <meta
        name="description"
        content="Create and manage API keys for programmatic access to Agora's deliberation protocol."
      />
      {/* existing root element */}
    </>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add agora-web/src/pages/ApiKeys.tsx
git commit -m "feat(seo): add per-page meta to API keys page"
```

---

### Task 7: Benchmarks Dashboard — `Benchmarks.tsx`

**Files:**
- Modify: `agora-web/src/pages/Benchmarks.tsx`

`Benchmarks` exports at line 317.

- [ ] **Step 1: Add meta fragment to `Benchmarks` return**

```tsx
export function Benchmarks() {
  // ... existing hooks ...
  return (
    <>
      <title>Benchmarks — Agora</title>
      <meta
        name="description"
        content="Performance dashboard for Agora's deliberation mechanisms — accuracy, latency, and cost across reasoning tasks."
      />
      {/* existing root element */}
    </>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add agora-web/src/pages/Benchmarks.tsx
git commit -m "feat(seo): add per-page meta to benchmarks dashboard"
```

---

### Task 8: All Benchmarks — `BenchmarksAll.tsx`

**Files:**
- Modify: `agora-web/src/pages/BenchmarksAll.tsx`

`BenchmarksAll` exports at line 12.

- [ ] **Step 1: Add meta fragment to `BenchmarksAll` return**

```tsx
export function BenchmarksAll() {
  // ... existing hooks ...
  return (
    <>
      <title>All Benchmarks — Agora</title>
      <meta
        name="description"
        content="Full catalog of Agora benchmark runs. Compare outcomes across tasks, mechanisms, and model configurations."
      />
      {/* existing root element */}
    </>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add agora-web/src/pages/BenchmarksAll.tsx
git commit -m "feat(seo): add per-page meta to all-benchmarks catalog page"
```

---

### Task 9: Benchmark Detail — `BenchmarkDetail.tsx`

**Files:**
- Modify: `agora-web/src/pages/BenchmarkDetail.tsx`

`BenchmarkDetail` exports at line 69 and uses `const { benchmarkId } = useParams<{ benchmarkId: string }>()` at line 71.

- [ ] **Step 1: Add dynamic meta fragment**

`benchmarkId` is already available from `useParams` at line 71. Add the meta block at the top of the return:

```tsx
export function BenchmarkDetail() {
  const navigate = useNavigate();
  const { benchmarkId } = useParams<{ benchmarkId: string }>();
  // ... rest of existing hooks ...
  return (
    <>
      <title>{benchmarkId ? `${benchmarkId} · Benchmark — Agora` : "Benchmark — Agora"}</title>
      <meta
        name="description"
        content="Detailed benchmark results — mechanism breakdown, model performance, accuracy scores, and cost."
      />
      {/* existing root element */}
    </>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add agora-web/src/pages/BenchmarkDetail.tsx
git commit -m "feat(seo): add dynamic per-page meta to benchmark detail page"
```

---

### Task 10: Session Recovery — `SessionRecovery.tsx`

**Files:**
- Modify: `agora-web/src/pages/SessionRecovery.tsx`

`SessionRecoveryPage` exports at line 24 and takes an `issue` prop. Static meta is fine.

- [ ] **Step 1: Add meta fragment**

```tsx
export function SessionRecoveryPage({ issue }: { issue: AuthIssue }) {
  // ... existing hooks ...
  return (
    <>
      <title>Session Recovery — Agora</title>
      <meta name="description" content="Re-authenticate or recover your Agora session to continue." />
      {/* existing root element */}
    </>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add agora-web/src/pages/SessionRecovery.tsx
git commit -m "feat(seo): add per-page meta to session recovery page"
```

---

### Task 11: Update `index.html` Fallback

**Files:**
- Modify: `agora-web/index.html`

The current static fallback description is fine for search-engine indexing of the landing page. Update it to match the landing page's new copy exactly, so there's no discrepancy between the JS-rendered meta and the pre-hydration fallback.

- [ ] **Step 1: Update description in `index.html`**

Change the existing `<meta name="description">` tag from:

```html
<meta name="description" content="Agora - Proof of Deliberation. An on-chain orchestration primitive where AI agents debate, vote, and reach consensus." />
```

To:

```html
<meta name="description" content="Multi-agent AI deliberation platform. Submit a task, watch agents debate or vote, and receive a cryptographic proof ready for on-chain submission." />
```

Leave `<title>Agora — Proof of Deliberation</title>` unchanged — it already matches.

- [ ] **Step 2: Commit**

```bash
git add agora-web/index.html
git commit -m "feat(seo): align index.html fallback description with landing page meta"
```

---

## Verification

Run the dev server and spot-check each route:

```bash
cd agora-web && npm run dev
```

For each page below, navigate to the route, then verify:
1. **Browser tab** shows the correct title
2. **DevTools → Elements → `<head>`** shows the correct `<meta name="description">` content

| Route | Expected tab title |
|-------|--------------------|
| `/` | `Agora — Proof of Deliberation` |
| `/login` | `Signing in — Agora` |
| `/callback` | `Completing sign-in — Agora` |
| `/tasks` | `New Deliberation — Agora` |
| `/task/abc123` | `Deliberation · abc123 — Agora` |
| `/task/abc123/receipt` | `Receipt · abc123 — Agora` |
| `/api-keys` | `API Keys — Agora` |
| `/benchmarks` | `Benchmarks — Agora` |
| `/benchmarks/all` | `All Benchmarks — Agora` |
| `/benchmarks/xyz456` | `xyz456 · Benchmark — Agora` |
| Session recovery (trigger auth error) | `Session Recovery — Agora` |

**Quick DevTools meta check** (run in browser console on any page):

```js
document.querySelector('meta[name="description"]')?.content
```

Should return the page-specific description, not the old landing page copy.
