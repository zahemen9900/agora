# React + TypeScript + Vite

This template provides a minimal setup to get React working in Vite with HMR and some ESLint rules.

Currently, two official plugins are available:

- [@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react) uses [Oxc](https://oxc.rs)
- [@vitejs/plugin-react-swc](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react-swc) uses [SWC](https://swc.rs/)

## React Compiler

The React Compiler is not enabled on this template because of its impact on dev & build performances. To add it, see [this documentation](https://react.dev/learn/react-compiler/installation).

## Expanding the ESLint configuration

If you are developing a production application, we recommend updating the configuration to enable type-aware lint rules:

```js
export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      // Other configs...

      // Remove tseslint.configs.recommended and replace with this
      tseslint.configs.recommendedTypeChecked,
      // Alternatively, use this for stricter rules
      tseslint.configs.strictTypeChecked,
      // Optionally, add this for stylistic rules
      tseslint.configs.stylisticTypeChecked,

      // Other configs...
    ],
    languageOptions: {
      parserOptions: {
        project: ['./tsconfig.node.json', './tsconfig.app.json'],
        tsconfigRootDir: import.meta.dirname,
      },
      // other options...
    },
  },
])
```

You can also install [eslint-plugin-react-x](https://github.com/Rel1cx/eslint-react/tree/main/packages/plugins/eslint-plugin-react-x) and [eslint-plugin-react-dom](https://github.com/Rel1cx/eslint-react/tree/main/packages/plugins/eslint-plugin-react-dom) for React-specific lint rules:

```js
// eslint.config.js
import reactX from 'eslint-plugin-react-x'
import reactDom from 'eslint-plugin-react-dom'

export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      // Other configs...
      // Enable lint rules for React
      reactX.configs['recommended-typescript'],
      // Enable lint rules for React DOM
      reactDom.configs.recommended,
    ],
    languageOptions: {
      parserOptions: {
        project: ['./tsconfig.node.json', './tsconfig.app.json'],
        tsconfigRootDir: import.meta.dirname,
      },
      // other options...
    },
  },
])
```

## API Base URL and Vercel Proxy

- Development default API URL: `http://localhost:8000`
- Production default API URL: `/api`
- Override in any environment with `VITE_AGORA_API_URL`

## WorkOS AuthKit Setup

- Set `VITE_WORKOS_CLIENT_ID` in your frontend env file (for example `.env.local`).
- Set `VITE_WORKOS_REDIRECT_URI` to the dashboard callback URL.
- Use `/auth` as the user-facing auth page, `/login` as the WorkOS sign-in endpoint, and `/callback` as the AuthKit redirect target.
- In local development, keep `VITE_WORKOS_USE_DEV_PROXY=true` so Vite proxies `/user_management/*` to WorkOS and avoids browser CORS failures during code exchange.
- After AuthKit resolves a user, the dashboard bootstraps itself with `GET /auth/me`.
- Protected routes render only after `/auth/me` succeeds; if it returns `401`, the app signs the user out and redirects back to `/auth`.
- API requests fetch access tokens on-demand through `getAccessToken()` before sending `Authorization: Bearer <token>` to the backend.
- API key management now lives at `/api-keys`.
- Benchmarks are intentionally hidden from normal navigation until backend RBAC exists.

WorkOS dashboard checklist for local auth:

- Add `http://localhost:5173/callback` to Redirect URIs.
- Add `http://localhost:5173/login` as the Sign-in endpoint.
- Add `http://localhost:5173` to Allowed Origins.

When deploying on Vercel, `vercel.json` rewrites `/api/*` to the hosted Cloud Run API endpoint so browser calls remain same-origin and avoid CORS preflight failures.
