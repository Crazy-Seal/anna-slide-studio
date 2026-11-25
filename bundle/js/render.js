// render.js — 把 deck 数据渲染成 DOM
//
// 关键点：
// 1) 所有元素绝对定位 + 像素坐标（基准 1280×720），外层 transform: scale。
//    预览和 pptx 用同一份坐标，做到所见即所得。
// 2) 文字放不下时逐级缩小字号，而不是溢出。
// 3) 就地编辑靠"角色 + 同类序号"回写字段。

import { CANVAS, ROLE_STYLE, THEMES, buildElements } from './deck.js';

/** 把主题色注入 CSS 变量（单一事实源在 deck.js，导出 pptx 也用同一份） */
export function applyTheme(themeId) {
  const t = THEMES[themeId] || THEMES.editorial;
  const s = document.documentElement.style;
  s.setProperty('--bg', t.bg);
  s.setProperty('--panel', t.panel);
  s.setProperty('--slide-bg', t.slideBg);
  s.setProperty('--fg', t.fg);
  s.setProperty('--muted', t.muted);
  s.setProperty('--accent', t.accent);
  s.setProperty('--accent-fg', t.accentFg);
  s.setProperty('--line', t.line);
  s.setProperty('--canvas-bg', t.canvasBg);
  s.setProperty('--danger', '#B42318');
  s.setProperty('--warn', '#B54708');
  document.documentElement.setAttribute('data-theme', themeId);
}

function setPath(obj, path, value) {
  const parts = path.split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) cur = cur[parts[i]];
  if (cur == null) return false;
  cur[parts[parts.length - 1]] = value;
  return true;
}

/** 列表类角色才有前缀符号；标题类绝不能推导前缀（否则会吃掉开头的年份） */
const LIST_ROLES = new Set(['bullet', 'agenda', 'colitem']);

function fitText(el, minPx) {
  let size = parseFloat(el.style.fontSize) || 24;
  let guard = 60;
  while (guard-- > 0 && size > minPx) {
    if (el.scrollHeight <= el.clientHeight + 1) break;
    size -= 1;
    el.style.fontSize = size + 'px';
  }
}

/**
 * 渲染一页到 host（会清空 host）。
 * @param {HTMLElement} host
 * @param {object} opts { slide, index, total, theme, editable, onChange }
 */
