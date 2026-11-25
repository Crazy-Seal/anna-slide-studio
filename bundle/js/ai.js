// ai.js — 提示词构造 + 模型调用 + 宽松 JSON 解析
//
// 三层防线，按顺序生效：
//   1. prompt 里塞满约束和示例（few-shot 比"请严格遵守格式"有效得多）
//   2. parseLooseJson 容忍代码块围栏、前后噪声
//   3. 解析失败 → 把错误回喂模型修一次（只一次，不自动重试第二次）

import { SKELETONS, DEFAULT_SKELETON, suggestPages } from './deck.js';

/** 任务标记：写进 user message，供本地 mock 按内容精确匹配 */
export const TASK = {
  OUTLINE: 'TASK:OUTLINE',
  DECK: 'TASK:DECK',
  REWRITE: 'TASK:REWRITE',
};

// ---------- 提示词 ----------

const COMMON_RULES = `
输出规则（必须遵守）：
- 只输出一个 JSON 对象。不要 markdown 代码块，不要 \`\`\`json，不要任何解释、前言、后记。
- 所有字符串使用中文全角标点（，。：；？！），英文专有名词、数字、单位保留原文。
- 不要编造具体数字、人名、机构名。没有真实数据时，用定性表述（如"显著提升"）而不是编一个百分比。
- 不要写"本页将介绍……"这类元叙述，直接给内容。
`.trim();

export function outlineSystem(sections, counts, contentCount) {
  const rows = sections.map((s, i) =>
    `- "${s.key}"（${s.title}）参考 ${counts[i]} 页`
  ).join('\n');

  return `
你是一位演示文稿策划，负责设计叙事结构并写出每页的要点。

下面是一套**常见骨架，仅供参考**（不是必须照搬）：
${rows}

你可以自由决定结构：
- 可以直接用上面这些环节；
- 也可以**增加、拆分、合并、替换**环节——比如加一个"现状数据"或"风险与对策"，或者把"方案"拆成"总体方案"和"落地路径"；
- 但整体要有**清楚的说服链条**：让听众从"为什么要关注"走到"要做什么"再到"值不值"。
- 每个环节至少 1 页，内容页合计最好接近 ${contentCount} 页（差一两页没关系）。
- 封面和结尾由系统自动补，**不要输出**。

输出 JSON 结构：
{
  "title": "整份演示标题，不超过 20 字",
  "subtitle": "副标题，可留空字符串",
  "slides": [
    {
      "section": "环节 key，英文小写单词，如 background / solution / risk",
      "sectionTitle": "这个环节显示给用户看的中文名，2–6 字，如 背景 / 方案 / 风险与对策",
      "title": "这一页的标题，不超过 18 字",
      "hint": "这一页讲什么，不超过 30 字"
    }
  ]
}

内容要求：
- **同一环节的连续几页必须用完全相同的 section 和 sectionTitle**，否则会被当成两个环节。
- 相邻页如果属于不同环节，按叙事顺序排列，不要来回跳。
- 每个环节的第一页交代该环节的核心结论，后续页再展开。
- title 必须是**具体内容**，禁止"概述""背景介绍""总结"这类空标题。
- hint 写清这页要支撑什么观点或放什么材料。

${COMMON_RULES}
`.trim();
}

export function deckSystem() {
  return `
你是一位资深演示文稿撰写者。你会拿到一份**已经确认好结构、顺序和每页主题**的大纲，需要把它写成完整内容。

输出 JSON 结构：
{
  "title": "整份演示标题",
  "subtitle": "副标题",
  "theme": "editorial | minimal | bold | tech 四选一",
  "slides": [ /* 与大纲逐页一一对应，不增不减，顺序一致 */ ]
}

每一页 slide 的可用版式（layout）与必填字段：

1. "title"（封面，只能第一页）
   { "layout":"title", "title":"...", "subtitle":"...", "notes":"..." }

2. "agenda"（目录）
   { "layout":"agenda", "title":"目录", "bullets":["第一条","第二条"], "notes":"..." }
   bullets 3–6 条，每条 ≤ 24 字

3. "bullets"（要点页，最常用）
   { "layout":"bullets", "title":"...", "bullets":["...","..."], "notes":"..." }
   bullets 2–5 条，每条 ≤ 28 字，必须是完整的一句话

4. "two_col"（左右对比：适合"问题"和"原因分析"）
   { "layout":"two_col", "title":"...", "columns":[{"heading":"左栏","items":["..."]},{"heading":"右栏","items":["..."]}], "notes":"..." }
   恰好 2 栏，每栏 2–4 条，每条 ≤ 22 字

5. "metrics"（关键数字：适合"成本"和"收益"）
   { "layout":"metrics", "title":"...", "metrics":[{"value":"+38%","label":"月活增长"}], "notes":"..." }
   2–4 项，value ≤ 8 字，label ≤ 12 字
   ⚠️ 只有用户提供了真实数字才能用；没有数字请改用 bullets，不要编造

6. "quote"（引用）
   { "layout":"quote", "quote":{"text":"引文","attribution":"出处"}, "notes":"..." }
   text ≤ 60 字。只在确实有引述场景时使用

7. "closing"（结尾，只能最后一页）
   { "layout":"closing", "title":"谢谢", "subtitle":"Q & A", "notes":"..." }

全局要求：
- slides 必须与大纲**逐页对应**：数量相同、顺序相同、每页围绕大纲给的 title 展开。
- 大纲里标了建议版式的页，优先用那个版式；但若内容明显更适合别的版式可以换，封面和结尾例外（必须 title / closing）。
- notes 是讲稿备注，30–80 字的口播提示，不要重复正文。
- 每个环节内部要有递进，不要每页都在说同一件事。

${COMMON_RULES}
`.trim();
}

