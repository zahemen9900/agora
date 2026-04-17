# React + TypeScript + Vite

This template provides a minimal setup to get React working in Vite with HMR and some ESLint rules.

Currently, two official plugins are available:

- [@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react) uses [Oxc](https://oxc.rs)
- [@vitejs/plugin-react-swc](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react-swc) uses [SWC](https://swc.rs/)

## React Compiler

The React Compiler is not enabled on this template because of its impact on dev & build performances. To add it, see  [this documentation](https://react.dev/learn/react-compiler/installation).

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

- Development default API URL: `/api` (same-origin from `http://localhost:5173`).
- Development proxy support: Vite forwards `/api/*` to `VITE_AGORA_API_PROXY_TARGET` (default `http://localhost:8000`) for backend access.
- Production default API URL: `/api`
- Override request base in any environment with `VITE_AGORA_API_URL`.
- If you enable proxy mode, Vite forwards `/user_management/*` to WorkOS with explicit upstream timeouts.
- After AuthKit resolves a user, the dashboard bootstraps itself with `GET /auth/me`.
- Unauthenticated users can land on `/` or `/auth`; both render the auth landing page.
- Authenticated users are routed to the dashboard at `/`.
- API requests fetch access tokens on-demand through `getAccessToken()` before sending `Authorization: Bearer <token>` to the backend.
- API key management now lives at `/api-keys`.
- Benchmarks live at `/benchmarks` and are visible for human JWT sessions.
- API key principals do not see benchmark navigation.

WorkOS dashboard checklist for local auth:

- Add `http://localhost:5173/callback` to Redirect URIs.
- Add `http://localhost:5173/login` as the Sign-in endpoint.
- Add `http://localhost:5173` to Allowed Origins.

For local AuthKit troubleshooting, prefer `http://localhost:5173` for both sign-in and callback URLs. The backend API can still run on `http://localhost:8000` behind the `/api` Vite proxy.

When deploying on Vercel, `vercel.json` rewrites `/api/*` to the hosted Cloud Run API endpoint so browser calls remain same-origin and avoid CORS preflight failures.
