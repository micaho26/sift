import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwind from '@tailwindcss/vite'

const API_PORT = Number(process.env.SIFT_PORT ?? 4471)
const WEB_PORT = Number(process.env.SIFT_WEB_PORT ?? 4470)

export default defineConfig({
  plugins: [react(), tailwind()],
  server: {
    port: WEB_PORT,
    // Strict: the launcher already picked a free port, so a silent fallback to a
    // different one would leave it polling an address nothing is listening on.
    strictPort: true,
    // The dev client talks to the API on its own origin, so nothing in the app
    // needs to know which port the server is on.
    proxy: {
      '/api': {
        target: `http://127.0.0.1:${API_PORT}`,
        changeOrigin: true,
        // SSE must not be buffered by the proxy.
        ws: false,
        configure: (proxy) => {
          proxy.on('proxyRes', (proxyRes) => {
            if (proxyRes.headers['content-type']?.includes('text/event-stream')) {
              proxyRes.headers['cache-control'] = 'no-cache, no-transform'
            }
          })
        },
      },
    },
  },
  build: {
    target: 'es2022',
    sourcemap: false,
    chunkSizeWarningLimit: 900,
    rollupOptions: {
      output: {
        // Split vendor code so the app shell paints before the long tail loads.
        manualChunks: (id: string) => {
          if (!id.includes('node_modules')) return undefined
          if (id.includes('react-dom') || id.includes('/react/')) return 'react'
          if (id.includes('@tanstack')) return 'query'
          if (id.includes('cmdk') || id.includes('sonner') || id.includes('lucide-react')) return 'ui'
          return undefined
        },
      },
    },
  },
})
