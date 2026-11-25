// deck.js — 数据契约：画布几何、主题、版式、校验
//
// 设计要点：**几何只定义一次**。预览渲染器和 pptx 导出器读同一份坐标
// （以 1280×720 像素为基准），导出时除以 128 换算成英寸，字号乘 0.5625
// 换算成磅。所以预览里看到的位置就是 pptx 里的位置。

export const CANVAS = { w: 1280, h: 720, margin: 80 };
export const PX_PER_INCH = 128;      // 1280px / 128 = 10in（16:9 宽）
export const PT_PER_PX = 0.5625;     // 720pt / 1280px

export const THEME_IDS = ['editorial', 'minimal', 'bold', 'tech'];

export const THEMES = {
  editorial: {
    label: '克制',
    bg: '#FAF9F7', panel: '#FFFFFF', slideBg: '#FFFDFA',
    fg: '#1A1A1A', muted: '#6B6560', accent: '#1A1A1A',
    accentFg: '#FFFFFF', line: '#E3DFD8', canvasBg: '#EDEBE7',
  },
  minimal: {
    label: '简洁',
    bg: '#F7F8FA', panel: '#FFFFFF', slideBg: '#FFFFFF',
    fg: '#111827', muted: '#6B7280', accent: '#2563EB',
    accentFg: '#FFFFFF', line: '#E5E7EB', canvasBg: '#EDEFF3',
  },
  bold: {
    label: '有力',
    bg: '#0F0F0F', panel: '#181818', slideBg: '#0F0F0F',
    fg: '#F5F5F5', muted: '#9A9A9A', accent: '#F5F5F5',
    accentFg: '#0F0F0F', line: '#2A2A2A', canvasBg: '#050505',
  },
  tech: {
    label: '技术',
    bg: '#0B1220', panel: '#111B2E', slideBg: '#0E1626',
    fg: '#E2E8F0', muted: '#7C8CA3', accent: '#38BDF8',
    accentFg: '#04121F', line: '#1E2A40', canvasBg: '#060B14',
  },
};

// 每种角色的字号/字重/行高。预览和导出都从这里取，避免两处不同步。
export const ROLE_STYLE = {
  title:        { size: 58, weight: 700, lh: 1.22, color: 'fg' },
  subtitle:     { size: 26, weight: 400, lh: 1.5,  color: 'muted' },
  heading:      { size: 42, weight: 700, lh: 1.25, color: 'fg' },
  bullet:       { size: 28, weight: 400, lh: 1.45, color: 'fg' },
  collabel:     { size: 25, weight: 700, lh: 1.3,  color: 'accent' },
  colitem:      { size: 21, weight: 400, lh: 1.5,  color: 'fg' },
  metric:       { size: 84, weight: 700, lh: 1.05, color: 'accent' },
  metriclabel:  { size: 20, weight: 400, lh: 1.4,  color: 'muted' },
  quote:        { size: 40, weight: 400, lh: 1.38, color: 'fg' },
  attribution:  { size: 20, weight: 400, lh: 1.4,  color: 'muted' },
  agenda:       { size: 26, weight: 400, lh: 1.4,  color: 'fg' },
  closingTitle: { size: 62, weight: 700, lh: 1.2,  color: 'fg' },
  pagenum:      { size: 18, weight: 400, lh: 1.2,  color: 'muted' },
  kicker:       { size: 16, weight: 600, lh: 1.2,  color: 'accent' },
};

export const LAYOUT_IDS = ['title', 'agenda', 'bullets', 'two_col', 'metrics', 'quote', 'closing'];

export const LAYOUT_LABEL = {
  title: '封面', agenda: '目录', bullets: '要点', two_col: '对比',
  metrics: '指标', quote: '引用', closing: '结尾',
};

export const LIMITS = {
  minSlides: 5, maxSlides: 12,
  title: 40, subtitle: 30, heading: 40,
  bulletLen: 28, bulletCount: 5, agendaCount: 6,
  metricValue: 8, metricLabel: 12, metricCount: 4,
  colItemLen: 22, colItemCount: 4,
  quoteLen: 60, attributionLen: 30,
  notes: 220,
};

// ---------- 文本工具 ----------

export function truncate(s, max) {
  if (typeof s !== 'string') return '';
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length <= max ? t : t.slice(0, Math.max(0, max - 1)) + '…';
}

function arr(v) { return Array.isArray(v) ? v : []; }

