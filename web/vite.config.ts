import path from 'node:path'
import { fileURLToPath } from 'node:url'

import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

const webRoot = path.dirname(fileURLToPath(import.meta.url))

/** Always resolve `.env` next to `vite.config.ts` (helps when cwd is wrong on Windows). */
const orionBuildStamp = new Date().toISOString().slice(0, 16).replace('T', ' ')

export default defineConfig({
  root: webRoot,
  envDir: webRoot,
  // Capacitor loads bundled assets from the app sandbox — relative paths required.
  base: process.env.CAPACITOR === '1' ? './' : '/',
  define: {
    __ORION_BUILD__: JSON.stringify(orionBuildStamp),
  },
  plugins: [react()],
  build: {
    chunkSizeWarningLimit: 650,
  },
  optimizeDeps: {
    include: ['react', 'react-dom', '@stripe/react-stripe-js', '@stripe/stripe-js'],
  },
  server: {
    host: '127.0.0.1',
    port: 5732,
    proxy: {
      '/orion/': {
        target: 'http://127.0.0.1:8790',
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/orion/, ''),
      },
      '/payments/': {
        target: 'http://127.0.0.1:8791',
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/payments/, ''),
      },
    },
  },
})