export function renderSlide(host, { slide, index, total, theme, editable, onChange }) {
  const t = THEMES[theme] || THEMES.editorial;

  host.textContent = '';
  const frame = document.createElement('div');
  frame.className = 'slide-frame';
  const viewport = document.createElement('div');
  viewport.className = 'slide-viewport';
  frame.appendChild(viewport);

  const els = buildElements(slide, index, total);
  const roleSeq = Object.create(null);   // role -> 已出现次数
  const colItemSeq = [];                 // 每栏内部序号
  let colIdx = -1;
  const meta = [];                       // 与元素同序的 {role, k, ci, itemIdx}

  els.forEach((spec) => {
    if (spec.kind === 'rule') {
      const d = document.createElement('div');
      d.className = 'slide-rule';
      d.style.cssText = `left:${spec.x}px;top:${spec.y}px;width:${spec.w}px;height:${spec.h}px;`;
      d.style.background = t[spec.colorKey || 'accent'] || t.accent;
      viewport.appendChild(d);
      return;
    }

    const st = ROLE_STYLE[spec.role] || ROLE_STYLE.bullet;
    // 字号来自数据层（deck.js 已按框大小算好），不再用 DOM 测量缩小——
    // 否则画布会"偷偷"比缩略图和 pptx 更宽松，导致所见非所得。
    const size = spec.size || st.size;
    const el = document.createElement('div');
    el.className = 'slide-el';
    el.style.cssText =
      `left:${spec.x}px;top:${spec.y}px;width:${spec.w}px;height:${spec.h}px;` +
      `font-size:${size}px;font-weight:${st.weight};line-height:${st.lh};` +
      `color:${t[st.color] || t.fg};` + (spec.align ? `text-align:${spec.align};` : '');
    el.textContent = spec.text || '';

    const k = roleSeq[spec.role] || 0;
    roleSeq[spec.role] = k + 1;

    if (spec.role === 'collabel') {
      colIdx += 1;
      colItemSeq[colIdx] = 0;
    }
    let ci = -1;
    let itemIdx = -1;
    if (spec.role === 'colitem') {
      ci = Math.max(0, colIdx);
      itemIdx = colItemSeq[ci] || 0;
      colItemSeq[ci] = itemIdx + 1;
    }
    meta.push({ role: spec.role, k, ci, itemIdx });

    if (editable && spec.role !== 'pagenum' && spec.role !== 'metriclabel') {
      const m = LIST_ROLES.has(spec.role) ? String(spec.text).match(/^([—·]|\d+)\s+/) : null;
      const prefix = m ? m[0] : '';

      el.contentEditable = 'true';
      el.spellcheck = false;
      el.dataset.prefix = prefix;

      el.addEventListener('blur', () => {
        const raw = el.textContent || '';
        const p = el.dataset.prefix || '';
        let value = p && raw.startsWith(p) ? raw.slice(p.length) : raw;
        if (!p && LIST_ROLES.has(spec.role)) value = value.replace(/^[—·\s]+/, '');
        value = value.trim();

        let path = null;
        switch (spec.role) {
          case 'title': case 'heading': case 'closingTitle': path = 'title'; break;
          case 'subtitle': path = 'subtitle'; break;
          case 'bullet': case 'agenda': path = `bullets.${k}`; break;
          case 'collabel': path = `columns.${Math.max(0, colIdx - (0)) }.heading`; break;
          case 'colitem': path = `columns.${ci}.items.${itemIdx}`; break;
          case 'metric': path = `metrics.${k}.value`; break;
          case 'quote': path = 'quote.text'; break;
          case 'attribution': path = 'quote.attribution'; break;
          default: path = null;
        }
        // collabel 的 ci 需要按"该标签是第几个"换算，单独处理
        if (spec.role === 'collabel') {
          let n = -1;
          for (let i = 0; i < els.length; i++) {
            if (els[i].role === 'collabel') {
              n += 1;
              if (n === k) break;
            }
          }
          path = `columns.${Math.max(0, n)}.heading`;
        }

        if (path && onChange && value) {
          if (setPath(slide, path, value)) onChange(slide);
        }
      });

      el.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); el.blur(); }
      });
    }

    viewport.appendChild(el);
  });

  host.appendChild(frame);

  // 画布要同时受宽度和高度约束，否则宽屏下底部会被切掉
  const area = host.closest('.canvas-area');
  const fit = () => {
    const availW = (area ? area.clientWidth : window.innerWidth) - 44;
    const availH = (area ? area.clientHeight : window.innerHeight) - 44;
    if (availW <= 0 || availH <= 0) return;
    const w = Math.max(240, Math.min(availW, (availH * 16) / 9, 1024));
    frame.style.width = `${Math.round(w)}px`;
    viewport.style.transform = `scale(${w / CANVAS.w})`;
  };
  fit();
  if (typeof ResizeObserver !== 'undefined') new ResizeObserver(fit).observe(area || frame);
  return frame;
}

/** 缩略图列表（只读渲染，不挂编辑） */
export function renderThumbs(container, deck, activeIndex, onSelect) {
  const t = THEMES[deck.theme] || THEMES.editorial;
  container.textContent = '';

  deck.slides.forEach((slide, i) => {
    const d = document.createElement('div');
    d.className = 'thumb' + (i === activeIndex ? ' on' : '');
    d.title = slide.title || `第 ${i + 1} 页`;
    d.style.background = t.slideBg;

    const vp = document.createElement('div');
    vp.style.cssText =
      'position:absolute;top:0;left:0;width:1280px;height:720px;' +
      'transform-origin:top left;pointer-events:none;';

    buildElements(slide, i, deck.slides.length).forEach((spec) => {
      if (spec.kind === 'rule') {
        const r = document.createElement('div');
        r.style.cssText = `position:absolute;left:${spec.x}px;top:${spec.y}px;width:${spec.w}px;height:${spec.h}px;background:${t[spec.colorKey || 'accent'] || t.accent};`;
        vp.appendChild(r);
        return;
      }
      const st = ROLE_STYLE[spec.role] || ROLE_STYLE.bullet;
      const el = document.createElement('div');
      el.style.cssText =
        `position:absolute;left:${spec.x}px;top:${spec.y}px;width:${spec.w}px;height:${spec.h}px;` +
        `font-size:${spec.size || st.size}px;font-weight:${st.weight};line-height:${st.lh};color:${t[st.color] || t.fg};` +
        `overflow:hidden;white-space:pre-wrap;word-break:break-word;` +
        (spec.align ? `text-align:${spec.align};` : '');
      el.textContent = spec.text || '';
      vp.appendChild(el);
    });

    d.appendChild(vp);
    const idx = document.createElement('span');
    idx.className = 'thumb-idx';
    idx.textContent = String(i + 1);
    d.appendChild(idx);

    const applyScale = () => {
      const w = d.clientWidth;
      if (w) vp.style.transform = `scale(${w / CANVAS.w})`;
    };
    d.addEventListener('click', () => onSelect(i));
    container.appendChild(d);
    requestAnimationFrame(applyScale);
    if (typeof ResizeObserver !== 'undefined') new ResizeObserver(applyScale).observe(d);
  });
}
