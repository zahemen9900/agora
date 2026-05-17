# UI / UX Concerns — Agora Web

Logged during docs + team page sprint. Roughly ordered by impact.

---

## 1. Three separate header implementations (maintenance risk)

`Login.tsx`, `NavBar.tsx` (dashboard), and `Team.tsx` all maintain their own
nav headers as independent code. Every time a link is added, all three must be
updated manually. This already caused a drift — the mobile Docs-link fix had to
be applied to Login.tsx separately from NavBar.tsx.

**Fix:** Extract a shared `<LandingNav />` component used by both `Login.tsx`
and `Team.tsx`. The dashboard `NavBar.tsx` stays separate (it has auth-specific
controls that don't belong on public pages).

---

## 2. No search in docs

15 pages is manageable by eye. As docs grow, there's no way to search them.
Algolia DocSearch has a free tier for open-source projects and drops in as a
single `<SearchBar />` component.

**Fix:** Add Algolia DocSearch (or a lightweight local lunr.js index) before
the docs section is heavily used in demos.

---

## 3. Light mode broken on Team page

The Team page portrait glow and shadow effects use hardcoded `rgba(0,0,0,0.4)`
shadow values and `rgba(34,211,138,...)` glow colours. In dark mode these look
correct. In the warm cream light mode, the dark shadows look heavy and
out-of-place against the light background.

**Fix:** Replace hardcoded `rgba(0,0,0,0.4)` with `var(--shadow-lg)` and audit
all inline `rgba` values in `Team.tsx` against the light-mode palette.

---

## 4. SSE event types table removed from API Reference

The old API Reference had a structured table of SSE event types
(`mechanism_selected`, `tool_call_started`, `sandbox_execution_started`,
`agent_output_delta`, `receipt_committed`, etc.) with a description column.
The new version replaced it with a raw SSE transcript example, which shows the
shape but not the meaning of each event.

**Fix:** Add a compact reference table back under the streaming section, below
the existing raw example. Keep the example — it's useful — just augment it with
the table.

---

## 5. Docs TOC scrollspy unresponsive on short pages

`DocsLayout.tsx` uses `IntersectionObserver` with
`rootMargin: '0px 0px -60% 0px'`. On short pages (e.g. CrewAI Integration),
the second heading never enters the top 40% of the viewport because the page
isn't tall enough, so the active TOC state never advances.

**Fix:** Reduce the bottom margin to `-20%` or `-30%`. Long pages (SDK
Reference, On-Chain Architecture) still feel correct; short pages become
responsive.

---

## 6. No 404 handling for invalid /docs routes

Unauthenticated users who land on a malformed docs URL (e.g.
`/docs/something-wrong`) get caught by the outer `<Route path="*" element={<RedirectToAuth />} />` and bounced to the landing page — which looks like
a bug rather than a 404.

**Fix:** Add a catch-all inside the `/docs` route tree in `App.tsx`:
```tsx
<Route path="*" element={<DocsNotFound />} />
```
`DocsNotFound` can be a simple page with "Page not found" + a link back to
`/docs`.

---

*Logged: agora docs + team sprint, 2025.*
