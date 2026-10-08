import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      // The cost engine is shared with the backend — ONE source of truth for
      // the validated formulas (PRD §2). Pure TS, no server dependencies.
      '@domain': fileURLToPath(new URL('../src/domain/index.ts', import.meta.url)),
    },
  },
  server: {
    // The HERE API key lives in the backend only; the browser talks to our
    // proxy, never to HERE (PRD §4.1). API_PROXY_TARGET lets docker-compose
    // point at the backend container instead of localhost.
    proxy: { '/api': process.env['API_PROXY_TARGET'] ?? 'http://127.0.0.1:3001' },
    fs: { allow: ['..'] },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    watch: false,
  },
})
