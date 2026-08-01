import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Toaster } from 'sonner'
import { App } from './App.tsx'
import { currentTheme, applyTheme } from './lib/stream.ts'
import './styles.css'

/**
 * Query defaults tuned for a local server: retries are pointless when the
 * failure is "the process is not running", and refetch-on-focus would fire a
 * dozen requests every time the user tabs back.
 */
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: (failureCount, error) => {
        // Never retry a 4xx; retry a transient network blip twice.
        const status = (error as { status?: number }).status
        if (typeof status === 'number' && status >= 400 && status < 500) return false
        return failureCount < 2
      },
      retryDelay: (attempt) => Math.min(1200, 300 * 2 ** attempt),
      refetchOnWindowFocus: false,
      staleTime: 10_000,
      gcTime: 5 * 60_000,
    },
    mutations: { retry: 0 },
  },
})

applyTheme(currentTheme())

const container = document.getElementById('root')
if (!container) throw new Error('#root is missing from index.html')

createRoot(container).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
      <Toaster
        position="bottom-right"
        theme="system"
        gap={8}
        offset={16}
        toastOptions={{
          // Match the app's tokens rather than sonner's defaults.
          style: {
            background: 'var(--bg-elevated)',
            border: '1px solid var(--border)',
            color: 'var(--fg)',
            fontSize: '12.5px',
            borderRadius: '10px',
            boxShadow: 'var(--shadow-popover)',
          },
          className: 'font-sans',
        }}
      />
    </QueryClientProvider>
  </StrictMode>,
)

// Remove the pre-React boot indicator once the first frame is painted.
requestAnimationFrame(() => document.getElementById('boot')?.remove())
