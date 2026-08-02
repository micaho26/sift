/**
 * Post images for promoting the project: one for X, one cover for 小红书.
 *
 *   node scripts/promo-cards.mjs
 *
 * **X (`x-findings.png`, 1600x900).** A long-form post is collapsed in the
 * timeline to roughly its first 280 characters plus "Show more", so the attached
 * image — not the prose — is what stops the scroll. For a technical thread the
 * image that earns a click is *evidence*, not a claim: an HTTP 422 with GitHub's
 * own error string is more persuasive than any sentence asserting the bug was
 * real. 16:9 because that is the ratio X renders a single image at uncropped.
 *
 * **小红书 (`xhs-cover.png`, 1242x1656).** 3:4 is the ratio the feed reserves;
 * anything else is centre-cropped and loses its edges. Rendered at 2x because
 * 小红书 is a phone-first surface on retina displays. The cover carries the whole
 * hook — a 小红书 cover is read at about 240px wide in the grid, so there is room
 * for one headline and three chips, and nothing else.
 *
 * Both are deterministic: no timestamps, no randomness, byte-identical on re-run.
 */

import { join } from 'node:path'
import { C, logoMark, renderCards, root } from './lib/cards.mjs'

const outDir = join(root, 'apps/site/public/social')

/* ─────────────────────────────────────────────────── X: the three findings ── */

/**
 * Each row is a real artefact from a clean-clone run, quoted rather than
 * paraphrased. `verdict` is the part that matters: what the result meant, which
 * in every case is worse than the result looks.
 *
 * The fourth row is a 200, deliberately. Three failures that reported success
 * and one success that should not have existed is the actual shape of the day,
 * and it is a sharper point than three of the same kind.
 */
const FINDINGS = [
  {
    probe: "node --test 'test/*.test.ts'",
    result: 'exit 0 · tests 0',
    tone: C.amber,
    verdict: 'The test directory did not exist. A glob matching nothing exits 0, so CI stayed green over the entire server.',
  },
  {
    probe: 'topic:llm OR topic:ai-agents',
    result: 'HTTP 422',
    tone: C.red,
    verdict: '“Logical operators only apply to text, not to qualifiers.” The default connector had never returned one repo.',
  },
  {
    probe: 'www.anthropic.com/rss.xml',
    result: 'HTTP 404',
    tone: C.red,
    verdict: 'Anthropic publishes no feed at all. The source shipped enabled and could never succeed.',
  },
  {
    probe: 'fonts.googleapis.com/css2',
    result: 'HTTP 200',
    tone: C.teal,
    verdict: 'Here the 200 was the bug — a page whose first claim is “runs entirely on your machine” called Google on every view.',
  },
]

const xFindings = `<!doctype html><html><head><meta charset="utf-8"><style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    width: 1600px; height: 900px; overflow: hidden;
    font-family: 'Inter', -apple-system, 'PingFang SC', sans-serif;
    background:
      radial-gradient(1200px 620px at 86% -14%, ${C.violet}20, transparent 62%),
      radial-gradient(820px 460px at -6% 110%, ${C.violetDeep}1c, transparent 60%),
      ${C.bg};
    color: ${C.fg}; -webkit-font-smoothing: antialiased;
  }
  .stage { position: relative; width: 100%; height: 100%; padding: 62px 72px; display: flex; flex-direction: column; }
  .stage::before {
    content: ''; position: absolute; inset: 0;
    background-image:
      linear-gradient(to right, ${C.borderSubtle} 1px, transparent 1px),
      linear-gradient(to bottom, ${C.borderSubtle} 1px, transparent 1px);
    background-size: 72px 72px;
    mask-image: radial-gradient(1000px 700px at 78% 46%, #000 0%, transparent 74%);
    opacity: 0.45;
  }
  .top { position: relative; display: flex; align-items: center; gap: 16px; margin-bottom: 26px; }
  .top svg { display: block; border-radius: 13px; }
  .wordmark { font-size: 30px; font-weight: 700; letter-spacing: -0.02em; }
  .kicker {
    margin-left: auto; font-family: 'JetBrains Mono', monospace; font-size: 19px;
    color: ${C.fg3}; letter-spacing: 0.04em;
  }
  h1 {
    position: relative; font-size: 54px; line-height: 1.04; font-weight: 700;
    letter-spacing: -0.03em; margin-bottom: 8px;
  }
  h1 em { font-style: normal; color: ${C.violet}; }
  .lede { position: relative; font-size: 24px; color: ${C.fg2}; margin-bottom: 30px; }
  .rows { position: relative; display: flex; flex-direction: column; gap: 15px; }
  .row {
    display: grid; grid-template-columns: 420px 250px 1fr; align-items: center; gap: 26px;
    border: 1px solid ${C.border}; border-radius: 15px; background: ${C.bgSubtle};
    padding: 25px 26px;
  }
  .probe {
    font-family: 'JetBrains Mono', monospace; font-size: 20px; font-weight: 500;
    color: ${C.fg}; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .result {
    font-family: 'JetBrains Mono', monospace; font-size: 19px; font-weight: 600;
    white-space: nowrap;
  }
  .verdict { font-size: 20px; line-height: 1.36; color: ${C.fg2}; }
  .foot {
    position: relative; margin-top: auto; padding-top: 26px; display: flex;
    align-items: baseline; justify-content: space-between; gap: 24px;
  }
  .foot .note { font-size: 22px; color: ${C.fg3}; }
  .foot .note b { color: ${C.fg}; font-weight: 600; }
  .foot .repo { font-family: 'JetBrains Mono', monospace; font-size: 21px; color: ${C.violet}; }
</style></head><body><div class="stage">
  <div class="top">
    ${logoMark(46, [C.violet, C.violetDeep])}
    <span class="wordmark">Sift</span>
    <span class="kicker">one clean clone · 4 findings</span>
  </div>

  <h1>Four green results that were <em>wrong</em></h1>
  <div class="lede">Three failures that reported success — and one success that should not have existed.</div>

  <div class="rows">
    ${FINDINGS.map(
      (f) => `<div class="row">
        <div class="probe">${f.probe}</div>
        <div class="result" style="color:${f.tone}">${f.result}</div>
        <div class="verdict">${f.verdict}</div>
      </div>`,
    ).join('')}
  </div>

  <div class="foot">
    <div class="note">Found by <b>running it</b>, not by reading it. 52 tests → <b>79</b>.</div>
    <div class="repo">github.com/micaho26/sift</div>
  </div>
</div></body></html>`