// ---------- 文本度量 ----------
//
// 为什么不用 DOM 量：DOM 测量只有画布能做，缩略图和 pptx 导出没有 DOM 可量。
// 结果就是画布偷偷缩小字号放得下、缩略图和 pptx 却按名义字号换行 —— 所见非所得。
// 所以改成**纯函数估算**，三处（画布 / 缩略图 / pptx）共用同一个结果。

/** 单个字符的宽度（以 em 为单位）。CJK 及全角标点记 1em，西文记 0.55em。 */
function charWidthEm(ch) {
  const c = ch.codePointAt(0);
  const wide =
    (c >= 0x2e80 && c <= 0x9fff) ||   // CJK 部首 ~ 中日韩统一表意
    (c >= 0xf900 && c <= 0xfaff) ||   // 兼容表意
    (c >= 0xff00 && c <= 0xff60) ||   // 全角形式
    (c >= 0x3000 && c <= 0x303f);     // CJK 标点
  if (/\s/.test(ch)) return 0.3;
  return wide ? 1 : 0.55;
}

/** 给定字号和框宽，估算会折成几行 */
export function countLines(text, fontSize, boxWidth) {
  const perLine = (boxWidth * 0.96) / fontSize;   // 留 4% 余量：粗体 CJK 略宽于 1em
  let em = 0;
  let lines = 1;
  for (const ch of String(text || '')) {
    if (ch === '\n') { lines += 1; em = 0; continue; }
    const w = charWidthEm(ch);
    if (em + w > perLine) { lines += 1; em = w; } else { em += w; }
  }
  return lines;
}

/**
 * 求能放下的最大字号：从名义字号往下试，直到总高度不超过框高。
 * 下限是名义字号的 55%——再小就不如换版式，让用户看到问题而不是糊成一片。
 */
export function fitFontSize(text, role, boxW, boxH) {
  const st = ROLE_STYLE[role] || ROLE_STYLE.bullet;
  const min = Math.max(12, Math.round(st.size * 0.55));
  let size = st.size;
  while (size > min) {
    const lines = countLines(text, size, boxW);
    if (lines * size * st.lh <= boxH) return size;
    size -= 2;
  }
  return min;
}

// ---------- 版式几何 ----------
// 返回绝对定位的元素列表。所有数值都是 1280×720 基准下的像素。
// 每个文本元素都带 `size`（已按框大小算好的字号），
// 画布、缩略图、pptx 导出都读它，保证三者一致。

export function buildElements(slide, index, total) {
  const M = CANVAS.margin;
  const W = CANVAS.w - M * 2;
  const els = [];
  const push = (x, y, w, h, role, text, extra) => {
    const t = text || '';
    els.push(Object.assign(
      { x, y, w, h, role, text: t, size: fitFontSize(t, role, w, h) },
      extra || {}
    ));
  };

  const headingRule = (y) => els.push({ kind: 'rule', x: M, y, w: W, h: 1 });

  switch (slide.layout) {
    case 'title':
      push(M, 230, W, 150, 'title', slide.title);
      els.push({ kind: 'rule', x: M, y: 404, w: 120, h: 4 });
      push(M, 436, W - 60, 46, 'subtitle', slide.subtitle);
      break;

    case 'agenda': {
      push(M, 72, W, 62, 'heading', slide.title || '目录');
      headingRule(150);
      const items = arr(slide.bullets).slice(0, LIMITS.agendaCount);
      items.forEach((it, i) => {
        const col = i % 2;
        const row = Math.floor(i / 2);
        push(M + col * 570, 196 + row * 104, 530, 48, 'agenda', `${i + 1}   ${it}`);
      });
      break;
    }

    case 'bullets': {
      push(M, 72, W, 70, 'heading', slide.title);
      headingRule(158);
      arr(slide.bullets).slice(0, LIMITS.bulletCount).forEach((b, i) => {
        push(M, 212 + i * 84, W, 70, 'bullet', `—  ${b}`);
      });
      break;
    }

    case 'two_col': {
      push(M, 72, W, 70, 'heading', slide.title);
      headingRule(158);
      const cols = arr(slide.columns).slice(0, 2);
      cols.forEach((c, ci) => {
        const x = M + ci * 570;
        push(x, 196, 530, 40, 'collabel', c.heading);
        arr(c.items).slice(0, LIMITS.colItemCount).forEach((it, i) => {
          push(x, 252 + i * 58, 530, 50, 'colitem', `·  ${it}`);
        });
      });
      break;
    }

    case 'metrics': {
      push(M, 72, W, 70, 'heading', slide.title);
      headingRule(158);
      const ms = arr(slide.metrics).slice(0, LIMITS.metricCount);
      const n = Math.max(1, ms.length);
      const cw = W / n;
      ms.forEach((m, i) => {
        const x = M + i * cw;
        push(x, 250, cw - 20, 116, 'metric', m.value);
        push(x, 376, cw - 20, 44, 'metriclabel', m.label);
      });
      break;
    }

    case 'quote': {
      const q = slide.quote || {};
      push(140, 206, 1000, 250, 'quote', q.text, { align: 'center' });
      push(140, 478, 1000, 40, 'attribution', q.attribution, { align: 'center' });
      break;
    }

    case 'closing': {
      push(M, 272, W, 124, 'closingTitle', slide.title, { align: 'center' });
      push(M, 414, W, 44, 'subtitle', slide.subtitle, { align: 'center' });
      break;
    }

    default:
      push(M, 72, W, 70, 'heading', slide.title);
      headingRule(158);
  }

  if (slide.layout !== 'title' && slide.layout !== 'closing') {
    // 环节标签：让读者一眼知道自己在叙事线的哪一段
    if (slide.sectionTitle) {
      push(M, 34, W - 100, 26, 'kicker', slide.sectionTitle);
    }

    // 环节进度条：当前环节高亮，其余用分隔线颜色
    const n = slide.sectionCount || 0;
    const cur = typeof slide.sectionIndex === 'number' ? slide.sectionIndex : -1;
    if (n > 1 && cur >= 0) {
      const gap = 8;
      const segW = (W - gap * (n - 1)) / n;
      for (let k = 0; k < n; k++) {
        els.push({
          kind: 'rule',
          x: M + k * (segW + gap),
          y: 686,
          w: segW,
          h: 3,
          colorKey: k === cur ? 'accent' : 'line',
        });
      }
    }

    push(1140, 650, 60, 28, 'pagenum', `${index + 1} / ${total}`, { align: 'right' });
  }
  return els;
}

