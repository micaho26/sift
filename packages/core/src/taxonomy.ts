/**
 * The AI-domain lexicon that turns raw text into structured signal.
 *
 * Two jobs:
 *  1. `classifyTopics` — assign items to a stable topic taxonomy so trends are
 *     comparable over time (an LLM's ad-hoc labels are not). The same function
 *     also classifies search *queries*, which is how conceptual search works with
 *     no neural model — so each term list deliberately mixes the vocabulary of
 *     announcements ("quantization", "throughput") with the vocabulary of
 *     questions ("cheaper to run", "本地跑"). Both must hit the same topic id.
 *  2. `extractEntities` — recognise models, labs, people, benchmarks and
 *     concepts, which drive the entity cloud, novelty detection and filters.
 *
 * Dictionary-first on purpose: it is deterministic, instant, works offline, and
 * costs nothing — the LLM is reserved for prose, not for labelling.
 */
import type { Entity, EntityType } from './types.js'

export type TopicDef = {
  id: string
  label: string
  labelZh: string
  /** Lucide icon name for the UI. */
  icon: string
  /**
   * Vocabulary that appears in *documents*. Precise on purpose — these decide
   * how an item is filed, and a loose term here mislabels the whole corpus.
   */
  terms: string[]
  /**
   * Vocabulary that appears in *queries*. Deliberately loose: "cheaper to run",
   * "memory", "score". Used only to expand a search, never to classify an item —
   * a word broad enough to catch how people ask is far too broad to file by.
   */
  querySynonyms?: string[]
}

