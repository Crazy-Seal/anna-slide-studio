// tools/shoot.mjs — 用 Chrome DevTools Protocol 驱动本地 harness，走完整个流程
//
// 既能跑 mock，也能跑真实模型：真实模型耗时不可预测，所以全部用轮询等待，
// 不用固定 sleep。结束时报告本次消耗的 CU。
//
// 用法：
//   node tools/shoot.mjs
// 前提：
//   另一个终端里跑着 .\dev.cmd dev --slug slide-studio
//   （或加 --mock-llm fixtures\replies.jsonl 跑 mock）

import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const shotsRoot = join(here, '..', '.shots');
const shots = process.env.ANNA_SHOT_DIR ? join(shotsRoot, process.env.ANNA_SHOT_DIR) : shotsRoot;
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const CDP_PORT = Number(process.env.ANNA_CDP_PORT || 9333);
const DEV_PORT = process.env.ANNA_DEV_PORT || '5180';
const APP_URL = `http://localhost:${DEV_PORT}/`;

mkdirSync(shots, { recursive: true });
const profile = join(tmpdir(), 'anna-shoot-profile');
try { rmSync(profile, { recursive: true, force: true }); } catch {}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const consoleLines = [];

const chrome = spawn(CHROME, [
  '--headless=new',
  `--remote-debugging-port=${CDP_PORT}`,
  '--disable-gpu',
  '--hide-scrollbars',
  '--no-first-run',
  '--no-default-browser-check',
  `--user-data-dir=${profile}`,
  '--window-size=1180,940',
  APP_URL,
], { stdio: 'ignore' });

let ws = null;
let nextId = 1;
const pending = new Map();

function send(method, params = {}) {
  const id = nextId++;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    setTimeout(() => pending.delete(id), 180000);
  });
}

async function findTarget() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
      const page = list.find((t) => t.type === 'page' && t.url.startsWith('http'));
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch { /* 端口未就绪 */ }
    await sleep(250);
  }
  throw new Error('未能连上 Chrome 调试端口');
}

async function topEval(expr) {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
  return r.result?.value;
}

/** 在 App 的 iframe 里求值（harness 下同源，可直接拿 contentDocument） */
async function inFrame(expr) {
  const r = await send('Runtime.evaluate', {
    expression: `(() => {
      const f = document.querySelector('iframe');
      if (!f || !f.contentDocument) return '__NO_FRAME__';
      const d = f.contentDocument;
      const w = f.contentWindow;
      return (function(){ ${expr} }).call(w);
    })()`,
    awaitPromise: true,
    returnByValue: true,
  });
  if (r.exceptionDetails) {
    throw new Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception?.description || ''));
  }
  return r.result?.value;
}

async function shot(name) {
  const { data } = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(shots, name), Buffer.from(data, 'base64'));
  console.log('  截图 ' + name);
}

/** 只截 App 的 iframe 区域，去掉 harness 外壳 */
async function shotApp(name) {
  const rect = await topEval(`(() => {
    const f = document.querySelector('iframe');
    if (!f) return '__NO_FRAME__';
    const r = f.getBoundingClientRect();
    return JSON.stringify({
      x: Math.round(r.x), y: Math.round(r.y),
      w: Math.round(r.width), h: Math.round(r.height),
    });
  })()`);
  if (rect === '__NO_FRAME__' || typeof rect !== 'string') return shot(name);
  const { x, y, w, h } = JSON.parse(rect);
  const { data } = await send('Page.captureScreenshot', {
    format: 'png',
    clip: { x, y, width: w, height: h, scale: 1 },
  });
  writeFileSync(join(shots, name), Buffer.from(data, 'base64'));
  console.log('  截图 ' + name + '  (' + w + '×' + h + ')');
}

/** 轮询等待选择器出现 */
async function waitFor(sel, timeoutMs, label) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const hit = await inFrame(`return !!d.querySelector(${JSON.stringify(sel)})`).catch(() => false);
    if (hit === true) return true;
    await sleep(400);
  }
  console.log('  超时等待 ' + label + '（' + sel + '）');
  return false;
}

async function errorText() {
  return inFrame('const e = d.querySelector(".error-box"); return e ? e.textContent : ""').catch(() => '');
}

async function finish() {
  try {
    const spent = await inFrame(
      'const s = w.__deckfx.getState(); return JSON.stringify({ spent: s.spent, remaining: s.remaining });'
    );
    console.log('  本次消耗：' + spent);
  } catch { /* 忽略 */ }
  console.log('\n=== 页面 console ===');
  const lines = consoleLines.length ? consoleLines.slice(0, 40) : ['（无输出）'];
  lines.forEach((l) => console.log(l));
  try { if (ws) ws.close(); } catch { /* 忽略 */ }
  try { chrome.kill(); } catch { /* 忽略 */ }
  process.exit(0);
}

