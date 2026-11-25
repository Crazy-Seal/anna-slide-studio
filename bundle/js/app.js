// app.js — 编排：状态机 + 界面
//
// 工作流只有两步模型调用：
//   ① 大纲（1 次）→ 用户确认/编辑 → ② 正文（1 次）→ 渲染 → 导出
// 重写单页额外 +1 次。除此外没有任何模型调用（换主题、换版式、改字都是纯本地）。

import { AnnaAppRuntime } from '/static/anna-apps/_sdk/latest/index.js';
import {
  THEMES, THEME_IDS, LAYOUT_LABEL, LAYOUT_IDS, LIMITS,
  SKELETONS, DEFAULT_SKELETON,
  normalizeDeck, normalizeOutline, outlineWarnings,
} from './deck.js';
import { applyTheme, renderSlide, renderThumbs } from './render.js';
import {
  buildOutlineMessages, buildDeckMessages, buildRewriteMessages,
  callText, parseLooseJson, repairSystem, LlmError,
} from './ai.js';
import { buildPptx, uploadAndSave } from './export.js';
import { readRemaining, fmtCu } from './quota.js';

// ---------- 状态 ----------

const S = {
  phase: 'idle',
  brief: { topic: '', audience: 'general', pages: 8, tone: 'restrained', skeleton: DEFAULT_SKELETON },
  outline: null,
  deck: null,
  active: 0,
  anna: null,
  remaining: null,
  spent: 0,
  previewOnly: false,
};

const stage = document.getElementById('stage');
const quotaEl = document.getElementById('quota');
const resetBtn = document.getElementById('btn-reset');
const toastEl = document.getElementById('toast');

// ---------- 小工具 ----------

function h(tag, cls, text) {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text != null) el.textContent = text;
  return el;
}

let toastTimer = null;
function toast(msg, ms = 2600) {
  toastEl.textContent = msg;
  toastEl.hidden = false;
  requestAnimationFrame(() => toastEl.classList.add('show'));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toastEl.classList.remove('show');
    setTimeout(() => (toastEl.hidden = true), 220);
  }, ms);
}

function trackCost(cost) {
  if (typeof cost === 'number' && Number.isFinite(cost)) {
    S.spent += cost;
    if (S.remaining != null) S.remaining = Math.max(0, S.remaining - cost);
  }
  paintQuota();
}

function paintQuota() {
  const rem = fmtCu(S.remaining);
  const spent = fmtCu(S.spent);
  if (rem == null && !(spent && S.spent > 0)) {
    quotaEl.hidden = true;
    return;
  }
  quotaEl.hidden = false;
  const parts = [];
  if (rem != null) parts.push(`剩余 ${rem}`);
  if (S.spent > 0) parts.push(`本次 ${spent}`);
  quotaEl.textContent = parts.join(' · ');
  quotaEl.classList.toggle('warn', S.remaining != null && S.remaining < 20);
}

// ---------- 模型调用（含一次修复重试） ----------

async function generate(messages, maxTokens, normalize) {
  const first = await callText(S.anna, messages, maxTokens);
  trackCost(first.cost);
  if (first.stopReason === 'maxTokens') toast('内容偏长，已自动精简');

  try {
    return normalize(parseLooseJson(first.text));
  } catch (e) {
    // 唯一允许的第二次尝试：把坏文本回喂，只修语法不改内容
    toast('格式有点问题，正在修复…');
    const fix = await callText(S.anna, [
      { role: 'system', content: { type: 'text', text: repairSystem() } },
      { role: 'user', content: { type: 'text', text: String(first.text).slice(0, 8000) } },
    ], maxTokens);
    trackCost(fix.cost);
    return normalize(parseLooseJson(fix.text));
  }
}

// ---------- 视图：加载 / 错误 ----------

function viewLoading(msg) {
  stage.textContent = '';
  const box = h('div', 'loading');
  box.appendChild(h('div', 'spinner'));
  box.appendChild(h('div', null, msg));
  stage.appendChild(box);
}

