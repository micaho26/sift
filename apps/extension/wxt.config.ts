import { defineConfig } from 'wxt'
import tailwind from '@tailwindcss/vite'

/**
 * Permissions are deliberately narrow.
 *
 * No `<all_urls>`, no `tabs`, no cookie access. Host permissions cover exactly
 * the three platforms whose data the user asked for, plus loopback so the worker
 * can post to the local Sift server. Everything else goes through `activeTab`,
 * which only grants access to a page the user explicitly invoked the extension on.
 */
export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  srcDir: 'src',
  outDir: '.output',
  manifest: {
    name: 'Sift — signal capture',
    short_name: 'Sift',
    description:
      'Capture high-signal AI posts from X, Xiaohongshu and any article straight into your local Sift library. No account, no cloud.',
    version: '0.1.0',
    permissions: ['storage', 'activeTab', 'scripting', 'contextMenus', 'notifications'],
    host_permissions: [
      'https://x.com/*',
      'https://twitter.com/*',
      'https://www.xiaohongshu.com/*',
      'http://127.0.0.1/*',
      'http://localhost/*',
    ],
    action: { default_title: 'Sift — capture (⌥⇧S)', default_popup: 'popup.html' },
    commands: {
      'capture-page': {
        suggested_key: { default: 'Alt+Shift+S', mac: 'Alt+Shift+S' },
        description: 'Capture the current page into Sift',
      },
      'toggle-harvest': {
        suggested_key: { default: 'Alt+Shift+H', mac: 'Alt+Shift+H' },
        description: 'Toggle background harvesting on this site',
      },
    },
    web_accessible_resources: [
      {
        // The MAIN-world interceptor is injected as a file, so it is subject to
        // the page's CSP as a resource rather than an inline script.
        resources: ['inject-x.js', 'inject-xhs.js'],
        matches: ['https://x.com/*', 'https://twitter.com/*', 'https://www.xiaohongshu.com/*'],
      },
    ],
  },
  vite: () => ({
    plugins: [tailwind()],
  }),
})