export const TOPICS: TopicDef[] = [
  {
    id: 'foundation-models',
    label: 'Foundation Models',
    labelZh: '基础模型',
    icon: 'brain-circuit',
    terms: ['foundation model', 'frontier model', 'llm', 'large language model', 'base model', 'pretraining', 'pre-training', 'scaling law', 'flagship model', '大模型', '基础模型', '预训练'],
    querySynonyms: ['new model', 'model release', 'flagship', 'frontier', '新模型', '旗舰'],
  },
  {
    id: 'reasoning',
    label: 'Reasoning',
    labelZh: '推理能力',
    icon: 'lightbulb',
    terms: ['reasoning model', 'chain of thought', 'chain-of-thought', 'test-time compute', 'inference-time scaling', 'thinking tokens', 'deliberate', 'self-consistency', 'tree of thought', 'extended thinking', '思维链', '推理模型', '慢思考'],
    querySynonyms: ['thinking', 'how much thinking', 'reasoning tokens', 'deliberation', 'step by step', 'slow thinking', 'think longer', '推理预算'],
  },
  {
    id: 'agents',
    label: 'Agents',
    labelZh: '智能体',
    icon: 'bot',
    terms: ['ai agent', 'agentic', 'agent framework', 'tool use', 'tool calling', 'function calling', 'multi-agent', 'autonomous agent', 'computer use', 'browser use', 'mcp', 'model context protocol', 'a2a', 'agent2agent', 'orchestration', '智能体', '多智能体', '工具调用'],
    querySynonyms: ['agent harness', 'scaffold', 'tool schema', 'agent loop', 'autonomous', 'delegate', 'assistant that acts', 'browser agent', 'agentic browser', 'computer control', '工具编排', '自动化'],
  },
  {
    id: 'coding',
    label: 'AI Coding',
    labelZh: 'AI 编程',
    icon: 'terminal',
    terms: ['ai coding', 'code generation', 'copilot', 'cursor', 'code assistant', 'swe-bench', 'pull request agent', 'vibe coding', 'codegen', 'pair programming', 'claude code', 'codex', 'devin', 'antigravity', '代码生成', 'ai 编程', '编程助手'],
    querySynonyms: ['coding agent', 'write code', 'fix bugs', 'pull request', 'refactor', 'code review', 'autocomplete', '写代码', '改bug'],
  },
  {
    id: 'multimodal',
    label: 'Multimodal',
    labelZh: '多模态',
    icon: 'images',
    terms: ['multimodal', 'vision language', 'vlm', 'ocr', 'document understanding', 'any-to-any', 'omni', 'visual reasoning', '多模态', '视觉语言'],
    querySynonyms: ['image understanding', 'read screenshots', 'analyse image', '看图', '识图'],
  },
  {
    id: 'genmedia',
    label: 'Generative Media',
    labelZh: '生成式媒体',
    icon: 'clapperboard',
    terms: ['text to image', 'text-to-image', 'text to video', 'text-to-video', 'image generation', 'video generation', 'diffusion model', 'flow matching', 'image editing', 'inpainting', 'upscaler', 'lora', '文生图', '文生视频', '图像生成', '视频生成'],
    querySynonyms: ['make images', 'generate video', 'edit photo', 'restyle', '出图', '生成视频', '修图'],
  },
  {
    id: 'voice',
    label: 'Voice & Audio',
    labelZh: '语音音频',
    icon: 'audio-lines',
    terms: ['text to speech', 'speech to text', 'asr', 'voice clone', 'voice agent', 'realtime voice', 'speech model', 'music generation', 'audio model', '语音合成', '语音识别', '语音克隆'],
    querySynonyms: ['speech', 'voice', 'tts', 'transcribe', '语音', '转写'],
  },
  {
    id: 'rag',
    label: 'RAG & Retrieval',
    labelZh: '检索增强',
    icon: 'library',
    terms: ['rag', 'retrieval augmented', 'retrieval-augmented', 'vector database', 'vector search', 'embedding model', 'reranker', 'hybrid search', 'semantic search', 'knowledge graph', 'graphrag', 'context engineering', '向量数据库', '检索增强', '语义检索'],
    querySynonyms: ['search my notes', 'ask my documents', 'citations', 'grounding', 'retrieve', 'chunking', 'knowledge base', 'index my', '问答', '知识库', '引用'],
  },
  {
    id: 'posttraining',
    label: 'Post-training & RL',
    labelZh: '后训练与强化学习',
    icon: 'target',
    terms: ['fine-tuning', 'finetune', 'sft', 'rlhf', 'rlaif', 'dpo', 'ppo', 'grpo', 'reward model', 'preference optimization', 'post-training', 'instruction tuning', 'distillation', 'reinforcement learning', '强化学习', '后训练'],
    querySynonyms: ['train my own', 'fine tune', 'custom model', 'distill', '训练', '微调', '蒸馏'],
  },
  {
    id: 'efficiency',
    label: 'Inference & Efficiency',
    labelZh: '推理与效率',
    icon: 'gauge',
    terms: ['quantization', 'quantized', 'gguf', 'awq', 'gptq', 'speculative decoding', 'kv cache', 'flash attention', 'flashattention', 'paged attention', 'vllm', 'sglang', 'tensorrt', 'throughput', 'tokens per second', 'latency', 'batch inference', 'moe', 'mixture of experts', 'sparse attention', '量化', '推理加速', '混合专家'],
    querySynonyms: ['cost per token', 'cheaper', 'cheap', 'expensive', 'price cut', 'pricing', 'cost reduction', 'save money', 'cost optimisation', 'cost optimization', 'faster inference', 'speed up', 'runs faster', 'serving cost', 'gpu cost', 'token cost', 'bill', 'budget', '降本', '成本', '便宜', '省钱', '加速'],
  },
  {
    id: 'hardware',
    label: 'Chips & Compute',
    labelZh: '芯片与算力',
    icon: 'cpu',
    terms: ['gpu', 'tpu', 'h100', 'h200', 'b200', 'gb200', 'blackwell', 'rubin', 'mi300', 'mi350', 'trainium', 'inferentia', 'npu', 'datacenter', 'data center', 'cluster', 'hbm', 'interconnect', 'nvlink', 'compute budget', 'wafer', '算力', '芯片', '显卡', '数据中心'],
    querySynonyms: ['how many gpus', 'vram', 'memory', 'fits on', 'runs on', '显存', '几张卡'],
  },
  {
    id: 'local-ai',
    label: 'Local & On-device',
    labelZh: '本地与端侧',
    icon: 'laptop',
    terms: ['on-device', 'local llm', 'ollama', 'llama.cpp', 'llamacpp', 'mlx', 'edge ai', 'small language model', 'slm', 'offline model', 'apple silicon', 'lm studio', '本地部署', '端侧', '离线模型'],
    querySynonyms: ['run locally', 'on my laptop', 'my mac', 'offline', 'no api key', 'private', 'self-host', 'self hosted', 'macbook', '本地跑', '自己部署', '离线'],
  },
  {
    id: 'openweights',
    label: 'Open Weights',
    labelZh: '开源权重',
    icon: 'unlock',
    terms: ['open weights', 'open-weight', 'open source model', 'apache 2.0 license model', 'weights released', 'model release', 'huggingface release', '开源模型', '权重开源'],
    querySynonyms: ['open source', 'open sourced', 'weights available', 'download the model', 'free model', '开源', '权重下载'],
  },
  {
    id: 'evals',
    label: 'Evals & Benchmarks',
    labelZh: '评测与基准',
    icon: 'clipboard-check',
    terms: ['benchmark', 'evaluation', 'evals', 'leaderboard', 'arena', 'elo', 'state of the art', 'sota', 'ablation', 'contamination', 'saturated benchmark', '评测', '基准测试', '排行榜'],
    querySynonyms: ['how good is', 'compare models', 'which model is best', 'score', 'accuracy', 'beats', 'outperforms', 'regression', 'win rate', '对比', '谁更强', '跑分'],
  },
  {
    id: 'safety',
    label: 'Safety & Alignment',
    labelZh: '安全与对齐',
    icon: 'shield',
    terms: ['ai safety', 'alignment', 'jailbreak', 'prompt injection', 'red team', 'red-teaming', 'guardrail', 'refusal', 'misalignment', 'sandbagging', 'deceptive alignment', 'constitutional ai', 'sycophancy', 'model welfare', '对齐', 'ai 安全', '越狱', '提示注入'],
    querySynonyms: ['data leak', 'leaking', 'leak my data', 'exfiltration', 'exfiltrate', 'steal data', 'confused deputy', 'lethal trifecta', 'untrusted content', 'sandbox', 'permission', 'least privilege', '攻击', '泄露', '数据泄露', '越权'],
  },
  {
    id: 'interpretability',
    label: 'Interpretability',
    labelZh: '可解释性',
    icon: 'microscope',
    terms: ['interpretability', 'mechanistic interp', 'sparse autoencoder', 'feature steering', 'activation patching', 'circuit', 'probing', 'attribution graph', '可解释性', '机制可解释'],
    querySynonyms: ['why does the model', 'inside the model', 'features', 'probe', '可解释'],
  },
  {
    id: 'robotics',
    label: 'Robotics & Embodied',
    labelZh: '机器人与具身',
    icon: 'bot-message-square',
    terms: ['robotics', 'embodied ai', 'vla', 'vision language action', 'manipulation', 'teleoperation', 'sim2real', 'autonomous driving', 'self-driving', 'world model', '具身智能', '人形机器人', '自动驾驶'],
    querySynonyms: ['robot', 'humanoid', 'embodied', 'self driving', '机器人', '具身'],
  },
  {
    id: 'science',
    label: 'AI for Science',
    labelZh: 'AI for Science',
    icon: 'flask-conical',
    terms: ['alphafold', 'drug discovery', 'materials discovery', 'weather model', 'ai for science', 'theorem proving', 'lean', 'formal verification', 'math olympiad', '科学智能', '蛋白质', '药物发现'],
    querySynonyms: ['protein', 'drug', 'materials', 'weather', 'math proof', '科学'],
  },
  {
    id: 'policy',
    label: 'Policy & Regulation',
    labelZh: '政策与监管',
    icon: 'scale',
    terms: ['eu ai act', 'executive order', 'export control', 'copyright lawsuit', 'antitrust', 'governance', 'sb 1047', 'chip ban', '监管', '政策', '出口管制'],
    querySynonyms: ['is it legal', 'compliance', 'regulation', 'lawsuit', 'copyright', 'ban', '法律', '合规'],
  },
  {
    id: 'business',
    label: 'Funding & Business',
    labelZh: '融资与商业',
    icon: 'trending-up',
    terms: ['funding round', 'series a', 'series b', 'series c', 'series d', 'acquisition', 'acquires', 'acqui-hire', 'ipo', 'arr', 'revenue run rate', 'layoff', 'enterprise deal', '融资', '估值', '收购', '商业化'],
    querySynonyms: ['revenue', 'pricing change', 'raised', 'funding', 'acquired', 'layoffs', 'valuation', '商业模式', '变现'],
  },
  {
    id: 'product',
    label: 'Products & Launches',
    labelZh: '产品与发布',
    icon: 'rocket',
    terms: ['launch', 'now available', 'general availability', 'beta', 'waitlist', 'ships today', 'introducing', 'announcing', 'rolling out', 'app update', '内测', '公测'],
    querySynonyms: ['launched', 'new feature', 'available now', 'rollout', '发布', '上线'],
  },
  {
    id: 'research',
    label: 'Research & Papers',
    labelZh: '论文与研究',
    icon: 'file-text',
    terms: ['arxiv', 'neurips', 'icml', 'iclr', 'cvpr', 'acl', 'emnlp', 'siggraph', 'accepted at', 'we propose', 'novel architecture', '预印本'],
    querySynonyms: ['paper', 'new paper', 'preprint', 'study', 'findings', '论文', '研究'],
  },
  {
    id: 'engineering',
    label: 'Prompting & Engineering',
    labelZh: '提示与工程',
    icon: 'wrench',
    terms: ['prompt engineering', 'few-shot', 'json mode', 'prompt caching', 'long context', 'token cost', 'observability', 'llmops', 'evaluation harness', '提示工程', '系统提示', '长上下文'],
    querySynonyms: ['prompt', 'system prompt', 'context window', 'how do I prompt', 'structured output', 'json output', 'caching', '提示词', '上下文'],
  },
]

