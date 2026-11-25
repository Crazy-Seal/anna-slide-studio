// tools/gen-fixtures.mjs
//
// 生成两套 mock 数据：
//   fixtures/replies.jsonl  —— 本地开发用（完整 deck，两个阶段都能跑通）
//   fixtures/outline.jsonl  —— 只测大纲阶段时用
//
// ⚠️ 运行时限制（已读源码确认，非猜测）：
//   anna-app-runtime-local 的 mock 匹配器是
//     const entry = this.mocks.find(m => m.ns==="llm" && m.method==="complete") ?? null;
//   它**只取第一条** llm.complete 应答，contentIncludes 不匹配时还回落到同一条。
//   所以多任务（OUTLINE / DECK / REWRITE）没法靠一个文件区分。
//   对策：把**完整 deck** 放第一条——大纲阶段 normalizeOutline 能从 deck 的
//   slides[].title 里正确提取出大纲，正文阶段拿到完整内容，一条数据跑通全流程。
//   接真实模型后两个阶段各自返回正确结构，不受此限制影响。
//
// 用法：node tools/gen-fixtures.mjs

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
mkdirSync(join(root, 'fixtures'), { recursive: true });

const outline = {
  title: '2026 Q3 业务回顾',
  subtitle: '产品团队 · 10 月全员会',
  slides: [
    { title: '2026 Q3 业务回顾', hint: '封面：点明本次回顾要回答的三个问题' },
    { title: '今天讲三件事', hint: '目录：成绩、问题、下季度优先级' },
    { title: '三个关键数字', hint: '用三个指标概括本季度整体表现' },
    { title: '我们做对了什么', hint: '提炼三条可复用的经验' },
    { title: '做得好与待改进', hint: '左右对比，客观呈现' },
    { title: '一线同事怎么说', hint: '引用一句真实反馈，增加可信度' },
    { title: '下季度三件事', hint: '收敛到三个优先级，每件配一句判断依据' },
    { title: '谢谢', hint: '结尾，留出提问时间' },
  ],
};

const deck = {
  title: '2026 Q3 业务回顾',
  subtitle: '产品团队 · 10 月全员会',
  theme: 'editorial',
  slides: [
    {
      layout: 'title',
      title: '2026 Q3 业务回顾',
      subtitle: '产品团队 · 10 月全员会',
      notes: '开场 30 秒。先给结论：这个季度我们稳住了基本盘，但增长引擎还没换上去。',
    },
    {
      layout: 'agenda',
      title: '今天讲三件事',
      bullets: ['本季度做成了什么', '还有哪些没解决', '下季度优先做什么'],
      notes: '用 40 秒带过目录，让听众知道节奏。',
    },
    {
      layout: 'metrics',
      title: '三个关键数字',
      metrics: [
        { value: '+38%', label: '月活增长' },
        { value: '4.2', label: 'NPS 评分' },
        { value: '-52%', label: '线上事故' },
      ],
      notes: '三个数字分别对应增长、口碑、稳定。强调事故下降是有意识的投入换来的。',
    },
    {
      layout: 'bullets',
      title: '我们做对了什么',
      bullets: [
        '把核心链路重构成可并行发布的结构',
        '把数据看板下沉到一线，减少口头同步',
        '事故复盘改成对事不对人，问题暴露更早',
      ],
      notes: '这三条是可复用的经验，不是偶然。每条停一下，让听众消化。',
    },
    {
      layout: 'two_col',
      title: '做得好与待改进',
      columns: [
        { heading: '做得好的', items: ['交付节奏稳定', '线上事故明显下降', '跨团队协作变顺'] },
        { heading: '待改进的', items: ['需求变更仍频繁', '关键路径依赖个人', '增长实验偏少'] },
      ],
      notes: '这一页要诚实。待改进的部分不要念得太快，否则听众会觉得在敷衍。',
    },
    {
      layout: 'quote',
      title: '一线同事怎么说',
      quote: { text: '以前每周要开三次同步会，现在看板就够了。', attribution: '某业务线负责人' },
      notes: '引用要真实。如果没有原话，宁可不用这一页。',
    },
    {
      layout: 'bullets',
      title: '下季度三件事',
      bullets: [
        '把增长实验机制建起来，每周至少跑一个',
        '关键路径补上第二负责人，消除单点',
        '需求进入前强制评估影响面',
      ],
      notes: '三件事都要能落到人。说完停两秒，进入提问。',
    },
    {
      layout: 'closing',
      title: '谢谢',
      subtitle: 'Q & A',
      notes: '留 10 分钟提问。',
    },
  ],
};

const reply = (text) => ({
  role: 'assistant',
  content: { type: 'text', text },
  model: 'mock',
  stopReason: 'endTurn',
  usage: { inputTokens: 900, outputTokens: 900, totalTokens: 1800 },
  _meta: { provider: 'mock', latencyMs: 120, quotaConsumed: 1 },
});

const compact = (o) => JSON.stringify(o);

// 导出链路需要一个假的上传应答，否则本地走到上传就断了
const uploadStub = {
  ns: 'upload',
  method: 'inline',
  result: {
    r2_key: 'mock/uploads/deck.pptx',
    mime_type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    size_bytes: 4096,
    bytes_size: 4096,
    download_url: 'data:application/octet-stream;base64,UEsDBAoAAAAAAAAAAAA=',
    expires_in: 3600,
  },
};

const deckFirst = [
  { ns: 'llm', method: 'complete', match: { contentIncludes: 'TASK:' }, result: reply(compact(deck)) },
  uploadStub,
];

const outlineOnly = [
  { ns: 'llm', method: 'complete', match: { contentIncludes: 'TASK:OUTLINE' }, result: reply(compact(outline)) },
];

const write = (name, lines) => {
  const out = lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
  writeFileSync(join(root, 'fixtures', name), out, 'utf8');
  return out.length;
};

const a = write('replies.jsonl', deckFirst);
const b = write('outline.jsonl', outlineOnly);
console.log(`fixtures/replies.jsonl  ${a} 字节（完整 deck，一条跑通全流程）`);
console.log(`fixtures/outline.jsonl  ${b} 字节（只测大纲阶段）`);
