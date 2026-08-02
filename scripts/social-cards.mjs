/**
 * Renders the GitHub social preview cards (Settings -> Social preview) and the
 * site's og:image, from the same design tokens the product uses.
 *
 * Why this exists: without a custom card, every share of the repo on X, Slack,
 * Feishu or LinkedIn renders GitHub's auto-generated one — owner, repo name, and
 * a stack of grey stat icons. It is the single highest-leverage surface a project
 * has for a link that gets forwarded, and it is the one thing about a repo that
 * has no API, so it has to be a deliberate artefact.
 *
 * Sizing: GitHub displays social previews at 1280x640 and rejects anything over
 * 1MB. Rendered at deviceScaleFactor 1 at exactly that size, because these get
 * displayed *smaller* than they are — X's card is roughly 500px wide, a 0.39x
 * reduction — so the constraint is legibility after shrinking, not resolution.
 * That is why the type here is much larger than it would be on a web page: the
 * 34px body text lands at about 13px in the feed, which is the floor.
 *
 *   node scripts/social-cards.mjs
 *
 * Writes apps/site/public/social/*.png. Deterministic — no timestamps, no
 * randomness — so re-running it produces a byte-identical file and a no-op diff.
 */

import { join } from 'node:path'
import { C, logoMark, renderCards, root } from './lib/cards.mjs'

// Written into the site's public/ rather than a top-level assets/ folder so there
// is one copy, not two: the showcase page offers these as downloads, and the same
// files are what gets uploaded to GitHub's social-preview setting.
const outDir = join(root, 'apps/site/public/social')

const WIDTH = 1280
const HEIGHT = 640

/** A ranked feed, abstracted: five rows at decaying opacity with a score pill.
 *  It says "this thing orders things" without needing a legible screenshot. */
const rankedFeedArt = () => {
  const rows = [
    { score: '94', w: 100, o: 1 },
    { score: '87', w: 92, o: 0.82 },
    { score: '71', w: 96, o: 0.6 },
    { score: '58', w: 86, o: 0.4 },
    { score: '41', w: 90, o: 0.24 },
  ]
  return `<div class="art" data-fit="art">${rows
    .map(
      (r, i) => `<div class="row" style="opacity:${r.o};width:${r.w}%">
        <span class="pill">${r.score}</span>
        <span class="bar" style="width:${74 - i * 6}%"></span>
      </div>`,
    )
    .join('')}</div>`
}

/** The actual scorecard shape the engine prints: four letters, four verdicts. */
const scorecardArt = () => {
  const cells = [
    { k: 'C', label: 'Current qtr', dot: C.green, v: '+41.6%' },
    { k: 'A', label: 'Annual + ROE', dot: C.amber, v: '+121%' },
    { k: 'S', label: 'Supply', dot: C.amber, v: '\u00d71.0' },
    { k: 'L', label: 'Rel. strength', dot: C.green, v: '+46.3%' },
  ]
  return `<div class="grid" data-fit="art">${cells
    .map(
      (c) => `<div class="cell">
        <div class="cellTop"><span class="letter">${c.k}</span><span class="dot" style="background:${c.dot}"></span></div>
        <div class="cellLabel">${c.label}</div>
        <div class="cellVal">${c.v}</div>
      </div>`,
    )
    .join('')}</div>`
}