// ---------- 叙事骨架 ----------
//
// 大纲不让模型自由发挥：**环节和每环节占几页由代码算好**，模型只负责
// 在每个格子里填标题和说明。否则模型会自己拆页、漏环节、顺序乱跳。

export const SKELETONS = {
  proposal: {
    label: '提案 / 立项',
    sections: [
      { key: 'background', title: '背景', layout: 'bullets' },
      { key: 'problem', title: '问题', layout: 'two_col' },
      { key: 'solution', title: '方案', layout: 'bullets' },
      { key: 'cost', title: '预期成本', layout: 'metrics' },
      { key: 'benefit', title: '预期收益', layout: 'metrics' },
    ],
  },
  review: {
    label: '回顾 / 复盘',
    sections: [
      { key: 'background', title: '背景与目标', layout: 'bullets' },
      { key: 'result', title: '结果', layout: 'metrics' },
      { key: 'why', title: '原因分析', layout: 'two_col' },
      { key: 'improve', title: '改进措施', layout: 'bullets' },
      { key: 'next', title: '下一步', layout: 'bullets' },
    ],
  },
};

export const DEFAULT_SKELETON = 'proposal';

/** 分配超出基础页数的优先顺序：方案和收益最需要展开 */
const GROW_ORDER = ['solution', 'benefit', 'result', 'cost_benefit', 'problem', 'why', 'improve', 'next', 'background'];

/**
 * 给模型一个**参考分配**（不是强制）。
 * 每个环节至少 1 页，富余页数按 GROW_ORDER 轮转。
 * 注意：不合并环节——合并会让 section key 和骨架对不上。
 */
export function suggestPages(sections, contentCount) {
  const counts = sections.map(() => 1);
  const growable = GROW_ORDER
    .map((k) => sections.findIndex((s) => s.key === k))
    .filter((i) => i >= 0);
  let extra = Math.max(0, contentCount - sections.length);
  let p = 0;
  while (extra > 0 && growable.length) {
    counts[growable[p % growable.length]] += 1;
    extra -= 1;
    p += 1;
  }
  return counts;
}

function normBullets(v, maxCount, maxLen) {
  return arr(v)
    .map((x) => truncate(typeof x === 'string' ? x : (x && x.text) || '', maxLen))
    .filter(Boolean)
    .slice(0, maxCount);
}

