import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import type { Plugin } from 'vite'

/**
 * The production CSP forbids inline scripts. Vite's dev server (React
 * Fast Refresh preamble, HMR websocket) needs a little more, so the policy is
 * relaxed only while serving in development.
 */
function devCsp(): Plugin {
  return {
    name: 'dev-csp',
    apply: 'serve',
    transformIndexHtml(html) {
      return html.replace(
        /<meta http-equiv="Content-Security-Policy"[^>]*>/,
        `<meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ws: http://localhost:*" />`
      )
    }
  }
}

export default defineConfig({
  main: {
    build: {
      rollupOptions: { input: { index: resolve(__dirname, 'src/main/index.ts') } }
    }
  },
  preload: {
    build: {
      rollupOptions: { input: { index: resolve(__dirname, 'src/preload/index.ts') } }
    }
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    build: {
      minify: 'esbuild',
      rollupOptions: { input: { index: resolve(__dirname, 'src/renderer/index.html') } }
    },
    plugins: [react(), devCsp()]
  }
})
