// @ts-check
import { defineConfig } from 'astro/config'
import sitemap from '@astrojs/sitemap'
import tailwind from '@tailwindcss/vite'

/**
 * Deployed to GitHub Pages as a project page, so `base` must match the repo name.
 * Both are overridable from CI, which is how the workflow injects the real values
 * without this file needing to know the owner.
 */
const SITE = process.env.SITE_URL ?? 'https://micaho26.github.io'
const BASE = process.env.SITE_BASE ?? '/sift'

export default defineConfig({
  site: SITE,
  base: BASE,
  trailingSlash: 'ignore',
  integrations: [sitemap()],
  vite: { plugins: [tailwind()] },
  build: { inlineStylesheets: 'always' },
  compressHTML: true,
})