function normSlide(raw, i) {
  const s = raw && typeof raw === 'object' ? raw : {};
  let layout = LAYOUT_IDS.includes(s.layout) ? s.layout : 'bullets';
  if (i === 0) layout = 'title';
  const out = {
    layout,
    title: truncate(s.title || '', LIMITS.heading),
    subtitle: truncate(s.subtitle || '', LIMITS.subtitle),
    notes: truncate(s.notes || '', LIMITS.notes),
  };

  if (layout === 'agenda' || layout === 'bullets') {
    out.bullets = normBullets(s.bullets, layout === 'agenda' ? LIMITS.agendaCount : LIMITS.bulletCount, layout === 'agenda' ? 24 : LIMITS.bulletLen);
    if (layout === 'bullets' && out.bullets.length < 2) {
      out.layout = layout = 'bullets';
      out.bullets = out.bullets.length ? out.bullets : ['（内容待补充）'];
    }
  }

  if (layout === 'two_col') {
    out.columns = arr(s.columns).slice(0, 2).map((c) => ({
      heading: truncate((c && c.heading) || '', LIMITS.metricLabel),
      items: normBullets(c && c.items, LIMITS.colItemCount, LIMITS.colItemLen),
    }));
    if (out.columns.length < 2) {
      out.layout = 'bullets';
      out.bullets = out.columns.flatMap((c) => c.items).slice(0, LIMITS.bulletCount);
    }
  }

  if (layout === 'metrics') {
    out.metrics = arr(s.metrics).slice(0, LIMITS.metricCount).map((m) => ({
      value: truncate((m && m.value) || '', LIMITS.metricValue),
      label: truncate((m && m.label) || '', LIMITS.metricLabel),
    })).filter((m) => m.value);
    if (out.metrics.length < 2) {
      out.layout = 'bullets';
      out.bullets = out.metrics.length ? [`${out.metrics[0].value} ${out.metrics[0].label}`] : ['（内容待补充）'];
    }
  }

  if (layout === 'quote') {
    const q = s.quote && typeof s.quote === 'object' ? s.quote : {};
    out.quote = {
      text: truncate(q.text || s.title || '', LIMITS.quoteLen),
      attribution: truncate(q.attribution || '', LIMITS.attributionLen),
    };
    if (!out.quote.text) { out.layout = 'bullets'; out.bullets = ['（内容待补充）']; }
  }

  if (layout === 'closing') {
    out.title = truncate(s.title || '谢谢', 20);
    out.subtitle = truncate(s.subtitle || '', LIMITS.subtitle);
  }

  return out;
}

/**
 * 把任意模型输出修成合法 deck。
 * 原则：能修就修，不因为一处小问题让整份失败。
 */
export function normalizeDeck(raw) {
  const issues = [];
  const src = raw && typeof raw === 'object' ? raw : {};
  let slides = arr(src.slides).map((s, i) => normSlide(s, i));

  if (slides.length === 0) throw new Error('模型没有返回任何页面');

  if (slides.length < LIMITS.minSlides) {
    issues.push(`页数偏少（${slides.length}），已保留`);
  }
  if (slides.length > LIMITS.maxSlides) {
    slides = slides.slice(0, LIMITS.maxSlides);
    issues.push(`页数过多，已截断到 ${LIMITS.maxSlides} 页`);
  }

  // 强制封面在首、结尾在末
  if (slides[0].layout !== 'title') {
    slides.unshift(normSlide({ layout: 'title', title: src.title || '演示文稿', subtitle: src.subtitle || '' }, 0));
    issues.push('已补充封面');
  }
  if (slides[slides.length - 1].layout !== 'closing') {
    slides.push(normSlide({ layout: 'closing', title: '谢谢', subtitle: 'Q & A' }, slides.length));
    issues.push('已补充结尾页');
  }
  // 重排首尾的 layout 优先级
  slides[0].layout = 'title';
  slides[slides.length - 1].layout = 'closing';

  const deck = {
    title: truncate(src.title || slides[0].title || '演示文稿', LIMITS.title),
    subtitle: truncate(src.subtitle || '', LIMITS.subtitle),
    theme: THEME_IDS.includes(src.theme) ? src.theme : 'editorial',
    slides,
  };
  return { deck, issues };
}

/**
 * 把模型输出修成可用大纲。
 *
 * 分工变了：**骨架只是参考**，模型可以增删环节、自创环节。
 * 代码只保证四件事：
 *   1. 相邻同环节的页合并成一段，段序 = 模型给出的顺序（不强行改写成骨架顺序）
 *   2. 用骨架里已有的 key / 标题时，统一成骨架的规范名（避免同一环节叫出两个名）
 *   3. 封面和结尾自动补，且永远在首尾
 *   4. 总页数收敛到 4–12 页（超了才砍，欠着不管）
 */