export const TOPIC_BY_ID = new Map(TOPICS.map((t) => [t.id, t]))

/* ------------------------------------------------------------- entity dict -- */

type EntityDef = {
  name: string
  type: EntityType
  aliases: string[]
  /** Require exact case — for short/ambiguous acronyms like "MCP", "R1". */
  caseSensitive?: boolean
}

const ENTITIES: EntityDef[] = [
  // --- labs & companies -------------------------------------------------- //
  { name: 'OpenAI', type: 'company', aliases: ['openai', 'open ai'] },
  { name: 'Anthropic', type: 'company', aliases: ['anthropic'] },
  { name: 'Google DeepMind', type: 'company', aliases: ['deepmind', 'google deepmind', 'google ai'] },
  { name: 'Meta AI', type: 'company', aliases: ['meta ai', 'fair', 'meta superintelligence', 'msl'] },
  { name: 'xAI', type: 'company', aliases: ['xai', 'x.ai'] },
  { name: 'Mistral AI', type: 'company', aliases: ['mistral ai', 'mistral'] },
  { name: 'DeepSeek', type: 'company', aliases: ['deepseek', '深度求索'] },
  { name: 'Moonshot AI', type: 'company', aliases: ['moonshot', 'kimi', '月之暗面'] },
  { name: 'Zhipu AI', type: 'company', aliases: ['zhipu', 'z.ai', '智谱'] },
  { name: 'Alibaba Qwen', type: 'company', aliases: ['qwen team', 'tongyi', '通义', '阿里通义'] },
  { name: 'ByteDance Seed', type: 'company', aliases: ['bytedance seed', 'doubao', 'seed team', '豆包', '字节跳动'] },
  { name: 'MiniMax', type: 'company', aliases: ['minimax'] },
  { name: 'StepFun', type: 'company', aliases: ['stepfun', '阶跃星辰'] },
  { name: 'Baidu', type: 'company', aliases: ['baidu', 'ernie', '百度', '文心'] },
  { name: 'Tencent', type: 'company', aliases: ['tencent', 'hunyuan', '腾讯', '混元'] },
  { name: 'Nvidia', type: 'company', aliases: ['nvidia', 'nvda', '英伟达'] },
  { name: 'AMD', type: 'company', aliases: ['amd'], caseSensitive: true },
  { name: 'Groq', type: 'company', aliases: ['groq'] },
  { name: 'Cerebras', type: 'company', aliases: ['cerebras'] },
  { name: 'Hugging Face', type: 'company', aliases: ['hugging face', 'huggingface'] },
  { name: 'Cohere', type: 'company', aliases: ['cohere'] },
  { name: 'Perplexity', type: 'company', aliases: ['perplexity'] },
  { name: 'Cursor', type: 'company', aliases: ['cursor', 'anysphere'] },
  { name: 'Databricks', type: 'company', aliases: ['databricks', 'mosaicml'] },
  { name: 'Scale AI', type: 'company', aliases: ['scale ai'] },
  { name: 'Together AI', type: 'company', aliases: ['together ai', 'together.ai'] },
  { name: 'Fireworks AI', type: 'company', aliases: ['fireworks ai'] },
  { name: 'Replicate', type: 'company', aliases: ['replicate'] },
  { name: 'CoreWeave', type: 'company', aliases: ['coreweave'] },
  { name: 'Midjourney', type: 'company', aliases: ['midjourney'] },
  { name: 'Black Forest Labs', type: 'company', aliases: ['black forest labs', 'bfl'] },
  { name: 'Stability AI', type: 'company', aliases: ['stability ai', 'stabilityai'] },
  { name: 'Runway', type: 'company', aliases: ['runwayml', 'runway ml'] },
  { name: 'Luma AI', type: 'company', aliases: ['luma ai', 'luma labs'] },
  { name: 'ElevenLabs', type: 'company', aliases: ['elevenlabs', 'eleven labs'] },
  { name: 'Suno', type: 'company', aliases: ['suno ai', 'suno'] },
  { name: 'Figure', type: 'company', aliases: ['figure ai', 'figure robotics'] },
  { name: 'Physical Intelligence', type: 'company', aliases: ['physical intelligence', 'pi robotics'] },
  { name: 'Unitree', type: 'company', aliases: ['unitree', '宇树'] },
  { name: 'LangChain', type: 'company', aliases: ['langchain', 'langgraph', 'langsmith'] },
  { name: 'LlamaIndex', type: 'company', aliases: ['llamaindex', 'llama index'] },
  { name: 'Vercel', type: 'company', aliases: ['vercel'] },
  { name: 'Ollama', type: 'product', aliases: ['ollama'] },
  { name: 'vLLM', type: 'product', aliases: ['vllm'] },
  { name: 'SGLang', type: 'product', aliases: ['sglang'] },
  { name: 'llama.cpp', type: 'product', aliases: ['llama.cpp', 'llamacpp'] },
  { name: 'MLX', type: 'product', aliases: ['mlx'], caseSensitive: true },
  { name: 'Claude Code', type: 'product', aliases: ['claude code'] },
  { name: 'GitHub Copilot', type: 'product', aliases: ['github copilot', 'copilot workspace'] },
  { name: 'Model Context Protocol', type: 'concept', aliases: ['model context protocol', 'mcp server', 'mcp'] },

  // --- models ------------------------------------------------------------ //
  { name: 'GPT-5', type: 'model', aliases: ['gpt-5', 'gpt5', 'gpt-5.1', 'gpt-5.2', 'gpt-5 pro'] },
  { name: 'GPT-6', type: 'model', aliases: ['gpt-6', 'gpt6'] },
  { name: 'GPT-4o', type: 'model', aliases: ['gpt-4o', 'gpt4o'] },
  { name: 'OpenAI o-series', type: 'model', aliases: ['o1 model', 'o3 model', 'o3-mini', 'o4-mini', 'o5 model'] },
  { name: 'Sora', type: 'model', aliases: ['sora 2', 'sora'] },
  { name: 'Claude Opus', type: 'model', aliases: ['claude opus', 'opus 4', 'opus 4.5', 'opus 5', 'claude 4 opus'] },
  { name: 'Claude Sonnet', type: 'model', aliases: ['claude sonnet', 'sonnet 4', 'sonnet 4.5', 'sonnet 5'] },
  { name: 'Claude Haiku', type: 'model', aliases: ['claude haiku', 'haiku 4.5'] },
  { name: 'Gemini', type: 'model', aliases: ['gemini 2', 'gemini 2.5', 'gemini 3', 'gemini pro', 'gemini flash', 'gemini ultra'] },
  { name: 'Veo', type: 'model', aliases: ['veo 3', 'veo 2', 'google veo'] },
  { name: 'Imagen', type: 'model', aliases: ['imagen 4', 'imagen 3'] },
  { name: 'Nano Banana', type: 'model', aliases: ['nano banana'] },
  { name: 'Llama', type: 'model', aliases: ['llama 3', 'llama 4', 'llama-3', 'llama-4', 'llama 5'] },
  { name: 'Grok', type: 'model', aliases: ['grok 3', 'grok 4', 'grok 5', 'grok-4'] },
  { name: 'DeepSeek-R1', type: 'model', aliases: ['deepseek-r1', 'deepseek r1'] },
  { name: 'DeepSeek-V3', type: 'model', aliases: ['deepseek-v3', 'deepseek v3', 'deepseek-v4'] },
  { name: 'Qwen', type: 'model', aliases: ['qwen2', 'qwen 2.5', 'qwen3', 'qwen 3', 'qwq', 'qwen-max'] },
  { name: 'Kimi K2', type: 'model', aliases: ['kimi k2', 'kimi-k2', 'kimi k1.5'] },
  { name: 'GLM', type: 'model', aliases: ['glm-4', 'glm 4.5', 'glm-4.6', 'chatglm'] },
  { name: 'MiniMax-M1', type: 'model', aliases: ['minimax-m1', 'minimax m2', 'abab'] },
  { name: 'Mistral Large', type: 'model', aliases: ['mistral large', 'mixtral', 'magistral', 'devstral', 'codestral'] },
  { name: 'Phi', type: 'model', aliases: ['phi-3', 'phi-4', 'phi 4'] },
  { name: 'Gemma', type: 'model', aliases: ['gemma 2', 'gemma 3', 'codegemma'] },
  { name: 'FLUX', type: 'model', aliases: ['flux.1', 'flux 1', 'flux pro', 'flux kontext'] },
  { name: 'Stable Diffusion', type: 'model', aliases: ['stable diffusion', 'sdxl', 'sd3'] },
  { name: 'Whisper', type: 'model', aliases: ['whisper large', 'openai whisper'] },
  { name: 'AlphaFold', type: 'model', aliases: ['alphafold'] },

  // --- people ------------------------------------------------------------ //
  { name: 'Sam Altman', type: 'person', aliases: ['sam altman', 'altman'] },
  { name: 'Dario Amodei', type: 'person', aliases: ['dario amodei'] },
  { name: 'Demis Hassabis', type: 'person', aliases: ['demis hassabis'] },
  { name: 'Yann LeCun', type: 'person', aliases: ['yann lecun', 'lecun'] },
  { name: 'Ilya Sutskever', type: 'person', aliases: ['ilya sutskever', 'ssi'] },
  { name: 'Andrej Karpathy', type: 'person', aliases: ['andrej karpathy', 'karpathy'] },
  { name: 'Jeff Dean', type: 'person', aliases: ['jeff dean'] },
  { name: 'Mira Murati', type: 'person', aliases: ['mira murati', 'thinking machines lab'] },
  { name: 'Fei-Fei Li', type: 'person', aliases: ['fei-fei li', 'fei fei li', '李飞飞', 'world labs'] },
  { name: 'Andrew Ng', type: 'person', aliases: ['andrew ng', 'deeplearning.ai'] },
  { name: 'Jim Fan', type: 'person', aliases: ['jim fan'] },
  { name: 'Simon Willison', type: 'person', aliases: ['simon willison'] },
  { name: 'Nathan Lambert', type: 'person', aliases: ['nathan lambert', 'interconnects'] },
  { name: 'Sebastian Raschka', type: 'person', aliases: ['sebastian raschka'] },
  { name: 'Liang Wenfeng', type: 'person', aliases: ['liang wenfeng', '梁文锋'] },
  { name: 'Kaiming He', type: 'person', aliases: ['kaiming he', '何恺明'] },

  // --- benchmarks -------------------------------------------------------- //
  { name: 'MMLU', type: 'benchmark', aliases: ['mmlu', 'mmlu-pro'], caseSensitive: true },
  { name: 'GPQA', type: 'benchmark', aliases: ['gpqa'], caseSensitive: true },
  { name: 'SWE-bench', type: 'benchmark', aliases: ['swe-bench', 'swebench'] },
  { name: 'HumanEval', type: 'benchmark', aliases: ['humaneval'] },
  { name: 'AIME', type: 'benchmark', aliases: ['aime'], caseSensitive: true },
  { name: 'ARC-AGI', type: 'benchmark', aliases: ['arc-agi', 'arc agi'] },
  { name: "Humanity's Last Exam", type: 'benchmark', aliases: ["humanity's last exam", 'hle benchmark'] },
  { name: 'LiveCodeBench', type: 'benchmark', aliases: ['livecodebench'] },
  { name: 'MMMU', type: 'benchmark', aliases: ['mmmu'], caseSensitive: true },
  { name: 'LMArena', type: 'benchmark', aliases: ['lmarena', 'chatbot arena', 'lmsys arena'] },
  { name: 'Terminal-Bench', type: 'benchmark', aliases: ['terminal-bench', 'terminalbench'] },
  { name: 'OSWorld', type: 'benchmark', aliases: ['osworld'] },
  { name: 'BrowseComp', type: 'benchmark', aliases: ['browsecomp'] },
  { name: 'Tau-bench', type: 'benchmark', aliases: ['tau-bench', 'taubench', 'τ-bench'] },

  // --- concepts ---------------------------------------------------------- //
  { name: 'Transformer', type: 'concept', aliases: ['transformer architecture', 'transformers architecture'] },
  { name: 'Mixture of Experts', type: 'concept', aliases: ['mixture of experts', 'moe architecture'] },
  { name: 'Chain of Thought', type: 'concept', aliases: ['chain of thought', 'chain-of-thought'] },
  { name: 'Test-time Compute', type: 'concept', aliases: ['test-time compute', 'inference-time compute', 'test time scaling'] },
  { name: 'RLHF', type: 'concept', aliases: ['rlhf'], caseSensitive: true },
  { name: 'GRPO', type: 'concept', aliases: ['grpo'], caseSensitive: true },
  { name: 'DPO', type: 'concept', aliases: ['dpo'], caseSensitive: true },
  { name: 'LoRA', type: 'concept', aliases: ['lora fine', 'qlora'] },
  { name: 'Quantization', type: 'concept', aliases: ['quantization', 'quantisation', 'gguf', 'int4', 'fp8', 'fp4'] },
  { name: 'KV Cache', type: 'concept', aliases: ['kv cache', 'kv-cache'] },
  { name: 'FlashAttention', type: 'concept', aliases: ['flashattention', 'flash attention'] },
  { name: 'Speculative Decoding', type: 'concept', aliases: ['speculative decoding', 'draft model'] },
  { name: 'Long Context', type: 'concept', aliases: ['long context', 'context window', '1m context', 'million token'] },
  { name: 'Prompt Injection', type: 'concept', aliases: ['prompt injection', 'indirect injection'] },
  { name: 'Hallucination', type: 'concept', aliases: ['hallucination', 'hallucinate', 'confabulation'] },
  { name: 'Scaling Laws', type: 'concept', aliases: ['scaling law', 'chinchilla optimal'] },
  { name: 'World Model', type: 'concept', aliases: ['world model', 'world simulator'] },
  { name: 'Mamba / SSM', type: 'concept', aliases: ['mamba architecture', 'state space model', 'ssm architecture'] },
  { name: 'Diffusion', type: 'concept', aliases: ['diffusion model', 'latent diffusion', 'flow matching'] },
  { name: 'Sparse Autoencoder', type: 'concept', aliases: ['sparse autoencoder', 'sae feature'] },
  { name: 'Vision-Language-Action', type: 'concept', aliases: ['vision language action', 'vla model'] },
  { name: 'Context Engineering', type: 'concept', aliases: ['context engineering', 'context rot'] },
]