export function repairSystem() {
  return `
你是一个 JSON 修复器。用户会给你一段"本应是 JSON 但有语法错误"的文本。

规则：
- 只修语法错误（多余逗号、未闭合引号、缺括号、代码块围栏残留）。
- 绝对不要改写内容、不要增删字段、不要重新组织。
- 只输出修好的 JSON 对象，不要任何解释。

${COMMON_RULES}
`.trim();
}

// ---------- 消息构造 ----------

const AUDIENCE_TEXT = { mgmt: '管理层', team: '团队内部', client: '客户 / 甲方', general: '通用听众' };
const TONE_TEXT = { restrained: '克制、专业', clean: '简洁、干净', bold: '有力、直接', technical: '技术、精确' };

export function buildOutlineMessages(brief) {
  const sk = SKELETONS[brief.skeleton] || SKELETONS[DEFAULT_SKELETON];
  const sections = sk.sections;
  const contentCount = Math.max(sections.length, (brief.pages || 8) - 2);
  const counts = suggestPages(sections, contentCount);

  const user = [
    TASK.OUTLINE,
    `主题：${brief.topic || '（未提供）'}`,
    `听众：${AUDIENCE_TEXT[brief.audience] || '通用听众'}`,
    `风格：${TONE_TEXT[brief.tone] || '克制、专业'}`,
    `结构参考：${sk.label}（${sections.map((s) => s.title).join(' → ')}）`,
    `内容页合计约 ${contentCount} 页，可自行决定环节和每环节页数。`,
    '不要输出封面和结尾页——系统会自动补。',
  ].join('\n');

  return [
    { role: 'system', content: { type: 'text', text: outlineSystem(sections, counts, contentCount) } },
    { role: 'user', content: { type: 'text', text: user } },
  ];
}

export function buildDeckMessages(brief, outline) {
  const rows = outline.slides
    .map((s, i) => `${i + 1}. [${s.sectionTitle}] ${s.title}   （建议版式：${s.layout}）`)
    .join('\n');

  const user = [
    TASK.DECK,
    `主题：${brief.topic || outline.title}`,
    `听众：${AUDIENCE_TEXT[brief.audience] || '通用听众'}`,
    `风格：${TONE_TEXT[brief.tone] || '克制、专业'}`,
    '',
    `已确认的大纲，共 ${outline.slides.length} 页，逐页对应：`,
    rows,
    '',
    '请按上面每一页的标题写内容，数量、顺序都要一致。',
  ].join('\n');

  return [
    { role: 'system', content: { type: 'text', text: deckSystem() } },
    { role: 'user', content: { type: 'text', text: user } },
  ];
}

export function buildRewriteMessages(brief, outline, index) {
  const target = outline.slides[index];
  const user = [
    TASK.REWRITE,
    `主题：${brief.topic || outline.title}`,
    `听众：${AUDIENCE_TEXT[brief.audience] || '通用听众'}`,
    '',
    `这次只重写第 ${index + 1} 页，它属于「${target ? target.sectionTitle : ''}」环节，标题是「${target ? target.title : ''}」。`,
    '整份大纲（供你理解上下文，不要输出）：',
    outline.slides.map((s, i) => `${i + 1}. [${s.sectionTitle}] ${s.title}`).join('\n'),
    '',
    '请只输出这一页的 JSON 对象（不要数组，不要外层 slides 字段）。换一种表达角度，或者换一个更合适的版式。',
  ].join('\n');

  return [
    { role: 'system', content: { type: 'text', text: deckSystem() } },
    { role: 'user', content: { type: 'text', text: user } },
  ];
}