function viewError(title, detail, onRetry) {
  stage.textContent = '';
  const box = h('div', 'error-box');
  box.appendChild(h('h3', null, title));
  box.appendChild(h('p', null, detail));
  if (onRetry) {
    const b = h('button', 'btn-secondary', '重试');
    b.addEventListener('click', onRetry);
    box.appendChild(b);
  }
  stage.appendChild(box);
}

// ---------- 视图：输入 ----------

const AUDIENCES = [['general', '通用'], ['mgmt', '管理层'], ['team', '团队'], ['client', '客户']];
const TONES = [['restrained', '克制'], ['clean', '简洁'], ['bold', '有力'], ['technical', '技术']];
const PAGES = [6, 8, 10, 12];
const SAMPLES = [
  '给产品团队做一次季度回顾，8 页，讲清成绩、问题和下季度计划',
  '向客户介绍我们的数据中台，10 页，突出稳定性和案例',
  '项目立项汇报：为什么要做这个功能，6 页',
];

function viewInput() {
  S.phase = 'idle';
  resetBtn.hidden = true;
  stage.textContent = '';

  const wrap = h('div', 'view-input');
  wrap.appendChild(h('h1', null, '要做一份什么 PPT？'));

  const ta = h('textarea', 'brief-input');
  ta.placeholder = '例如：给产品团队做一次季度回顾，讲清成绩、问题和下季度计划';
  ta.value = S.brief.topic || '';
  ta.addEventListener('input', () => (S.brief.topic = ta.value));
  wrap.appendChild(ta);

  const chipRow = (label, items, current, onPick) => {
    const row = h('div', 'option-row');
    row.appendChild(h('span', 'option-label', label));
    const chips = h('div', 'chips');
    items.forEach(([val, text]) => {
      const c = h('button', 'chip' + (String(current) === String(val) ? ' on' : ''), text);
      c.type = 'button';
      c.addEventListener('click', () => {
        chips.querySelectorAll('.chip').forEach((x) => x.classList.remove('on'));
        c.classList.add('on');
        onPick(val);
      });
      chips.appendChild(c);
    });
    row.appendChild(chips);
    return row;
  };

  wrap.appendChild(chipRow('听众', AUDIENCES, S.brief.audience, (v) => (S.brief.audience = v)));
  wrap.appendChild(chipRow('页数', PAGES.map((p) => [p, String(p)]), S.brief.pages, (v) => (S.brief.pages = Number(v))));
  wrap.appendChild(chipRow(
    '结构',
    Object.entries(SKELETONS).map(([k, v]) => [k, v.label]),
    S.brief.skeleton,
    (v) => (S.brief.skeleton = v)
  ));
  wrap.appendChild(chipRow('风格', TONES, S.brief.tone, (v) => (S.brief.tone = v)));

  const samples = h('div', 'samples');
  samples.appendChild(h('span', 'hint', '试试：'));
  SAMPLES.forEach((s) => {
    const b = h('button', 'sample', s.replace(/，\d+ 页.*$/, ''));
    b.type = 'button';
    b.addEventListener('click', () => {
      S.brief.topic = s;
      ta.value = s;
      ta.focus();
    });
    samples.appendChild(b);
  });
  wrap.appendChild(samples);

  const row = h('div', 'submit-row');
  const go = h('button', 'btn-primary', '生成大纲 →');
  go.addEventListener('click', () => {
    if (!ta.value.trim()) { ta.focus(); toast('先写一句想做什么'); return; }
    S.brief.topic = ta.value.trim();
    startOutline();
  });
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); go.click(); }
  });
  row.appendChild(go);
  row.appendChild(h('span', 'hint', '1 次调用 · 约 3 秒'));

  wrap.appendChild(row);
  stage.appendChild(wrap);
  ta.focus();
  paintQuota();
}

// ---------- 视图：大纲 ----------