/** Pre-compiled matchers, built once at module load. */
type CompiledEntity = { def: EntityDef; alias: string; re: RegExp }

function boundaryRegex(alias: string, caseSensitive: boolean): RegExp {
  const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  // CJK has no word boundaries; Latin needs them to avoid "mcp" inside "mcpx".
  const cjk = /[一-鿿぀-ヿ가-힯]/.test(alias)
  const pattern = cjk ? escaped : `(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`
  return new RegExp(pattern, caseSensitive ? 'u' : 'iu')
}

const COMPILED: CompiledEntity[] = ENTITIES.flatMap((def) =>
  def.aliases.map((alias) => ({
    def,
    alias,
    re: boundaryRegex(alias, def.caseSensitive === true),
  })),
)

// Longer aliases first, so "gemini 3" wins over "gemini".
COMPILED.sort((a, b) => b.alias.length - a.alias.length)

export const ENTITY_NAMES = ENTITIES.map((e) => e.name)

/**
 * Recognise known AI entities in text. Confidence reflects alias specificity:
 * a long multi-word alias is a near-certain hit, a 3-letter acronym less so.
 */
export function extractEntities(text: string, limit = 24): Entity[] {
  if (!text) return []
  const sample = text.slice(0, 12_000)
  const found = new Map<string, Entity>()

  for (const { def, alias, re } of COMPILED) {
    if (found.size >= limit) break
    if (found.has(def.name)) continue
    if (!re.test(sample)) continue
    const confidence = alias.length >= 10 ? 1 : alias.length >= 6 ? 0.9 : def.caseSensitive ? 0.85 : 0.7
    found.set(def.name, { type: def.type, name: def.name, confidence })
  }
  return [...found.values()]
}