function card({ accent, wordmark, headline, sub, chips, command, art, artStyles }) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      width: ${WIDTH}px; height: ${HEIGHT}px; overflow: hidden;
      font-family: 'Inter', sans-serif; background: ${C.bg}; color: ${C.fg};
      -webkit-font-smoothing: antialiased;
    }
    /* Two glows rather than a flat fill: a card that is one solid colour reads as
       a placeholder in a feed full of photographs. */
    .stage {
      position: relative; width: 100%; height: 100%; padding: 56px 68px;
      display: flex; align-items: center; gap: 52px;
      background:
        radial-gradient(1100px 520px at 88% -12%, ${accent[0]}26, transparent 62%),
        radial-gradient(760px 420px at -8% 108%, ${accent[1]}1f, transparent 60%),
        ${C.bg};
    }
    .stage::before {
      content: ''; position: absolute; inset: 0;
      background-image:
        linear-gradient(to right, ${C.borderSubtle} 1px, transparent 1px),
        linear-gradient(to bottom, ${C.borderSubtle} 1px, transparent 1px);
      background-size: 64px 64px;
      /* Fades out before the text, so the grid never fights the headline. */
      mask-image: radial-gradient(900px 640px at 82% 50%, #000 0%, transparent 76%);
      opacity: 0.5;
    }
    .left { position: relative; flex: 1 1 0; min-width: 0; }
    .brand { display: flex; align-items: center; gap: 18px; margin-bottom: 26px; }
    .brand svg { display: block; border-radius: 15px; }
    .wordmark { font-size: 40px; font-weight: 700; letter-spacing: -0.02em; }
    .owner { font-size: 24px; font-weight: 500; color: ${C.fg3}; letter-spacing: -0.01em; }
    h1 {
      font-size: 64px; line-height: 1.02; font-weight: 700; letter-spacing: -0.032em;
      margin-bottom: 20px; max-width: 15ch;
    }
    h1 em { font-style: normal; color: ${accent[0]}; }
    .sub { font-size: 28px; line-height: 1.34; color: ${C.fg2}; max-width: 30ch; margin-bottom: 26px; }
    /* One line only. Wrapping to a second row is what pushed the command box off
       the bottom of the 640px frame — the frame is the constraint, not the copy. */
    .chips { display: flex; flex-wrap: nowrap; gap: 10px; margin-bottom: 26px; }
    .chip {
      font-size: 20px; font-weight: 500; padding: 8px 15px; border-radius: 999px;
      border: 1px solid ${C.border}; background: ${C.bgSubtle}; color: ${C.fg2};
      white-space: nowrap;
    }
    .chip.on { border-color: ${accent[0]}66; color: ${accent[0]}; background: ${accent[1]}1a; }
    .cmd {
      display: inline-flex; align-items: center; gap: 14px;
      font-family: 'JetBrains Mono', monospace; font-size: 25px; font-weight: 500;
      padding: 15px 22px; border-radius: 12px;
      border: 1px solid ${C.border}; background: ${C.bgElevated}; color: ${C.fg};
    }
    .cmd .prompt { color: ${accent[0]}; }
    .right { position: relative; flex: 0 0 400px; height: 100%; display: flex; align-items: center; }
    ${artStyles}
  </style></head><body><div class="stage" data-fit="stage">
    <div class="left" data-fit="left">
      <div class="brand">${logoMark(58, accent)}<span class="wordmark">${wordmark}</span>${
        wordmark === 'Sift' ? '' : `<span class="owner">micaho26</span>`
      }</div>
      <h1>${headline}</h1>
      <div class="sub">${sub}</div>
      <div class="chips">${chips.map((c, i) => `<span class="chip${i === 0 ? ' on' : ''}">${c}</span>`).join('')}</div>
      <div class="cmd"><span class="prompt">$</span>${command}</div>
    </div>
    <div class="right" data-fit="right">${art}</div>
  </div></body></html>`
}

const feedStyles = `
  .art { width: 100%; display: flex; flex-direction: column; gap: 14px; }
  .row {
    display: flex; align-items: center; gap: 16px; padding: 18px 20px;
    border: 1px solid ${C.border}; border-radius: 14px; background: ${C.bgSubtle};
  }
  .pill {
    font-family: 'JetBrains Mono', monospace; font-size: 21px; font-weight: 600;
    color: ${C.violet}; background: ${C.violetDeep}26; border: 1px solid ${C.violet}4d;
    border-radius: 8px; padding: 5px 11px; flex: 0 0 auto;
  }
  .bar { height: 11px; border-radius: 999px; background: linear-gradient(90deg, ${C.fg3}, ${C.border}); }
`

const scorecardStyles = `
  .grid { width: 100%; display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
  .cell { border: 1px solid ${C.border}; border-radius: 16px; background: ${C.bgSubtle}; padding: 22px 24px; }
  .cellTop { display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; }
  .letter { font-size: 40px; font-weight: 700; letter-spacing: -0.02em; color: ${C.fg}; }
  .dot { width: 15px; height: 15px; border-radius: 999px; display: block; }
  .cellLabel { font-size: 18px; color: ${C.fg3}; margin-bottom: 8px; }
  .cellVal { font-family: 'JetBrains Mono', monospace; font-size: 25px; font-weight: 600; color: ${C.teal}; }
`

const CARDS = [
  {
    file: 'sift.png',
    html: card({
      accent: [C.violet, C.violetDeep],
      wordmark: 'Sift',
      headline: 'Signal intelligence for <em>technologists</em>',
      sub: 'A local-first AI intelligence workstation. Harvest, score, search and synthesise — on your machine.',
      chips: ['local-first', '0 native deps', 'BM25 + vector RRF', 'EN + 中文'],
      command: 'pnpm install &amp;&amp; pnpm dev',
      art: rankedFeedArt(),
      artStyles: feedStyles,
    }),
  },
  {
    file: 'canslim.png',
    html: card({
      accent: [C.teal, '#2b9e94'],
      wordmark: 'canslim',
      headline: 'CANSLIM scoring for <em>A-shares</em>',
      sub: 'A seven-factor scorecard and Excel reports from six-digit codes. No API key, stdlib only.',
      chips: ['agent skill', 'C·A·S·L + M gate', 'public data', 'stdlib only'],
      command: 'npx skills add micaho26/canslim',
      art: scorecardArt(),
      artStyles: scorecardStyles,
    }),
  },
]

await renderCards(CARDS, { outDir, width: WIDTH, height: HEIGHT, byteLimit: 1_000_000 })
