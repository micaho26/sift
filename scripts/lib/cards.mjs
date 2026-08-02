/**
 * Shared rendering plumbing for the image generators in this folder.
 *
 * Both `social-cards.mjs` (repo previews) and `promo-cards.mjs` (post images)
 * need the same three things: the product's colour tokens, the site's woff2
 * faces inlined as data URLs, and a headless Chromium that screenshots HTML at
 * an exact pixel size. Keeping them here means the two scripts cannot drift into
 * rendering the same brand two slightly different ways.
 */

import { chromium } from 'playwright'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const fontDir = join(root, 'apps/site/public/fonts')

/** The site's tokens, resolved to sRGB — a headless Chromium renders OKLCH, but
 *  hex keeps output identical to what shipped even if the tokens are retuned. */
export const C = {
  bg: '#0d0d14',
  bgSubtle: '#16161f',
  bgElevated: '#1c1c27',
  border: '#2b2b38',
  borderSubtle: '#22222d',
  fg: '#f7f7fa',
  fg2: '#b9b9c6',
  fg3: '#8b8b9c',
  violet: '#a78bfa',
  violetDeep: '#6d4df0',
  teal: '#4fd1c5',
  green: '#72c96b',
  amber: '#f0b429',
  red: '#f0656b',
}

async function inlineFont(file, family, weightRange) {
  const b64 = (await readFile(join(fontDir, file))).toString('base64')
  return `@font-face{font-family:'${family}';font-style:normal;font-weight:${weightRange};src:url(data:font/woff2;base64,${b64}) format('woff2')}`
}

/**
 * Chrome's shipped fonts vary by machine and CI image; embedding the same woff2
 * the site serves is what makes a render reproducible anywhere.
 *
 * Only the latin faces are embedded. Any CJK on these images falls through to a
 * system font, so run this on a machine that has one — a bare Linux container
 * renders tofu. Outputs are committed, so that only matters on regeneration.
 */
export async function fontCss() {
  return [
    await inlineFont('inter-latin.woff2', 'Inter', '400 700'),
    await inlineFont('jetbrains-mono-latin.woff2', 'JetBrains Mono', '400 600'),
  ].join('')
}

export const logoMark = (size, accent) => `
  <svg width="${size}" height="${size}" viewBox="0 0 96 96">
    <defs><linearGradient id="lg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="${accent[0]}"/><stop offset="100%" stop-color="${accent[1]}"/>
    </linearGradient></defs>
    <rect width="96" height="96" rx="22" fill="#0e0e15"/>
    <path d="M18 48 L48 18 L78 48 L48 78 Z" fill="url(#lg)"/>
    <path d="M33 48 L48 33 L63 48 L48 63 Z" fill="#0e0e15" fill-opacity="0.55"/>
  </svg>`

/**
 * Screenshot each card to `outDir`, asserting nothing overflows its frame first.
 *
 * The overflow check is not decoration. The first social card clipped its command
 * box off the bottom, and a PNG does not complain — it just ships wrong. Any copy
 * edit that outgrows the frame now fails the run instead.
 */
export async function renderCards(cards, { outDir, width, height, scale = 1, byteLimit }) {
  const css = await fontCss()
  const browser = await chromium.launch()
  await mkdir(outDir, { recursive: true })

  try {
    for (const { file, html, width: w = width, height: h = height } of cards) {
      const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: scale })
      await page.setContent(html.replace('<style>', `<style>${css}`), { waitUntil: 'load' })
      await page.evaluate(() => document.fonts.ready)

      const overflow = await page.evaluate(() => {
        const bad = []
        for (const el of document.querySelectorAll('[data-fit]')) {
          if (el.scrollHeight > el.clientHeight + 1) bad.push(`${el.dataset.fit} overflows by ${el.scrollHeight - el.clientHeight}px`)
        }
        if (document.body.scrollWidth > window.innerWidth + 1) bad.push('body overflows horizontally')
        if (document.body.scrollHeight > window.innerHeight + 1) bad.push('body overflows vertically')
        return bad
      })
      if (overflow.length) throw new Error(`${file}: ${overflow.join('; ')}`)

      const png = await page.screenshot({ type: 'png' })
      await writeFile(join(outDir, file), png)
      await page.close()

      const kb = (png.byteLength / 1024).toFixed(0)
      const over = byteLimit && png.byteLength > byteLimit ? `  ⚠ over the ${(byteLimit / 1e6).toFixed(0)}MB limit` : ''
      console.log(`${file.padEnd(18)} ${w * scale}x${h * scale}  ${kb} KB${over}`)
    }
  } finally {
    await browser.close()
  }
}