function viewOutline() {
  S.phase = 'outline_ready';
  resetBtn.hidden = false;
  stage.textContent = '';

  const wrap = h('div', 'view-outline');

  const head = h('div', 'outline-head');
  head.appendChild(h('h2', null, `大纲 · ${S.outline.slides.length} 页`));
  const addTop = h('button', 'btn-ghost', '+ 加一页');
  addTop.addEventListener('click', () => {
    if (S.outline.slides.length >= LIMITS.maxSlides) { toast(`最多 ${LIMITS.maxSlides} 页`); return; }
    S.outline.slides.push({ title: '新的一页', hint: '' });
    viewOutline();
  });
  head.appendChild(addTop);
  wrap.appendChild(head);

  const list = h('div', 'outline-list');
  const warns = outlineWarnings(S.outline);

  S.outline.slides.forEach((s, i) => {
    const row = h('div', 'outline-row');
    row.appendChild(h('span', 'outline-num', String(i + 1)));
    if (s.sectionTitle) row.appendChild(h('span', 'section-tag', s.sectionTitle));

    const input = h('input', 'outline-title');
    input.type = 'text';
    input.value = s.title;
    input.addEventListener('input', () => (s.title = input.value));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
    });
    row.appendChild(input);

    if (warns[i]) row.appendChild(h('span', 'warn-dot', '⚠ ' + warns[i]));

    const tools = h('div', 'row-tools');
    const up = h('button', 'icon-btn', '↑');
    up.title = '上移';
    up.addEventListener('click', () => {
      if (i === 0) return;
      [S.outline.slides[i - 1], S.outline.slides[i]] = [S.outline.slides[i], S.outline.slides[i - 1]];
      viewOutline();
    });
    const down = h('button', 'icon-btn', '↓');
    down.title = '下移';
    down.addEventListener('click', () => {
      if (i === S.outline.slides.length - 1) return;
      [S.outline.slides[i + 1], S.outline.slides[i]] = [S.outline.slides[i], S.outline.slides[i + 1]];
      viewOutline();
    });
    const del = h('button', 'icon-btn danger', '✕');
    del.title = '删除';
    del.addEventListener('click', () => {
      if (S.outline.slides.length <= 3) { toast('至少留 3 页'); return; }
      S.outline.slides.splice(i, 1);
      viewOutline();
    });
    tools.appendChild(up); tools.appendChild(down); tools.appendChild(del);
    row.appendChild(tools);

    list.appendChild(row);
  });
  wrap.appendChild(list);

  const foot = h('div', 'outline-foot');
  foot.appendChild(h('span', 'hint', '结构比文字重要，这一步不花钱'));
  const go = h('button', 'btn-primary', '生成正文 →');
  go.addEventListener('click', () => {
    const empty = S.outline.slides.find((s) => !s.title.trim());
    if (empty) { toast('有一页标题是空的'); return; }
    startDeck();
  });
  foot.appendChild(go);
  wrap.appendChild(foot);

  stage.appendChild(wrap);
  paintQuota();
}

// ---------- 视图：画布 ----------