// ---------- 调用 ----------

export class LlmError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'LlmError';
    this.code = code;
  }
}

/**
 * 指定模型。不指定就用**用户默认模型**（staging 上是 claude-sonnet-4.5，
 * 一份 8 页 deck 约 34.7 CU）；指定 qwen3.8-flash 约 1.1 CU，差 30 倍。
 *
 * 已实测确认 `modelPreferences.hints[0].name` 生效（返回的 model 与之一致）。
 * 换模型只改这一行。备选：
 *   xiaomi/mimo-v2.5     0.7 CU  — 最便宜，但无结构化能力标记
 *   qwen3.8-flash        1.1 CU  — 便宜 + 结构化 + 1M 上下文 ← 当前
 *   minimax/minimax-m3   2.8 CU  — 结构化，质量更稳
 *   qwen3.8-max         15.0 CU  — 质量优先时
 */
export const MODEL = 'qwen3.8-flash';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 这些错误重试有意义（staging 的 502 是已知瞬时故障）；额度和未连接类重试没用 */
function isRetryable(e) {
  const code = e && e.code;
  if (code === 'quota_exceeded' || code === 'llm_disabled' || code === 'invalid_arg') return false;
  if (code === 'transport' || code === 'timeout') return true;
  const msg = String((e && e.message) || '');
  return /502|503|504|bad gateway|timeout|network|ECONNRESET|fetch failed/i.test(msg);
}

function mapError(e) {
  const code = e && (e.code || e.name) ? String(e.code || e.name) : 'unknown';
  const msg = String((e && e.message) || '');
  if (code === 'quota_exceeded' || (e && e.code === -32009)) {
    return new LlmError('额度不足，无法生成。可联系平台补充额度。', 'quota_exceeded');
  }
  if (code === 'llm_disabled' || code === 'not_implemented') {
    return new LlmError('当前是本地预览模式，未连接模型。', 'llm_disabled');
  }
  if (isRetryable(e)) {
    return new LlmError('模型服务暂时不可用（平台侧），已重试仍未成功。请稍后再试，本次未扣额度。', 'transport');
  }
  return new LlmError(msg || '模型调用失败', code);
}

/**
 * 单次文本补全。返回 { text, cost, stopReason }。
 * cost 来自 _meta.quotaConsumed —— 平台的真实计量值，不猜。
 *
 * 注意：iframe 路径**不支持** responseFormat（已用非法值实测：被静默忽略），
 * 所以结构化输出只能靠 prompt + 校验 + 修复重试。
 *
 * 传输层错误最多重试 3 次（1.2s / 2.4s 退避）：staging 的 502 是已知的
 * 平台侧瞬时故障，不重试会让用户莫名其妙失败。
 */
export async function callText(anna, messages, maxTokens) {
  if (!anna || !anna.llm || typeof anna.llm.complete !== 'function') {
    throw new LlmError('当前环境没有连接模型', 'llm_disabled');
  }

  const MAX_ATTEMPTS = 3;
  let lastErr = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const r = await anna.llm.complete({
        messages,
        maxTokens,
        thinking: false, // 生成任务不需要推理链，关掉省额度也省延迟
        modelPreferences: { hints: [{ name: MODEL }] },
      });
      return {
        text: (r && r.content && r.content.text) || '',
        cost: r && r._meta ? r._meta.quotaConsumed : null,
        stopReason: r ? r.stopReason : null,
        model: r ? r.model : null,
      };
    } catch (e) {
      lastErr = e;
      if (!isRetryable(e) || attempt === MAX_ATTEMPTS) break;
      await sleep(1200 * attempt);
    }
  }

  throw mapError(lastErr);
}

// ---------- 解析 ----------

/** 去掉代码块围栏与前后噪声，取出最外层 JSON 对象 */
export function extractJsonText(s) {
  let t = String(s || '').trim();
  t = t.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start >= 0 && end > start) t = t.slice(start, end + 1);
  return t;
}

export function parseLooseJson(s) {
  const t = extractJsonText(s);
  if (!t) throw new Error('模型返回为空');
  try {
    return JSON.parse(t);
  } catch (e) {
    // 常见毛病：尾逗号
    try {
      return JSON.parse(t.replace(/,\s*([}\]])/g, '$1'));
    } catch (_) {
      throw new Error('JSON 解析失败：' + e.message);
    }
  }
}