/* ────────────────────────────────────────────────────── 小红书: the cover ── */

const xhsCover = `<!doctype html><html><head><meta charset="utf-8"><style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    width: 621px; height: 828px; overflow: hidden;
    font-family: 'Inter', -apple-system, 'PingFang SC', 'Hiragino Sans GB', sans-serif;
    background:
      radial-gradient(560px 460px at 50% -8%, ${C.violet}26, transparent 66%),
      radial-gradient(420px 380px at 108% 104%, ${C.teal}14, transparent 62%),
      ${C.bg};
    color: ${C.fg}; -webkit-font-smoothing: antialiased;
  }
  .stage { position: relative; width: 100%; height: 100%; padding: 54px 46px; display: flex; flex-direction: column; }
  .stage::before {
    content: ''; position: absolute; inset: 0;
    background-image:
      linear-gradient(to right, ${C.borderSubtle} 1px, transparent 1px),
      linear-gradient(to bottom, ${C.borderSubtle} 1px, transparent 1px);
    background-size: 46px 46px;
    mask-image: radial-gradient(420px 620px at 50% 42%, #000 0%, transparent 78%);
    opacity: 0.5;
  }
  .brand { position: relative; display: flex; align-items: center; gap: 12px; }
  .brand svg { display: block; border-radius: 11px; }
  .brand span { font-size: 25px; font-weight: 700; letter-spacing: -0.02em; }
  h1 {
    position: relative; margin-top: 40px; font-size: 60px; line-height: 1.14;
    font-weight: 700; letter-spacing: -0.01em;
  }
  h1 em { font-style: normal; color: ${C.violet}; }
  .sub {
    position: relative; margin-top: 22px; font-size: 27px; line-height: 1.5; color: ${C.fg2};
  }
  .chips { position: relative; margin-top: 34px; display: flex; flex-direction: column; gap: 12px; }
  .chip {
    display: flex; align-items: baseline; gap: 12px;
    border: 1px solid ${C.border}; border-radius: 13px; background: ${C.bgSubtle};
    padding: 15px 18px; font-size: 23px; color: ${C.fg2};
  }
  .chip b { color: ${C.fg}; font-weight: 600; }
  .chip .n {
    font-family: 'JetBrains Mono', monospace; font-size: 21px; font-weight: 600;
    color: ${C.violet}; flex: 0 0 auto;
  }
  .foot {
    position: relative; margin-top: auto; font-size: 21px; color: ${C.fg3}; line-height: 1.5;
  }
  .foot b { color: ${C.fg2}; font-weight: 500; }
</style></head><body><div class="stage">
  <div class="brand">${logoMark(38, [C.violet, C.violetDeep])}<span>Sift</span></div>

  <h1>本地跑的<br /><em>AI 情报工作台</em></h1>
  <div class="sub">六个时间线、三种语言、同一条发布被转二十遍 —— 一个能打分、能去重、中英文都能搜的收件箱。</div>

  <div class="chips">
    <div class="chip"><span class="n">6</span><span>个维度打分，<b>每一分都能看到怎么算的</b></span></div>
    <div class="chip"><span class="n">0</span><span>原生依赖，<b>install 不会卡在编译</b></span></div>
    <div class="chip"><span class="n">1</span><span>个 SQLite 文件，<b>不注册、无遥测</b></span></div>
  </div>

  <div class="foot"><b>开源 · MIT</b><br />github.com/micaho26/sift</div>
</div></body></html>`