function viewDeck() {
  S.phase = 'deck_ready';
  resetBtn.hidden = false;
  stage.textContent = '';

  const wrap = h('div', 'view-deck');

  // 工具条
  const bar = h('div', 'deck-bar');
  const left = h('div', 'deck-bar-left');
  const back = h('button', 'btn-ghost', '← 大纲');
  back.addEventListener('click', () => viewOutline());
  left.appendChild(back);

  const seg = h('div', 'seg');
  THEME_IDS.forEach((id) => {
    const b = h('button', S.deck.theme === id ? 'on' : '', THEMES[id].label);
    b.type = 'button';
    b.addEventListener('click', () => {
      S.deck.theme = id;
      applyTheme(id);
      seg.querySelectorAll('button').forEach((x) => x.classList.remove('on'));
      b.classList.add('on');
      renderThumbs(thumbs, S.deck, S.active, selectSlide);
      mountSlide();
    });
    seg.appendChild(b);
  });
  left.appendChild(seg);
  bar.appendChild(left);

  const right = h('div', 'deck-bar-right');
  const layoutSel = document.createElement('select');
  layoutSel.className = 'btn-secondary';
  LAYOUT_IDS.forEach((id) => {
    const o = document.createElement('option');
    o.value = id;
    o.textContent = LAYOUT_LABEL[id];
    layoutSel.appendChild(o);
  });
  layoutSel.addEventListener('change', () => {
    const slide = S.deck.slides[S.active];
    slide.layout = layoutSel.value;
    // 换版式时补齐该版式需要的字段，避免渲染成空页
    if (layoutSel.value === 'bullets' && !slide.bullets) slide.bullets = ['（在此补充要点）'];
    if (layoutSel.value === 'two_col' && !slide.columns) {
      slide.columns = [{ heading: '左侧', items: ['（补充）'] }, { heading: '右侧', items: ['（补充）'] }];
    }
    if (layoutSel.value === 'metrics' && !slide.metrics) slide.metrics = [{ value: '—', label: '补充指标' }, { value: '—', label: '补充指标' }];
    if (layoutSel.value === 'quote' && !slide.quote) slide.quote = { text: slide.title || '（引文）', attribution: '' };
    if (layoutSel.value === 'agenda' && !slide.bullets) slide.bullets = ['第一部分', '第二部分', '第三部分'];
    renderThumbs(thumbs, S.deck, S.active, selectSlide);
    mountSlide();
  });
  right.appendChild(layoutSel);

  const rewrite = h('button', 'btn-secondary', '重写本页');
  rewrite.addEventListener('click', rewriteCurrent);
  right.appendChild(rewrite);

  const exp = h('button', 'btn-primary', '导出 .pptx');
  exp.addEventListener('click', doExport);
  right.appendChild(exp);
  bar.appendChild(right);
  wrap.appendChild(bar);

  // 缩略图
  const thumbs = h('div', 'thumbs');
  wrap.appendChild(thumbs);

  // 画布
  const area = h('div', 'canvas-area');
  const host = h('div', null);
  host.style.width = '100%';
  host.style.maxWidth = '1024px';
  area.appendChild(host);
  wrap.appendChild(area);

  stage.appendChild(wrap);

  const selectSlide = (i) => {
    S.active = Math.max(0, Math.min(i, S.deck.slides.length - 1));
    renderThumbs(thumbs, S.deck, S.active, selectSlide);
    mountSlide();
  };

  const mountSlide = () => {
    const slide = S.deck.slides[S.active];
    layoutSel.value = slide.layout;
    renderSlide(host, {
      slide,
      index: S.active,
      total: S.deck.slides.length,
      theme: S.deck.theme,
      editable: true,
      onChange: () => {
        renderThumbs(thumbs, S.deck, S.active, selectSlide);
      },
    });
  };

  renderThumbs(thumbs, S.deck, S.active, selectSlide);
  mountSlide();
  paintQuota();

  // 键盘翻页
  document.onkeydown = (e) => {
    if (document.activeElement && document.activeElement.isContentEditable) return;
    if (e.key === 'ArrowRight') selectSlide(S.active + 1);
    if (e.key === 'ArrowLeft') selectSlide(S.active - 1);
  };
}

// ---------- 流程 ----------

async function startOutline() {
  viewLoading('正在构思结构…');
  try {
    const msgs = buildOutlineMessages(S.brief);
    S.outline = await generate(
      msgs,
      1600,
      (raw) => normalizeOutline(raw, { total: S.brief.pages, skeletonId: S.brief.skeleton })
    );
    viewOutline();
  } catch (e) {
    showError(e, startOutline);
  }
}

async function startDeck() {
  viewLoading('正在写内容…');
  try {
    const msgs = buildDeckMessages(S.brief, S.outline);
    const { deck, issues } = await generate(msgs, 6000, normalizeDeck);
    // 把大纲的环节信息贴到每页上：成品要能看出叙事结构，不能只在大纲里体现。
    // 按「内容页对内容页」的顺序对齐，而不是绝对下标——模型多写或少写一页时
    // 绝对下标会整体错位，标签就会挂到错误的页上。
    const outlineSecs = S.outline.slides.filter(
      (s) => s.section !== 'cover' && s.section !== 'closing'
    );
    const secOrder = [...new Set(outlineSecs.map((s) => s.section))];

    deck.slides.forEach((sl, i) => {
      if (i === 0 || i === deck.slides.length - 1) return;   // 封面和结尾不挂环节
      const o = outlineSecs[i - 1] || outlineSecs[outlineSecs.length - 1];
      if (!o) return;
      sl.section = o.section;
      sl.sectionTitle = o.sectionTitle;
      sl.sectionIndex = Math.max(0, secOrder.indexOf(o.section));
      sl.sectionCount = secOrder.length;
    });

    S.deck = deck;
    S.active = 0;
    applyTheme(deck.theme);
    viewDeck();
    if (issues.length) toast(issues.join('；'));
  } catch (e) {
    showError(e, startDeck);
  }
}

