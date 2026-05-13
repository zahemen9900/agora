import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { Agent } from 'node:https'

const workosProxyAgent = new Agent({
  keepAlive: true,
  family: 4,
  timeout: 15_000,
})

const DEFAULT_LOCAL_API_URL = 'http://127.0.0.1:8000'
const DEFAULT_GCLOUD_API_URL = 'https://agora-api-b4auawqzbq-uc.a.run.app'

function resolveApiProxyTarget(env: Record<string, string>): string {
  const explicitProxyTarget = env.VITE_AGORA_API_PROXY_TARGET?.trim()
  if (explicitProxyTarget) {
    return explicitProxyTarget
  }

  const backendSource = env.VITE_AGORA_BACKEND_SOURCE?.trim().toLowerCase() ?? 'local'
  const localApiUrl = env.VITE_AGORA_LOCAL_API_URL?.trim() || DEFAULT_LOCAL_API_URL
  const gcloudApiUrl = env.VITE_AGORA_GCLOUD_API_URL?.trim() || DEFAULT_GCLOUD_API_URL

  return backendSource === 'gcloud' ? gcloudApiUrl : localApiUrl
}

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const apiProxyTarget = resolveApiProxyTarget(env)

  return {
    plugins: [react(), tailwindcss()],
    server: {
      proxy: {
        '/api': {
          target: apiProxyTarget,
          changeOrigin: true,
          secure: false,
          rewrite: (path) => path.replace(/^\/api(?=\/|$)/, ''),
        },
        "/user_management": {
          target: "https://api.workos.com",
          changeOrigin: true,
          secure: true,
          agent: workosProxyAgent,
          timeout: 15_000,
          proxyTimeout: 15_000,
          configure: (proxy) => {
            proxy.on('proxyRes', (proxyRes) => {
              delete proxyRes.headers['set-cookie']
              delete proxyRes.headers['set-cookie2']
            })
          },
        },
      },
    },
  }
})
