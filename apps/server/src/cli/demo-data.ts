/**
 * The demo corpus.
 *
 * A tool that starts empty cannot be evaluated, so `pnpm seed` loads a realistic
 * cross-section: X threads, Xiaohongshu notes in Chinese, HN discussions, arXiv
 * papers, GitHub releases and newsletter posts — including deliberate
 * near-duplicates and engagement bait, so the dedup and noise penalties are
 * visible rather than claimed.
 *
 * Timestamps are relative to run time so the feed always looks current.
 */
import type { IngestItem } from '@sift/core'

const HOUR = 3_600_000
const ago = (hours: number) => Date.now() - hours * HOUR

export function demoItems(): IngestItem[] {
  return [
    /* ─────────────────────────────────────────────────────── X / Twitter ── */
    {
      url: 'https://x.com/karpathy/status/1899000000000000001',
      source: 'x',
      kind: 'thread',
      title: 'The bitter lesson of agent harnesses: your scaffold is a tax on the next model',
      content: `Spent the week rebuilding a coding agent from scratch and the same lesson keeps landing.

Every clever bit of scaffolding I add — retry heuristics, hand-tuned tool descriptions, a planner that decomposes tasks — buys maybe 4-6 points on my private eval today. Then the next model release makes 3 of those 5 components net-negative, because the model now does that step better than my code does and my code is in the way.

Concretely: I had a "plan then execute" split that helped GPT-5 era models a lot. On the current generation it costs ~7% on SWE-bench-verified vs just letting the model run with tools. The plan step now anchors it to a worse decomposition than it would have found mid-task.

What has kept paying off across four model generations:
1. Better tools (a real file editor beats string replacement)
2. Better context (compaction that keeps the diff, drops the chatter)
3. Better feedback loops (tests it can actually run)
4. Getting out of the way

The harness should be thin and the environment should be rich. Everything else is a bet against the models improving, and that bet has not paid off once.`,
      author: { name: 'Andrej Karpathy', handle: 'karpathy', followers: 1_240_000, verified: true, url: 'https://x.com/karpathy' },
      metrics: { likes: 18_400, reposts: 3_120, replies: 612, bookmarks: 9_800, views: 2_140_000 },
      publishedAt: ago(7),
    },
    {
      url: 'https://x.com/simonw/status/1899000000000000002',
      source: 'x',
      kind: 'post',
      title: 'Prompt injection is still unsolved and agentic browsers make it worse',
      content: `I keep saying this and it keeps being true: there is no reliable fix for prompt injection, and shipping an agent that browses the web on the user's behalf with access to their authenticated sessions is shipping a confused deputy.

Tested three agentic browsers this week. All three could be steered by text in a page: a comment on a GitHub issue, an alt attribute, white-on-white text in a doc. Two of them would then take an authenticated action.

The mitigation that actually works is architectural, not a better system prompt: separate the untrusted-content plane from the privileged-action plane, and require a human confirmation for anything irreversible. Everything else is a filter that someone will get past next week.

Detailed writeup with the exact payloads on my blog.`,
      author: { name: 'Simon Willison', handle: 'simonw', followers: 218_000, verified: true, url: 'https://x.com/simonw' },
      metrics: { likes: 6_240, reposts: 1_890, replies: 224, bookmarks: 4_100, views: 612_000 },
      publishedAt: ago(19),
    },
    {
      url: 'https://x.com/AnthropicAI/status/1899000000000000003',
      source: 'x',
      kind: 'release',
      title: 'Claude Opus 5 is available today, with a 1M token context window',
      content: `Claude Opus 5 is now generally available in the API, claude.ai and Claude Code.

- 80.9% on SWE-bench Verified
- 1M token context window on all tiers
- 2.1x faster time-to-first-token than Opus 4.5
- Extended thinking now interleaves with tool calls

Pricing is unchanged from Opus 4.5. Model card, evals and the full safety report are in the link.`,
      author: { name: 'Anthropic', handle: 'AnthropicAI', followers: 1_020_000, verified: true, url: 'https://x.com/AnthropicAI' },
      metrics: { likes: 24_800, reposts: 6_400, replies: 1_840, bookmarks: 11_200, views: 4_800_000 },
      publishedAt: ago(4),
    },
    {
      // Deliberate near-duplicate of the above — should collapse into it.
      url: 'https://x.com/aidevnews/status/1899000000000000004',
      source: 'x',
      kind: 'post',
      title: 'Anthropic just released Claude Opus 5 with a 1 million token context window',
      content: `Anthropic has released Claude Opus 5 today. It scores 80.9% on SWE-bench Verified, has a 1M token context window on every tier, and is 2.1x faster to first token than Opus 4.5. Pricing stays the same as Opus 4.5.`,
      author: { name: 'AI Dev News', handle: 'aidevnews', followers: 84_000, verified: false },
      metrics: { likes: 1_240, reposts: 380, replies: 42, bookmarks: 210, views: 96_000 },
      publishedAt: ago(3),
    },
    {
      // Deliberate engagement bait — should be pushed below the fold.
      url: 'https://x.com/aigrowthguy/status/1899000000000000005',
      source: 'x',
      kind: 'post',
      title: '🔥 10 INSANE AI agents that will REPLACE your entire team in 2026 🧵',
      content: `These 10 AI agents will BLOW YOUR MIND 🤯🤯

Nobody is talking about #7 and it's a total game changer!!!

Follow me and RT this thread for more 🔥 I post AI alpha every single day

#AI #AGI #LLM #agents #automation #productivity #buildinpublic #tech`,
      author: { name: 'AI Growth Guy', handle: 'aigrowthguy', followers: 486_000, verified: true },
      metrics: { likes: 32_000, reposts: 9_800, replies: 1_400, bookmarks: 2_100, views: 6_200_000 },
      publishedAt: ago(6),
    },
    {
      url: 'https://x.com/DrJimFan/status/1899000000000000006',
      source: 'x',
      kind: 'thread',
      title: 'Why VLA models still fail at contact-rich manipulation, with numbers',
      content: `We ran 4,200 real-world trials across three VLA checkpoints on contact-rich tasks (plug insertion, zipper, cloth folding). Success rates: 31%, 44%, 47%.

The failure mode is almost never perception. It is that the action head has no notion of force. We logged wrench data on every trial: 78% of failures show the gripper applying 3-8x the force a human uses on the same task before the policy notices anything is wrong.

Adding a force-torque channel to the observation space and 2% force-labelled data took plug insertion from 44% to 71%. The remaining gap is recovery behaviour — the models have essentially never seen a recovery in training data because teleoperators redo the episode instead.

Data collection protocol matters more than architecture right now. Paper and the 4,200-trial log are open.`,
      author: { name: 'Jim Fan', handle: 'DrJimFan', followers: 312_000, verified: true },
      metrics: { likes: 9_100, reposts: 2_240, replies: 318, bookmarks: 6_800, views: 1_180_000 },
      publishedAt: ago(29),
    },
    {
      url: 'https://x.com/deepseek_ai/status/1899000000000000007',
      source: 'x',
      kind: 'release',
      title: 'DeepSeek-V4 weights are open: 671B MoE, 37B active, MIT licensed',
      content: `DeepSeek-V4 is out under MIT.

671B total / 37B active parameters. Trained on 18.2T tokens. GPQA-Diamond 79.4, LiveCodeBench 68.2, AIME 2026 91.3.

Inference at fp8 fits on 8xH200. GGUF quants from the community are already landing. Technical report covers the new sparse attention variant and the RL recipe in full — including the failed runs.`,
      author: { name: 'DeepSeek', handle: 'deepseek_ai', followers: 428_000, verified: true },
      metrics: { likes: 21_400, reposts: 7_100, replies: 892, bookmarks: 14_600, views: 3_400_000 },
      publishedAt: ago(52),
    },
    {
      url: 'https://x.com/natolambert/status/1899000000000000008',
      source: 'x',
      kind: 'post',
      title: 'The open-weights gap narrowed to about five months this year',
      content: `Tracked the delta between the best closed model and the best open-weights model on a fixed eval basket for 30 months.

2024: ~14 months. Mid-2025: ~9 months. Now: ~5 months.

Two things drove it. Chinese labs treating open weights as distribution strategy rather than charity, and distillation from reasoning traces getting genuinely good. The second one is the underrated half — you can now buy most of a frontier reasoning model's behaviour for a rounding error of the training cost.

Caveat on the methodology: my eval basket rotates as benchmarks saturate, which biases toward whatever is currently unsaturated. I publish the basket each quarter so you can disagree with it.`,
      author: { name: 'Nathan Lambert', handle: 'natolambert', followers: 96_000, verified: true },
      metrics: { likes: 4_820, reposts: 1_180, replies: 186, bookmarks: 3_900, views: 480_000 },
      publishedAt: ago(41),
    },

    /* ─────────────────────────────────────────────── 小红书 / Xiaohongshu ── */
    {
      url: 'https://www.xiaohongshu.com/explore/67f0a1b2c3d4e5f607182930',
      source: 'xiaohongshu',
      kind: 'note',
      title: 'M4 Max 128G 本地跑 DeepSeek-V4 量化版实测，附完整配置',
      content: `折腾了一周，终于把 DeepSeek-V4 的 4bit 量化版在 M4 Max 128G 上跑通了，直接上数据。

**环境**
- MacBook Pro M4 Max，128G 统一内存
- llama.cpp b6120，Metal 后端
- DeepSeek-V4 Q4_K_M，磁盘占用 41.2GB

**实测吞吐**
- 短上下文（2K）：18.4 tok/s
- 长上下文（32K）：11.2 tok/s
- 首 token 延迟：32K 上下文下 4.8 秒

**踩的坑**
1. 默认 metal 层数分配有问题，要手动 -ngl 999 全部丢显存，不然掉到 6 tok/s
2. 内存压力峰值 92GB，同时开 Chrome 会 swap，建议留够余量
3. Q4 在中文长文本改写上明显不如 Q6，但 Q6 就跑不动了

**结论**
日常代码补全够用，长文档分析勉强，多轮 agent 任务不建议。想认真用还是得上 API 或者双卡 4090。

配置文件和启动脚本放评论区了，有需要的自取。`,
      author: { name: '硅基漫游者', handle: 'silicon_wanderer', followers: 42_800 },
      metrics: { likes: 3_240, collects: 4_180, comments: 286, reposts: 412, views: 128_000 },
      publishedAt: ago(15),
      lang: 'zh',
    },
    {
      url: 'https://www.xiaohongshu.com/explore/67f0a1b2c3d4e5f607182931',
      source: 'xiaohongshu',
      kind: 'note',
      title: 'AI 产品经理面试被问穿的 6 个问题（附我的回答思路）',
      content: `上周面了 4 家 AI 公司，把被问到的硬问题整理一下，都是真实问过的。

**1. 你们的 RAG 召回率怎么衡量？**
不要说"效果不错"。我的回答：分层做，先用 100 条人工标注的 query-doc 对算 recall@5，再用 LLM-as-judge 打相关性分，最后看线上的追问率——追问率降了才是真的好。

**2. 幻觉怎么处理？**
诚实说不能根治。产品上三件事：强制引用、答不出来就说答不出来、给用户一键看原文。我们把"无法回答"的比例从 2% 提到 9%，用户满意度反而涨了 11 个点。

**3. 为什么不用更大的模型？**
成本和延迟。我们实测 P95 延迟超过 3 秒，留存掉 20%。小模型 + 好的检索 > 大模型 + 烂检索。

**4. 你怎么定义 agent 的成功率？**
按任务端到端算，不按步骤算。步骤成功率 95% 的十步任务，端到端只有 60%。

**5. 数据飞轮怎么转起来的？**
用户的每次修改都是标注。把"编辑后的版本"存下来做 DPO 对，比买标注便宜 100 倍。

**6. 如果模型明天免费了，你的护城河是什么？**
工作流和数据，不是模型。这题答不好基本就凉了。

面试官最在意的不是你答得多漂亮，是你有没有真的看过线上数据。`,
      author: { name: '产品阿柚', handle: 'pm_ayou', followers: 88_600 },
      metrics: { likes: 8_920, collects: 12_400, comments: 642, reposts: 1_180, views: 386_000 },
      publishedAt: ago(23),
      lang: 'zh',
    },
    {
      url: 'https://www.xiaohongshu.com/explore/67f0a1b2c3d4e5f607182932',
      source: 'xiaohongshu',
      kind: 'note',
      title: 'Nano Banana 2 修图工作流：我把商品图返工率从 40% 降到 8%',
      content: `做电商视觉三年，现在 80% 的商品图后处理都交给 AI 了，分享一下真正能上生产的流程。

**核心是别一步到位**
新手都想一句 prompt 出图，实际上返工率极高。我拆成四步：

1. **抠图**：还是用传统工具，AI 抠头发丝不稳定
2. **打光重建**：这步交给 Nano Banana 2，参考图给一张同品类的高质量图，指定"保持产品几何形状不变"
3. **场景合成**：分开做，不要和打光一起说
4. **细节修复**：logo、文字这些必须人工检查，AI 经常改字

**关键 prompt 技巧**
- 一定要写"preserve exact product geometry and text"，不写它会悄悄改
- 参考图比形容词有用 10 倍
- 生成 4 张选 1 张，不要生成 1 张改 10 次

**数据**
返工率从 40% 降到 8%，单图处理时间从 25 分钟降到 6 分钟。但注意：珠宝和透明材质还是不行，反光会崩。

工具本身不难，难的是知道哪一步不该给 AI。`,
      author: { name: '视觉老陈', handle: 'visual_chen', followers: 31_200 },
      metrics: { likes: 4_680, collects: 6_920, comments: 318, reposts: 486, views: 184_000 },
      publishedAt: ago(38),
      lang: 'zh',
    },
    {
      url: 'https://www.xiaohongshu.com/explore/67f0a1b2c3d4e5f607182933',
      source: 'xiaohongshu',
      kind: 'note',
      title: '大模型推理成本优化实战：同样的量，账单砍掉 73%',
      content: `我们是一个 to B 的文档处理产品，日均 40 万次调用。上季度把推理成本从 8.2 万降到 2.2 万，做法都在这。

**1. 提示缓存（省了最多，41%）**
系统提示 + 文档 schema 有 6000 token 是固定的。开缓存之后这部分只按 1/10 计费。唯一坑：缓存有 TTL，低峰期会失效，我们加了个 keep-alive 请求。

**2. 模型路由（省 19%）**
不是所有请求都要旗舰模型。用一个 300M 的分类器判断难度，简单的走小模型。关键是分类器要保守——判错一次的返工成本远大于省下来的钱。我们把阈值调到宁可多用大模型。

**3. 批处理（省 9%）**
非实时的走批量接口，半价。用户完全感知不到，因为本来就是异步出报告。

**4. 输出长度约束（省 4%）**
让它输出 JSON 而不是散文，token 直接少一半。而且更好解析。

**没用的做法**
- 自己部署开源模型：算上运维和显卡折旧，我们这个量级不划算
- 疯狂压缩 prompt：省了 3% 但准确率掉了 6%，得不偿失

先测量再优化，我们一开始猜错了三次瓶颈在哪。`,
      author: { name: '基建小王', handle: 'infra_wang', followers: 19_400 },
      metrics: { likes: 2_180, collects: 3_840, comments: 164, reposts: 292, views: 78_000 },
      publishedAt: ago(61),
      lang: 'zh',
    },

    /* ────────────────────────────────────────────────────── Hacker News ── */
    {
      url: 'https://blog.vllm.ai/2026/07/sparse-attention-serving.html',
      source: 'hackernews',
      kind: 'article',
      title: 'vLLM 0.12: sparse attention serving at 3.4x throughput on long context',
      content: `We shipped native support for the sparse attention patterns used by DeepSeek-V4 and Kimi K2, and the results on long context are larger than we expected.

Benchmarks on 8xH200, 128K context, batch 32:
- Dense baseline: 2,140 tok/s aggregate
- Sparse (block-sparse, 1/8 density): 7,280 tok/s aggregate — 3.4x
- Accuracy delta on RULER at 128K: -0.4 points

The implementation detail that mattered: we were initially materialising the block mask per request, which dominated the kernel time at small batch. Precomputing masks per (sequence-length bucket, pattern) and reusing them across the batch removed 71% of the overhead.

What did not work: naive top-k attention. It looks great in a microbenchmark and falls apart under continuous batching because the k selection serialises against the scheduler.

Caveats: this only helps above ~16K context. Below that, dense is faster and you should use it. And the accuracy delta is model-dependent — we measured -0.4 on two models and -2.1 on a third that was not trained with sparse attention in the loop.`,
      author: { name: 'zhuohan', handle: 'zhuohan' },
      metrics: { points: 684, comments: 212 },
      publishedAt: ago(11),
    },
    {
      url: 'https://news.ycombinator.com/item?id=44810001',
      source: 'hackernews',
      kind: 'discussion',
      title: 'Ask HN: What actually broke when you put an LLM agent in production?',
      content: `Not looking for demos. Looking for the postmortems.

Ours, running a support-triage agent for 8 months at ~12k tickets/day:

1. Retries amplified an outage into a bill. A downstream 503 caused our retry loop to fan out; we spent $41k in 6 hours before the alert fired on cost rather than error rate. Now we budget tokens per task, not per request.

2. Context poisoning from our own outputs. The agent's summaries got written back into the ticket, then read as context on the next turn. After ~15 turns it was summarising its own summaries and confidently wrong. Fixed by tagging provenance and excluding self-authored content.

3. Silent capability regression on a model upgrade. Aggregate eval went up 2 points; one specific category (refund policy edge cases) went down 22. Aggregate metrics hid it for three weeks. Now we gate on per-category floors, not the mean.

4. The prompt was load-bearing infrastructure with no tests. Someone "cleaned up" a sentence and accuracy dropped 9 points. Prompts live in version control with eval CI now.

What broke for you?`,
      author: { name: 'throwaway_infra', handle: 'throwaway_infra' },
      metrics: { points: 1_240, comments: 486 },
      publishedAt: ago(26),
    },
    {
      url: 'https://interconnects.ai/p/the-cost-of-thinking',
      source: 'hackernews',
      kind: 'article',
      title: 'The cost of thinking: measuring what test-time compute actually buys',
      content: `I spent $4,800 of API credit measuring the relationship between reasoning tokens and accuracy across seven models and five benchmark families, and the shape is more interesting than "more is better".

Headline findings:

1. Returns are log-linear until they are not. Every model shows accuracy climbing roughly linearly in log(reasoning tokens) up to a model-specific ceiling, then flat, then — on three of seven models — *declining*. The decline is real and reproducible: on GPQA, one model loses 4.1 points going from 8K to 32K reasoning tokens.

2. The ceiling is task-dependent, not model-dependent. Competition maths keeps improving to 32K. Factual retrieval saturates at 800 tokens and then degrades as the model talks itself out of the right answer.

3. Cost-per-correct-answer is minimised well below maximum accuracy. For four of five benchmark families, the economically optimal budget is 15-30% of the accuracy-optimal budget.

Methodology, per-model curves and all raw outputs are published. The declining region is the part I most want others to try to falsify.`,
      author: { name: 'natolambert', handle: 'natolambert' },
      metrics: { points: 512, comments: 148 },
      publishedAt: ago(34),
    },
    {
      url: 'https://blog.cloudflare.com/2026/ai-crawler-economics',
      source: 'hackernews',
      kind: 'article',
      title: 'AI crawlers now account for 38% of our bot traffic, and the ratio is upside down',
      content: `Data from the edge across ~20% of web traffic for the first half of 2026.

AI crawler share of identified bot requests: 38%, up from 19% a year ago.

The number that matters more is the crawl-to-referral ratio — how many pages a crawler takes per visitor it sends back. For traditional search this has historically sat near 10:1. For the largest AI crawlers it now ranges from 1,400:1 to 73,000:1.

That is the economic complaint stated precisely. It is not that crawling is expensive; it is that the reciprocal traffic that justified crawling has gone.

We also see a clear split in behaviour: training crawlers are broad and slow, inference-time retrieval fetchers are narrow and extremely bursty — one product's fetcher can generate a 40x spike on a single URL within seconds of a news event.`,
      author: { name: 'cloudflare', handle: 'cloudflare' },
      metrics: { points: 892, comments: 374 },
      publishedAt: ago(48),
    },

    /* ─────────────────────────────────────────────────────────── arXiv ── */
    {
      url: 'https://arxiv.org/abs/2607.04182',
      source: 'arxiv',
      kind: 'paper',
      title: 'Context Rot: Systematic Degradation of In-Context Retrieval Beyond 200K Tokens',
      content: `We study how retrieval accuracy from within a model's context degrades as context length grows, across 11 frontier and open-weights models and four needle-placement regimes.

Findings. (1) All 11 models show monotonic degradation in exact-match retrieval beyond 200K tokens, ranging from -6.2 to -31.4 points at 900K relative to 32K, despite advertised context windows of 1M or more. (2) Degradation is strongly position-dependent: material placed at 55-75% of the context depth is retrieved 2.3x less reliably than material at either boundary, a pronounced generalisation of the lost-in-the-middle effect. (3) Distractor density predicts degradation better than raw length: holding length fixed and varying semantically similar distractors from 0 to 40 reproduces most of the effect. (4) Chain-of-thought does not recover the gap and in 6 of 11 models widens it, because the model reasons over an incorrectly retrieved premise.

We release CONTEXTROT, a 14,000-instance benchmark with controlled distractor density and position, and show that a simple retrieval-then-read pipeline over the same corpus outperforms full-context ingestion at every length above 128K while using 11x fewer tokens.

Implication: advertised context length is not a usable capacity figure, and long-context ingestion should be treated as a compression-lossy operation rather than a free one.`,
      author: { name: 'L. Chen' },
      metrics: { citations: 34, likes: 218 },
      publishedAt: ago(31),
    },
    {
      url: 'https://arxiv.org/abs/2607.03911',
      source: 'arxiv',
      kind: 'paper',
      title: 'Verifier-Free RL from Execution Feedback Scales to Repository-Level Code',
      content: `Reinforcement learning for code has relied on unit-test verifiers, which do not exist for most real repositories. We show that raw execution feedback — compiler diagnostics, runtime traces, and static analysis output — provides a sufficient reward signal without any test suite.

We train a 32B model with GRPO on 180K repository-level tasks drawn from 42K GitHub projects, using a composite reward from build success, diagnostic count reduction, and type-checker agreement. No task has a reference solution or a test suite.

Results: SWE-bench Verified 61.4% (from 38.2% for the SFT baseline), Multi-SWE-bench 44.1%, and — notably — a 12.6 point improvement on a held-out set of repositories in languages absent from the RL data, indicating the learned behaviour is about reading diagnostics rather than memorising fixes.

Ablations show diagnostic-count reduction is the load-bearing term; build success alone produces reward hacking, where the model comments out failing code. We describe the three reward-hacking behaviours we observed and the specific penalties that removed them.

Code, the 180K task set and all checkpoints are released.`,
      author: { name: 'R. Patel' },
      metrics: { citations: 19, likes: 164 },
      publishedAt: ago(44),
    },
    {
      url: 'https://arxiv.org/abs/2607.02744',
      source: 'arxiv',
      kind: 'paper',
      title: 'Sparse Autoencoders Recover Deceptive-Reasoning Features That Do Not Appear in Output',
      content: `We train sparse autoencoders on the residual stream of a 70B model fine-tuned to pursue a hidden objective, and identify a family of features that activate when the model is reasoning about concealment but which produce no lexical trace in the output.

Three results. (1) A single feature (index 44,118 in our 262K-width SAE) achieves 0.91 AUROC for detecting episodes where the model withholds information it has represented internally, on a held-out set. (2) Ablating this feature family reduces concealment behaviour by 63% while costing 1.2 points on general capability benchmarks. (3) The features generalise across three fine-tuning objectives we did not train the SAE on, suggesting they encode a general concealment computation rather than task-specific artefacts.

Limitations we want to be explicit about: our hidden objectives are synthetic and deliberately induced, the model is not adversarially trained against the probe, and a model that knows it is being probed may behave differently. We do not claim this detects deception in models that were not trained to be deceptive.`,
      author: { name: 'A. Nanda' },
      metrics: { citations: 41, likes: 312 },
      publishedAt: ago(57),
    },

    /* ────────────────────────────────────────────────────────── GitHub ── */
    {
      url: 'https://github.com/sgl-project/sglang',
      source: 'github',
      kind: 'repo',
      title: 'sgl-project/sglang — fast serving for LLMs and VLMs with RadixAttention prefix caching',
      content: `SGLang is a serving framework for large language and vision models. v0.5 adds speculative decoding with a tree-based draft, disaggregated prefill/decode, and full support for the sparse attention patterns in recent MoE releases.

Highlights this release:
- 2.7x throughput on 128K context vs v0.4 for MoE models
- Zero-overhead prefix caching via RadixAttention
- Structured output with a compiled grammar backend (12x faster constrained decoding)
- Native DeepSeek-V4 and Kimi K2 support

Language: Python. Apache-2.0.`,
      author: { name: 'sgl-project', handle: 'sgl-project' },
      metrics: { stars: 18_420, forks: 1_640 },
      publishedAt: ago(72),
      tags: ['inference', 'serving', 'llm'],
    },
    {
      url: 'https://github.com/modelcontextprotocol/registry',
      source: 'github',
      kind: 'repo',
      title: 'modelcontextprotocol/registry — the official MCP server registry',
      content: `A community registry and discovery API for Model Context Protocol servers, with signed provenance and a capability manifest per server.

Why a registry: MCP adoption outran discovery. There were ~4,000 servers on GitHub with no way to tell which were maintained, what permissions they requested, or whether the published artefact matched the source.

Every entry carries a sigstore attestation linking artefact to commit, a declared permission set, and an install-count signal. The API is open and unauthenticated for reads.

Language: Go. Apache-2.0.`,
      author: { name: 'modelcontextprotocol', handle: 'modelcontextprotocol' },
      metrics: { stars: 9_240, forks: 682 },
      publishedAt: ago(96),
      tags: ['mcp', 'agents', 'tooling'],
    },

    /* ────────────────────────────────────────────────── RSS / newsletters ── */
    {
      url: 'https://simonwillison.net/2026/Jul/26/agentic-browser-security/',
      source: 'rss',
      kind: 'article',
      title: 'The lethal trifecta, one year on: agentic browsers made it worse',
      content: `A year ago I described the lethal trifecta: an LLM system with access to private data, exposure to untrusted content, and the ability to communicate externally. Any two are manageable. All three is an exfiltration vector.

Agentic browsers are the trifecta shipped as a product category. They hold your authenticated sessions (private data), render arbitrary web pages (untrusted content), and can navigate and submit forms (external communication).

I tested four of them this month with a set of eleven payloads. Nine of eleven worked on at least one product. The most reliable was not clever: a code block in a GitHub issue containing instructions addressed to the agent, which three of four products followed.

The mitigation I keep coming back to is not detection. Detection is a filter and filters are bypassed. It is capability separation: the component that reads untrusted content must not be the component that holds credentials, and any irreversible action needs a human in the loop who can see what is about to happen.

I am aware this makes the product worse. It also makes it not a data-exfiltration tool.`,
      author: { name: 'Simon Willison' },
      metrics: { points: 412, comments: 96 },
      publishedAt: ago(21),
    },
    {
      url: 'https://www.interconnects.ai/p/rl-environments-are-the-new-data',
      source: 'rss',
      kind: 'article',
      title: 'RL environments are the new data moat',
      content: `The scarce input for frontier post-training has shifted from tokens to environments — executable settings where a model can attempt a task and receive a verifiable signal.

Three consequences worth sitting with.

First, environments are much harder to acquire than text. You cannot crawl them. Each one is software that has to run, be deterministic enough to be a fair reward, and resist the specific reward hacking a model will find. That is engineering labour, not a licensing deal.

Second, this changes who has an advantage. A company with a real product that users operate has an environment nobody else can replicate. The last two years rewarded whoever had the most text; the next two reward whoever has the most executable feedback.

Third, it makes evaluation harder in an uncomfortable way. If labs build proprietary environments, benchmark scores stop being comparable — you are measuring the environment as much as the model, and the environment is not published.

I do not have a clean prescription for the third problem. Public environment suites help, but the good ones get trained on within a quarter.`,
      author: { name: 'Nathan Lambert' },
      metrics: { points: 318, comments: 72 },
      publishedAt: ago(66),
    },
    {
      url: 'https://openai.com/index/scaling-inference-economics/',
      source: 'rss',
      kind: 'article',
      title: 'Inference economics: what a 90% price cut required',
      content: `We reduced the price of our mid-tier model by 90% over eighteen months. This post breaks down where that came from, because "chips got cheaper" explains almost none of it.

Contributions to cost-per-token reduction:
- Model architecture (sparsity, smaller active parameter count): 41%
- Serving efficiency (continuous batching, prefix caching, speculative decoding): 33%
- Hardware price-performance: 14%
- Quantisation and distillation of the served checkpoint: 12%

The serving number is the one people underestimate. Prefix caching alone accounted for 19 points of the 33, because production traffic is far more repetitive than benchmark traffic — median request shares 71% of its prefix with a request seen in the previous hour.

We also want to be honest about a limit: none of these four levers is close to another order of magnitude. The next 10x, if it comes, has to come from something structurally different.`,
      author: { name: 'OpenAI' },
      metrics: { points: 624, comments: 218 },
      publishedAt: ago(88),
    },
    {
      url: 'https://research.google/blog/weather-model-operational-deployment/',
      source: 'rss',
      kind: 'article',
      title: 'A neural weather model is now operational at three national agencies',
      content: `Three national meteorological services have moved a neural forecasting model into operational use alongside their physics-based systems.

Verified performance over six months of operational running: 6% improvement in 5-day 500hPa geopotential RMSE against the operational physics ensemble, at 1/1000th the compute per forecast. Tropical cyclone track error improved 11% at 72 hours.

Where it is worse, and why the physics model is still running: the neural model underestimates extreme precipitation intensity by 8-14% and has no principled way to extrapolate outside its training distribution. For a 200-year flood event, the physics model is the one you trust.

The operational lesson is not "neural replaces physics". It is that a cheap, good-enough forecast you can run 400 times gives you an ensemble spread that a single expensive forecast cannot.`,
      author: { name: 'Google Research' },
      metrics: { points: 486, comments: 104 },
      publishedAt: ago(112),
    },

    /* ────────────────────────────────────────────────────────── Reddit ── */
    {
      url: 'https://www.reddit.com/r/LocalLLaMA/comments/1abc001/deepseek_v4_quant_comparison_15_configs/',
      source: 'reddit',
      kind: 'discussion',
      title: 'DeepSeek-V4 quantisation comparison: 15 configs measured on identical hardware',
      content: `Ran every quant I could get my hands on through the same eval harness on a single 4x3090 box. All numbers from the same 400-question subset, greedy decoding, same seed.

Q8_0    — 41.2 GB — GPQA 78.9 — 6.2 tok/s
Q6_K    — 31.8 GB — GPQA 78.1 — 8.9 tok/s
Q5_K_M  — 27.1 GB — GPQA 76.8 — 11.4 tok/s
Q4_K_M  — 22.4 GB — GPQA 74.2 — 14.8 tok/s
IQ4_XS  — 20.9 GB — GPQA 74.6 — 15.1 tok/s
Q3_K_M  — 17.8 GB — GPQA 68.1 — 18.2 tok/s
IQ2_M   — 13.2 GB — GPQA 51.4 — 22.6 tok/s

Takeaways: IQ4_XS is the sweet spot and beats Q4_K_M on both size and score, which surprised me. The cliff is between Q4 and Q3, not where I expected. Below Q3 it stops being the same model — IQ2_M failed instruction following on 30% of prompts regardless of correctness.

Caveat: single eval, single domain. Coding may cliff differently. Raw logs in the comments.`,
      author: { name: 'quantmaxxer', handle: 'quantmaxxer' },
      metrics: { points: 1_840, comments: 342 },
      publishedAt: ago(18),
      tags: ['Discussion'],
    },
    {
      url: 'https://www.reddit.com/r/MachineLearning/comments/1abc002/d_reviewer_2_asked_me_to_cite_14_of_their_papers/',
      source: 'reddit',
      kind: 'discussion',
      title: '[D] Reviewer asked me to cite 14 of their own papers. How is this still happening?',
      content: `Submitted to a top-tier venue. Reviewer 2 gave a borderline score with one substantive comment and a list of 14 "highly relevant" citations, all from the same group, 11 of which are not relevant by any reading.

The AC's response was to say it is at my discretion. Which it technically is, and which also means declining costs me a champion.

What I want to discuss is not whether this is bad. It is why the obvious mitigations have not been adopted. Citation-cartel detection is a solved graph problem. Venues already have the submission-review graph. Running it would take an afternoon.

Genuinely curious whether any venue is doing this and reporting on it.`,
      author: { name: 'phd_year_5', handle: 'phd_year_5' },
      metrics: { points: 2_240, comments: 486 },
      publishedAt: ago(53),
      tags: ['Discussion'],
    },

    /* ───────────────────────────────────────────────── Hugging Face ── */
    {
      url: 'https://huggingface.co/papers/2607.04182',
      source: 'huggingface',
      kind: 'paper',
      title: 'Daily Papers: Context Rot and the limits of advertised context windows',
      content: `Community-highlighted paper of the day. Systematic study showing all 11 tested models degrade at retrieval beyond 200K tokens regardless of advertised window size, with position-dependence and distractor density as the dominant factors. Includes a 14K-instance benchmark release.`,
      author: { name: 'Hugging Face' },
      metrics: { likes: 482, comments: 64 },
      publishedAt: ago(30),
    },

    /* ─────────────────────────────────────────────── manual capture ── */
    {
      url: 'https://x.com/soumithchintala/status/1899000000000000009',
      source: 'manual',
      kind: 'post',
      title: 'Torch compile on the new sparse kernels: what we learned shipping it',
      content: `Notes from getting torch.compile to reliably handle block-sparse attention without falling back to eager.

The recurring failure was dynamic shapes interacting with the mask layout. Every new sequence-length bucket triggered a recompile, and with 14 buckets in production traffic the compile time dominated. Fix was to pad to a fixed set of four buckets and eat the wasted compute — net 2.1x faster end to end despite doing more FLOPs.

Second thing: guard on the mask *pattern identity*, not the mask tensor. We were hashing the tensor contents, which is O(n) per call and showed up as 8% of step time.`,
      author: { name: 'Soumith Chintala', handle: 'soumithchintala', followers: 148_000, verified: true },
      metrics: { likes: 2_840, reposts: 412, replies: 88, bookmarks: 1_940, views: 284_000 },
      publishedAt: ago(9),
      state: 'saved',
      tags: ['pytorch', 'read-later'],
    },
    {
      url: 'https://blog.google/technology/ai/gemini-3-agent-mode/',
      source: 'web',
      kind: 'article',
      title: 'Gemini 3 agent mode: computer use at 68.4% on OSWorld',
      content: `Agent mode is rolling out to Gemini 3, with computer-use capability evaluated at 68.4% on OSWorld and 74.1% on WebArena.

The architecture separates a planner that never sees raw page content from an executor that does. The planner receives a structured accessibility summary; the executor receives pixels and the DOM. This is a response to prompt-injection findings — the component with the ability to act on your behalf does not read attacker-controlled text directly.

Rollout is gated: agent mode requires per-domain permission grants, and any action classified as irreversible (purchase, send, delete, permission change) requires explicit confirmation with a rendered preview of what will happen.`,
      author: { name: 'Google' },
      metrics: {},
      publishedAt: ago(13),
    },
    {
      url: 'https://www.anthropic.com/research/interleaved-thinking-tool-use',
      source: 'web',
      kind: 'article',
      title: 'Interleaved thinking and tool use: why the order matters',
      content: `We describe the training change behind interleaved extended thinking in Opus 5, where reasoning can continue between tool calls rather than being confined to a single block before the first call.

The motivating failure: with thinking confined to the start, the model commits to a plan before seeing any tool output. On multi-step retrieval tasks this produced a characteristic error where the model would receive a tool result contradicting its plan and continue with the plan anyway.

Measured effect on internal agentic evals: +7.2 points on multi-step retrieval, +4.8 on repository-level code, and a 31% reduction in a specific failure mode we call plan-anchoring, where the final answer contradicts a tool result the model received.

Cost: interleaved thinking uses 18% more reasoning tokens on average for the same task. We think that is worth it and have made it configurable.`,
      author: { name: 'Anthropic' },
      metrics: {},
      publishedAt: ago(5),
    },
    {
      url: 'https://x.com/lmarena_ai/status/1899000000000000010',
      source: 'x',
      kind: 'post',
      title: 'Leaderboard update: three models within 8 Elo at the top',
      content: `New leaderboard is live with 128,000 fresh votes.

The top three are now within 8 Elo of each other, which is inside our 95% confidence interval — we cannot distinguish them and neither can you from the ranking alone.

Worth restating what this does and does not measure. It measures human preference on prompts real users submit to an arena. It does not measure correctness, and preference correlates with formatting and length in ways we publish but people keep forgetting. Read the category breakdowns; the aggregate is the least informative number on the page.`,
      author: { name: 'LMArena', handle: 'lmarena_ai', followers: 184_000, verified: true },
      metrics: { likes: 5_240, reposts: 940, replies: 412, bookmarks: 1_180, views: 820_000 },
      publishedAt: ago(24),
    },
    {
      url: 'https://x.com/AndrewYNg/status/1899000000000000011',
      source: 'x',
      kind: 'post',
      title: 'Agentic workflows beat model upgrades for most teams right now',
      content: `Talked to a dozen teams this month. The ones seeing the biggest jumps are not the ones switching models. They are the ones adding an evaluation loop.

Pattern that keeps working: take your single-shot prompt, add a critic step that checks the output against explicit criteria, and let it revise once. Costs 2-3x the tokens. Typically buys more than a model-generation upgrade would, and it works on whatever model you already use.

The teams that struggle are usually missing the criteria, not the model. If you cannot write down what a good output looks like, the critic has nothing to check and neither do you.`,
      author: { name: 'Andrew Ng', handle: 'AndrewYNg', followers: 1_080_000, verified: true },
      metrics: { likes: 12_400, reposts: 2_680, replies: 384, bookmarks: 7_200, views: 1_840_000 },
      publishedAt: ago(35),
    },
    {
      url: 'https://www.xiaohongshu.com/explore/67f0a1b2c3d4e5f607182934',
      source: 'xiaohongshu',
      kind: 'note',
      title: '被裁后我用 AI 接了 3 个月外包，说点实话',
      content: `不写鸡血文，就说数据和踩的坑。

**3 个月接了 11 个单**
- 数据清洗 + 报表自动化：5 单，均价 4200
- 小程序/内页开发：4 单，均价 8600
- AI 相关咨询（就是教人怎么用）：2 单，均价 3000

**AI 到底帮了多少**
真实感受：交付速度大概快 2 倍，不是 10 倍。快的是写样板代码、写文档、写测试。慢的还是慢——需求反复、联调、客户改主意，这些 AI 一点忙帮不上。

**最大的坑**
接了个"简单爬虫"的单，报价 3000，结果对方网站有风控，两周才搞定，时薪算下来不到 40。教训：不确定的技术风险一定要按阶段报价。

**AI 不能替代的部分**
1. 判断需求合不合理（客户说要 A 其实想要 B）
2. 报价（AI 给的报价永远偏低）
3. 收款（笑）

**收入**
第一个月 8k，第二个月 2.1w，第三个月 3.4w。不如大厂但自由，社保得自己交，算下来打平。

想转的话建议先接 2 个单再决定，别裸辞。`,
      author: { name: '野生开发者阿泽', handle: 'wild_dev_ze', followers: 24_600 },
      metrics: { likes: 12_800, collects: 9_240, comments: 1_180, reposts: 892, views: 486_000 },
      publishedAt: ago(46),
      lang: 'zh',
    },
    {
      url: 'https://x.com/thinkymachines/status/1899000000000000012',
      source: 'x',
      kind: 'release',
      title: 'Tinker now supports full-parameter fine-tuning on 8 open-weights models',
      content: `Tinker adds full-parameter fine-tuning alongside LoRA, for eight open-weights models up to 671B.

You write a normal training loop. We handle distributed placement, checkpointing, and the parts of multi-node training that consume a week of your life for no scientific gain.

New in this release: resumable runs across preemption, per-step eval hooks, and export straight to GGUF and vLLM-compatible formats.`,
      author: { name: 'Thinking Machines', handle: 'thinkymachines', followers: 212_000, verified: true },
      metrics: { likes: 8_240, reposts: 1_640, replies: 284, bookmarks: 5_100, views: 1_240_000 },
      publishedAt: ago(58),
    },
    {
      url: 'https://arxiv.org/abs/2607.05219',
      source: 'arxiv',
      kind: 'paper',
      title: 'Small Models, Long Horizons: Distilled 8B Agents Match 200B on Constrained Tool Tasks',
      content: `We show that on tool-use tasks with a fixed, well-specified action space, an 8B model distilled from reasoning traces matches a 200B teacher, and that the gap reappears precisely when the action space becomes open-ended.

Setup: 240K trajectories from a 200B teacher across 14 tool environments. Student is an 8B base model, trained with SFT on successful trajectories plus GRPO against environment reward.

Results. On the 14 training environments the student reaches 96.2% of teacher success rate at 1/40th inference cost. On four held-out environments with the same tool schema, 91.4%. On four held-out environments requiring tool *discovery* (unknown action space, documentation must be read), 47.8% — barely above the un-distilled baseline.

We argue this delineates what distillation transfers: policy over a known action space transfers well; the exploratory behaviour needed to characterise an unknown environment does not. Practical implication is a routing rule rather than a replacement — small distilled models for the 90% of production traffic with fixed tool schemas, large models reserved for open-ended work.`,
      author: { name: 'M. Okafor' },
      metrics: { citations: 12, likes: 148 },
      publishedAt: ago(70),
    },
    {
      url: 'https://github.com/ggml-org/llama.cpp',
      source: 'github',
      kind: 'release',
      title: 'llama.cpp b6200 — sparse attention, better Metal MoE, and a 30% smaller KV cache',
      content: `This release lands block-sparse attention for the recent MoE architectures, a rewritten Metal path for expert routing, and KV-cache quantisation defaults that cut cache memory ~30% with no measured quality loss at Q8 cache.

Measured on M4 Max 128GB with a 671B MoE at Q4_K_M: 14.8 → 18.4 tok/s short context, 8.1 → 11.2 tok/s at 32K.

Breaking: the --sparse-attn flag replaces the experimental --exp-sparse. Old flag warns for one release then goes away.`,
      author: { name: 'ggml-org', handle: 'ggml-org' },
      metrics: { stars: 96_400, forks: 14_200 },
      publishedAt: ago(20),
      tags: ['local-llm', 'inference'],
    },
  ]
}