async function rewriteCurrent() {
  const slide = S.deck.slides[S.active];
  const before = JSON.stringify(slide);
  toast('正在重写这一页…');
  try {
    const msgs = buildRewriteMessages(S.brief, S.outline, S.active);
    const raw = await generate(msgs, 1200, (x) => x);
    // 模型可能返回单页对象，也可能包一层 slides
    const one = raw && raw.slides ? raw.slides[0] : raw;
    const merged = normalizeDeck({ title: S.deck.title, slides: [one] }).deck.slides[0];
    // 重写会丢掉环节信息，这里补回来，否则这一页的环节标签和进度条会消失
    merged.section = slide.section;
    merged.sectionTitle = slide.sectionTitle;
    merged.sectionIndex = slide.sectionIndex;
    merged.sectionCount = slide.sectionCount;
    // 保留原位置，但保留首尾页的特殊性
    if (S.active === 0) merged.layout = 'title';
    if (S.active === S.deck.slides.length - 1) merged.layout = 'closing';
    S.deck.slides[S.active] = Object.assign({}, merged, { layout: slide.layout === 'title' || slide.layout === 'closing' ? slide.layout : merged.layout });
    viewDeck();
  } catch (e) {
    console.warn('[rewrite] 失败，恢复原样', e);
    toast(e instanceof LlmError ? e.message : '重写失败，已保留原内容');
  }
}

async function doExport() {
  const btn = stage.querySelector('.btn-primary');
  const label = btn ? btn.textContent : '';
  if (btn) { btn.disabled = true; btn.textContent = '正在打包…'; }
  try {
    const buf = await buildPptx(S.deck);
    const name = (S.deck.title || '演示文稿') + '.pptx';
    const r = await uploadAndSave(S.anna, buf, name);
    toast(r.mode === 'files' ? '已保存' : '文件已准备好，请查看下载');
  } catch (e) {
    console.error('[export]', e);
    toast('导出失败：' + ((e && e.message) || '未知错误'), 4000);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = label; }
  }
}

function showError(e, retry) {
  const code = e && e.code;
  if (code === 'quota_exceeded') {
    viewError('额度不足', e.message, null);
  } else if (code === 'llm_disabled') {
    viewError('未连接模型', '当前是本地预览模式。用 dev.cmd 启动并接入模型后再试。', retry);
  } else {
    viewError('生成失败', (e && e.message) || '未知错误。可以换个说法再试一次。', retry);
  }
}

// ---------- 启动 ----------

async function boot() {
  applyTheme('editorial');

  try {
    S.anna = await AnnaAppRuntime.connect();
    S.anna.window.set_title({ title: '幻灯片工坊' }).catch(() => {});
    S.remaining = await readRemaining(S.anna);
  } catch (e) {
    S.anna = null;
    S.previewOnly = true;
    console.warn('[boot] 未连接宿主，进入预览模式', e);
  }

  // 可能是主助手通过 open_app_view 带参数打开
  try {
    const payload = S.anna && (S.anna.entryPayload || (S.anna.entry_payload || null));
    if (payload && payload.topic) S.brief.topic = String(payload.topic).slice(0, 300);
  } catch (_) { /* 忽略 */ }

  // 本地验证脚本用的调试出口。只在 localhost 暴露，不进生产环境。
  if (location.hostname === 'localhost' || location.hostname === '127.0.0.1') {
    window.__deckfx = {
      buildPptx,
      uploadAndSave,
      getDeck: () => S.deck,
      getState: () => S,
      getAnna: () => S.anna,
    };
  }

  resetBtn.addEventListener('click', () => {
    S.outline = null; S.deck = null; S.active = 0; S.spent = 0;
    document.onkeydown = null;
    viewInput();
  });

  viewInput();
}

boot();