/**
 * Assign topic ids by term hits, weighted by where they occur — a term in the
 * title is worth 3x the same term in the body.
 */
export function classifyTopics(
  input: { title?: string; content?: string; summary?: string },
  options: { limit?: number; includeQuerySynonyms?: boolean } | number = {},
): string[] {
  const { limit = 5, includeQuerySynonyms = false } =
    typeof options === 'number' ? { limit: options, includeQuerySynonyms: false } : options
  const title = (input.title ?? '').toLowerCase()
  const body = `${input.summary ?? ''}\n${(input.content ?? '').slice(0, 8000)}`.toLowerCase()
  if (!title && !body.trim()) return []

  const scores: { id: string; score: number }[] = []
  for (const topic of TOPICS) {
    let score = 0
    const vocabulary = includeQuerySynonyms ? [...topic.terms, ...(topic.querySynonyms ?? [])] : topic.terms
    for (const term of vocabulary) {
      if (title.includes(term)) score += 3
      // Count body hits with diminishing returns.
      let idx = body.indexOf(term)
      let hits = 0
      while (idx !== -1 && hits < 4) {
        hits++
        idx = body.indexOf(term, idx + term.length)
      }
      score += hits > 0 ? 1 + Math.log2(hits) : 0
    }
    if (score > 0) scores.push({ id: topic.id, score })
  }
  scores.sort((a, b) => b.score - a.score)

  // Keep topics close to the leader. The floor is higher for documents than for
  // queries: a single incidental word must not earn a label.
  const top = scores[0]?.score ?? 0
  const floor = includeQuerySynonyms ? Math.max(1, top * 0.2) : Math.max(2.5, top * 0.4)
  return scores
    .filter((s) => s.score >= floor)
    .slice(0, limit)
    .map((s) => s.id)
}

/** Display label for a topic id, with Chinese support. */
export function topicLabel(id: string, locale: 'en' | 'zh' = 'en'): string {
  const t = TOPIC_BY_ID.get(id)
  if (!t) return id
  return locale === 'zh' ? t.labelZh : t.label
}
