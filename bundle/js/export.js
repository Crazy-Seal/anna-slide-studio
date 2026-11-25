// export.js — 生成真正的 .pptx 并交付给用户
//
// 链路：deck 数据 → PptxGenJS → ArrayBuffer → 上传 → 宿主弹出保存框
//
// 上传走**双路径**，因为有一个读文档无法确认的假设：
//   files.upload_init 返回的是跨域 R2 预签名 PUT URL，而 bundle 的 CSP 是
//   connect-src 'self'。若平台没有自动放行 R2 域名，这一跳会被 CSP 拦掉。
//   所以：先试 files.*（能拿到宿主代下载，体验最好）；失败则降级
//   upload.inline（单次 RPC，无跨域请求）+ <a download>。
//   哪条能通，由 M3 在真实环境实测决定。

import { THEMES, ROLE_STYLE, PX_PER_INCH, PT_PER_PX, buildElements } from './deck.js';

const PPTX_MIME = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
const FONT_FACE = 'Microsoft YaHei';

let loaderPromise = null;

/** 懒加载 pptxgenjs：只有点导出时才拉这个 450KB 的包 */
export function ensurePptx() {
  if (window.PptxGenJS) return Promise.resolve(window.PptxGenJS);
  if (loaderPromise) return loaderPromise;
  loaderPromise = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = './vendor/pptxgen.bundle.js';
    s.async = true;
    s.onload = () => (window.PptxGenJS ? resolve(window.PptxGenJS) : reject(new Error('pptxgenjs 未定义')));
    s.onerror = () => reject(new Error('pptxgenjs 加载失败'));
    document.head.appendChild(s);
  });
  return loaderPromise;
}

const hex = (c) => String(c || '#000000').replace('#', '').toUpperCase();

/** deck → ArrayBuffer */
export async function buildPptx(deck, onProgress) {
  const PptxGenJS = await ensurePptx();
  const t = THEMES[deck.theme] || THEMES.editorial;

  const pptx = new PptxGenJS();
  pptx.layout = 'LAYOUT_16x9';   // 10in × 5.625in，正好对应 1280×720 @128ppi
  pptx.title = deck.title || '';

  const total = deck.slides.length;
  // ShapeType 在实例上是可选暴露的，取不到就退回字符串 'rect'
  const RECT = (pptx.ShapeType && pptx.ShapeType.rect) || 'rect';

  deck.slides.forEach((slide, i) => {
    const s = pptx.addSlide();
    s.background = { color: hex(t.slideBg) };

    buildElements(slide, i, total).forEach((spec) => {
      if (spec.kind === 'rule') {
        const col = hex(t[spec.colorKey || 'accent'] || t.accent);
        s.addShape(RECT, {
          x: spec.x / PX_PER_INCH,
          y: spec.y / PX_PER_INCH,
          w: spec.w / PX_PER_INCH,
          h: spec.h / PX_PER_INCH,
          fill: { color: col },
          line: { color: col, width: 0 },
        });
        return;
      }
      const st = ROLE_STYLE[spec.role] || ROLE_STYLE.bullet;
      const size = spec.size || st.size;   // 与画布、缩略图同源，保证不换行
      s.addText(String(spec.text || ''), {
        x: spec.x / PX_PER_INCH,
        y: spec.y / PX_PER_INCH,
        w: spec.w / PX_PER_INCH,
        h: spec.h / PX_PER_INCH,
        fontSize: Math.round(size * PT_PER_PX * 10) / 10,
        bold: st.weight >= 600,
        italic: !!st.italic,
        color: hex(t[st.color] || t.fg),
        fontFace: FONT_FACE,
        align: spec.align || 'left',
        valign: 'top',
        margin: 0,
        wrap: true,
        autoFit: false,
        fit: 'shrink',   // 最后一道保险：PowerPoint 侧也允许缩字而不是换行
      });
    });

    if (onProgress) onProgress((i + 1) / total);
  });

  return pptx.write({ outputType: 'arraybuffer' });
}

function toBase64(bytes) {
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

function safeName(name) {
  const base = String(name || 'deck')
    .replace(/\.pptx$/i, '')                 // 上游可能已带扩展名，避免 xxx.pptx.pptx
    .replace(/[\\/:*?"<>|\s]+/g, '-')
    .slice(0, 60);
  return `${base || 'deck'}.pptx`;
}

/**
 * 上传并让用户保存。
 * @returns {Promise<{mode:'files'|'upload', path:string}>}
 */
export async function uploadAndSave(anna, arrayBuffer, filename) {
  const bytes = new Uint8Array(arrayBuffer);
  const name = safeName(filename);

  // ---- 主路径：files.* 两段式 + 宿主代下载 ----
  if (anna && anna.files && typeof anna.files.upload_init === 'function') {
    const path = `exports/${Date.now()}-${name}`;
    try {
      const init = await anna.files.upload_init({
        path,
        content_type: PPTX_MIME,
        size: bytes.byteLength,
      });
      const putUrl = init && (init.put_url || init.proxy_upload_url);
      if (!putUrl) throw new Error('缺少上传地址');

      const headers = Object.assign({ 'Content-Type': PPTX_MIME }, init.headers || {});
      const res = await fetch(putUrl, { method: 'PUT', headers, body: bytes });
      if (!res.ok) throw new Error(`PUT 失败 ${res.status}`);

      await anna.files.upload_finalize({ path });
      await anna.files.download({ path, filename: name });
      return { mode: 'files', path };
    } catch (e) {
      // 静默降级；把原因留给控制台，不打扰用户
      console.warn('[export] files.* 路径不可用，降级到 upload.inline：', e && e.message);
    }
  }

  // ---- 降级路径：upload.inline 单次 RPC ----
  if (!anna || !anna.upload || typeof anna.upload.inline !== 'function') {
    throw new Error('当前环境不支持保存文件');
  }
  const up = await anna.upload.inline({
    filename: name,
    mime_type: PPTX_MIME,
    content_b64: toBase64(bytes),
    purpose: 'user_artifact',
  });

  if (up && up.download_url) {
    const a = document.createElement('a');
    a.href = up.download_url;
    a.download = name;
    a.rel = 'noopener';
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => a.remove(), 1000);
  }
  return { mode: 'upload', path: (up && up.r2_key) || '' };
}