async function main() {
  const wsUrl = await findTarget();
  ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result);
      return;
    }
    if (msg.method === 'Runtime.consoleAPICalled') {
      const text = (msg.params.args || []).map((a) => a.value ?? a.description ?? '').join(' ');
      consoleLines.push('[' + msg.params.type + '] ' + text);
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails || {};
      consoleLines.push('[exception] ' + (d.exception?.description || d.text));
    }
  };

  await send('Page.enable');
  await send('Runtime.enable');

  for (let i = 0; i < 40; i++) {
    const ok = await inFrame('return !!d.querySelector(".brief-input")').catch(() => false);
    if (ok === true) break;
    await sleep(300);
  }
  await sleep(700);
  await shotApp('01-input.png');

  // ① 生成大纲
  await inFrame(`
    const ta = d.querySelector('.brief-input');
    ta.value = '给产品团队做一次季度回顾，8 页，讲清成绩、问题和下季度计划';
    ta.dispatchEvent(new w.Event('input', { bubbles: true }));
    d.querySelector('.btn-primary').click();
    return 'clicked';
  `);

  const outlineOK = await waitFor('.view-outline', 90000, '大纲');
  if (!outlineOK) {
    console.log('  大纲失败：' + (await errorText()));
    await shotApp('02b-error.png');
    return finish();
  }
  console.log('  大纲 ✓');
  await shotApp('02-outline.png');

  // ② 生成正文
  await inFrame(`
    const go = [...d.querySelectorAll('.btn-primary')].find((b) => b.textContent.includes('生成正文'));
    if (go) go.click();
    return !!go;
  `);

  const deckOK = await waitFor('.view-deck', 240000, '画布');
  if (!deckOK) {
    console.log('  正文失败：' + (await errorText()));
    await shotApp('02b-error.png');
    return finish();
  }
  console.log('  画布 ✓');

  const summary = await inFrame(`
    const s = w.__deckfx.getState();
    return JSON.stringify(s.deck.slides.map((x) => ({
      l: x.layout, t: (x.title || '').slice(0, 16),
      b: (x.bullets || []).length, c: (x.columns || []).length,
      m: (x.metrics || []).length, q: x.quote ? 1 : 0,
    })));
  `);
  console.log('  deck 摘要：' + summary);
  console.log('  页数：' + (await inFrame('return w.__deckfx.getState().deck.slides.length')));

  await shotApp('03-deck-cover.png');

  // 统一用「简洁」主题：和图标那抹蓝呼应
  await inFrame(`
    const b = [...d.querySelectorAll('.seg button')].find((x) => x.textContent.trim() === '简洁');
    if (b) b.click();
    return !!b;
  `);
  await sleep(600);

  // 「左右对比」页
  await inFrame(`
    const th = [...d.querySelectorAll('.thumb')];
    if (th[2]) th[2].click();
    return th.length;
  `);
  await sleep(700);
  await shotApp('04-deck-twocol.png');

  // 「指标」页
  await inFrame(`
    const th = [...d.querySelectorAll('.thumb')];
    if (th[7]) th[7].click();
    return th.length;
  `);
  await sleep(700);
  await shotApp('05-deck-metrics.png');

  // 取真实生成的 pptx 字节
  try {
    const b64 = await inFrame(`
      const fx = w.__deckfx;
      if (!fx) return '__NO_HOOK__';
      return fx.buildPptx(fx.getDeck()).then((buf) => {
        const bytes = new Uint8Array(buf);
        let s = '';
        const C = 0x8000;
        for (let i = 0; i < bytes.length; i += C) s += String.fromCharCode.apply(null, bytes.subarray(i, i + C));
        return btoa(s);
      });
    `);
    if (typeof b64 === 'string' && b64 !== '__NO_HOOK__') {
      const buf = Buffer.from(b64, 'base64');
      writeFileSync(join(shots, 'deck.pptx'), buf);
      console.log('  pptx  ' + (buf.length / 1024).toFixed(1) + ' KB');
    }
  } catch (e) {
    console.log('  取 pptx 失败：' + e.message);
  }

  // ③ 触发导出（真实环境会先试 files.* 主路径）
  await inFrame(`
    const b = [...d.querySelectorAll('.btn-primary')].find((x) => x.textContent.includes('导出'));
    if (b) b.click();
    return !!b;
  `);
  // 等导出完成（轮询 toast，最多 40 秒），别用固定 sleep
  let toast = '';
  for (let i = 0; i < 40; i++) {
    toast = await inFrame('const t = d.querySelector("#toast"); return t ? t.textContent : ""');
    if (toast) break;
    await sleep(1000);
  }
  console.log('  导出提示：' + JSON.stringify(toast));
  await shotApp('06-export.png');

  return finish();
}

main().catch((e) => {
  console.error('失败:', e.message);
  if (consoleLines.length) consoleLines.forEach((l) => console.error(l));
  try { chrome.kill(); } catch { /* 忽略 */ }
  process.exit(1);
});
