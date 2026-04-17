import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { Agent } from 'node:https'

const workosProxyAgent = new Agent({
  keepAlive: true,
  family: 4,
  timeout: 15_000,
})
const apiProxyTarget = process.env.VITE_AGORA_API_PROXY_TARGET || 'http://localhost:8000'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      '/api': {
        target: apiProxyTarget,
        changeOrigin: true,
        secure: false,
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
      "/user_management": {
        target: "https://api.workos.com",
        changeOrigin: true,
        secure: true,
        agent: workosProxyAgent,
        timeout: 15_000,
        proxyTimeout: 15_000,
      },
    },
  },
})