/* ─────────────────────────────────────────────── 小红书: the checklist cover ── */

/**
 * A second cover, because a cover has to match the post it opens.
 *
 * The product cover above suits a launch post. The debugging story needs a
 * different hook: 小红书 readers scroll for something they can take away, not for
 * evidence that someone was thorough — so the same four findings are framed as a
 * checklist for anyone shipping AI-written code, which is what they actually are.
 */
const xhsChecklistCover = `<!doctype html><html><head><meta charset="utf-8"><style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    width: 621px; height: 828px; overflow: hidden;
    font-family: 'Inter', -apple-system, 'PingFang SC', 'Hiragino Sans GB', sans-serif;
    background:
      radial-gradient(520px 440px at 50% -6%, ${C.violet}24, transparent 66%),
      radial-gradient(400px 360px at 106% 106%, ${C.red}12, transparent 62%),
      ${C.bg};
    color: ${C.fg}; -webkit-font-smoothing: antialiased;
  }
  .stage { position: relative; width: 100%; height: 100%; padding: 52px 44px; display: flex; flex-direction: column; }
  .stage::before {
    content: ''; position: absolute; inset: 0;
    background-image:
      linear-gradient(to right, ${C.borderSubtle} 1px, transparent 1px),
      linear-gradient(to bottom, ${C.borderSubtle} 1px, transparent 1px);
    background-size: 46px 46px;
    mask-image: radial-gradient(420px 620px at 50% 44%, #000 0%, transparent 78%);
    opacity: 0.5;
  }
  .tag {
    position: relative; align-self: flex-start;
    font-size: 20px; font-weight: 600; letter-spacing: 0.02em;
    color: ${C.violet}; border: 1px solid ${C.violet}55; background: ${C.violetDeep}1f;
    border-radius: 999px; padding: 9px 18px;
  }
  h1 {
    position: relative; margin-top: 34px; font-size: 62px; line-height: 1.16;
    font-weight: 700; letter-spacing: -0.01em;
  }
  h1 em { font-style: normal; color: ${C.violet}; }
  .sub { position: relative; margin-top: 20px; font-size: 26px; line-height: 1.5; color: ${C.fg2}; }
  .list { position: relative; margin-top: 32px; display: flex; flex-direction: column; gap: 11px; }
  .item {
    display: flex; align-items: center; gap: 14px;
    border: 1px solid ${C.border}; border-radius: 13px; background: ${C.bgSubtle};
    padding: 16px 18px;
  }
  .code {
    font-family: 'JetBrains Mono', monospace; font-size: 19px; font-weight: 600;
    flex: 0 0 96px;
  }
  .what { font-size: 22px; color: ${C.fg2}; line-height: 1.3; }
  .foot { position: relative; margin-top: auto; font-size: 22px; line-height: 1.5; color: ${C.fg3}; }
  .foot b { color: ${C.fg}; font-weight: 600; }
</style></head><body><div class="stage">
  <div class="tag">用 AI 写代码</div>

  <h1>它说「跑通了」<br />这 <em>4 个绿灯</em>是假的</h1>
  <div class="sub">一次 clean clone，30 秒抓出四个「看起来完全正常」的问题。</div>

  <div class="list">
    <div class="item"><span class="code" style="color:${C.amber}">exit 0</span><span class="what">测试一个都没跑，CI 还是全绿</span></div>
    <div class="item"><span class="code" style="color:${C.red}">422</span><span class="what">接口从来没成功过，只写了行日志</span></div>
    <div class="item"><span class="code" style="color:${C.red}">404</span><span class="what">配置里的地址根本不存在</span></div>
    <div class="item"><span class="code" style="color:${C.teal}">200</span><span class="what">请求成功，但这个成功就是 bug</span></div>
  </div>

  <div class="foot"><b>最容易骗人的不是报错，是报成功。</b><br />开源 · MIT · github.com/micaho26/sift</div>
</div></body></html>`

await renderCards([{ file: 'x-findings.png', html: xFindings, width: 1600, height: 900 }], {
  outDir,
  scale: 1,
  // X re-encodes anything large; staying well under keeps the upload lossless.
  byteLimit: 5_000_000,
})

await renderCards(
  [
    { file: 'xhs-cover.png', html: xhsCover, width: 621, height: 828 },
    { file: 'xhs-cover-checklist.png', html: xhsChecklistCover, width: 621, height: 828 },
  ],
  {
    outDir,
    // 2x of 621x828 = 1242x1656, the 3:4 the 小红书 feed reserves.
    scale: 2,
    byteLimit: 20_000_000,
  },
)