export function normalizeOutline(raw, opts) {
  const { total, skeletonId } = opts || {};
  const sk = SKELETONS[skeletonId] || SKELETONS[DEFAULT_SKELETON];
  const known = new Map(sk.sections.map((s) => [s.key.toLowerCase(), s]));
  const knownByTitle = new Map(sk.sections.map((s) => [s.title, s]));

  const src = raw && typeof raw === 'object' ? raw : {};
  const FURNITURE = ['cover', 'closing'];
  const FURNITURE_TITLES = ['封面', '结尾', '封底'];
  const incoming = arr(src.slides)
    .map((s) => ({
      section: String((s && s.section) || '').trim(),
      sectionTitle: String((s && s.sectionTitle) || '').trim(),
      title: truncate((s && s.title) || '', LIMITS.heading),
      hint: truncate((s && (s.hint || s.summary)) || '', 60),
    }))
    .filter((s) => s.title)
    // 模型有时会把封面/结尾也吐出来（我们要求它别吐）。这里直接丢掉，
    // 否则它们会被当成"自创环节"，首尾就会出现两份。
    .filter((s) => !FURNITURE.includes(s.section.toLowerCase()))
    .filter((s) => !FURNITURE_TITLES.includes(s.sectionTitle));

  if (incoming.length === 0) throw new Error('模型没有返回有效大纲');

  // 分组成"段"：相邻同环节合并；没给 section 的续上一段
  const groups = [];
  let lastKey = '';
  let lastTitle = '';
  for (const it of incoming) {
    let key = it.section;
    let title = it.sectionTitle;

    const hit = (key && known.get(key.toLowerCase())) || (title && knownByTitle.get(title));
    if (hit) {
      key = hit.key;
      title = hit.title;
    } else if (key) {
      title = title || key;                 // 自创环节：保留模型的叫法
    } else if (lastKey) {
      key = lastKey;                        // 没标环节：当作上一段的续页
      title = lastTitle;
    } else {
      key = sk.sections[0].key;             // 第一页就没标
      title = sk.sections[0].title;
    }

    const tail = groups[groups.length - 1];
    if (tail && tail.key === key) tail.items.push(it);
    else groups.push({ key, title, items: [it] });

    lastKey = key;
    lastTitle = title;
  }

  // 超上限才砍，优先砍内容最多的那一段
  const cap = Math.min(LIMITS.maxSlides - 2, 10);
  const contentCount = () => groups.reduce((n, g) => n + g.items.length, 0);
  while (contentCount() > cap) {
    let big = groups[0];
    for (const g of groups) if (g.items.length > big.items.length) big = g;
    if (big.items.length <= 1) break;
    big.items.pop();
  }

  const deckTitle = truncate(src.title || '演示文稿', LIMITS.title);
  const deckSubtitle = truncate(src.subtitle || '', LIMITS.subtitle);

  const slides = [{
    section: 'cover', sectionTitle: '封面', layout: 'title',
    title: deckTitle, hint: '',
  }];

  for (const g of groups) {
    const base = known.get(g.key.toLowerCase());
    const layout = (base && base.layout) || 'bullets';
    for (const item of g.items) {
      slides.push({
        section: g.key,
        sectionTitle: g.title,
        layout,
        title: item.title,
        hint: item.hint,
      });
    }
  }

  slides.push({
    section: 'closing', sectionTitle: '结尾', layout: 'closing',
    title: '谢谢', hint: '',
  });

  return { title: deckTitle, subtitle: deckSubtitle, skeletonId: skeletonId || DEFAULT_SKELETON, slides };
}

/** 大纲质量检查（纯规则，不调模型，不花钱） */
export function outlineWarnings(outline) {
  const vague = ['概述', '介绍', '总结', '其他', '相关内容', '背景'];
  const last = outline.slides.length - 1;
  return outline.slides.map((s, i) => {
    // 封面和结尾页本来就该短，不参与判断
    if (i === 0 || i === last) return '';
    if (s.title.length < 3) return '标题太短';
    if (vague.some((v) => s.title === v || s.title === v + '页')) return '内容偏泛';
    if (/^(第|slide)/i.test(s.title)) return '标题不像内容';
    return '';
  });
}
