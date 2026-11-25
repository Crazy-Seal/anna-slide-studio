// tools/measure.mjs — 量 App 内部的布局，不调模型（零额度）
// 用来判断"页面滚动"到底是 App 自己的问题，还是 harness 外壳的问题。

import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9341;
const DEV_PORT = process.env.ANNA_DEV_PORT || '5180';
const profile = join(tmpdir(), 'anna-measure-profile');
try { rmSync(profile, { recursive: true, force: true }); } catch {}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const chrome = spawn(CHROME, [
  '--headless=new',
  `--remote-debugging-port=${PORT}`,
  '--disable-gpu',
  '--no-first-run',
  `--user-data-dir=${profile}`,
  '--window-size=1400,900',
  `http://localhost:${DEV_PORT}/`,
], { stdio: 'ignore' });

let ws = null;
let nextId = 1;
const pending = new Map();

function send(method, params = {}) {
  const id = nextId++;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    setTimeout(() => pending.delete(id), 30000);
  });
}

async function evalTop(expr) {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  return r.result?.value;
}

async function evalFrame(expr) {
  return evalTop(`(() => {
    const f = document.querySelector('iframe');
    if (!f || !f.contentDocument) return '__NO_FRAME__';
    const d = f.contentDocument, w = f.contentWindow;
    return (function(){ ${expr} }).call(w);
  })()`);
}

async function main() {
  let wsUrl = null;
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = list.find((t) => t.type === 'page' && t.url.startsWith('http'));
      if (page?.webSocketDebuggerUrl) { wsUrl = page.webSocketDebuggerUrl; break; }
    } catch { /* 未就绪 */ }
    await sleep(250);
  }
  ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id);
      pending.delete(m.id);
      m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result);
    }
  };
  await send('Page.enable');
  await send('Runtime.enable');

  for (let i = 0; i < 40; i++) {
    const ok = await evalFrame('return !!d.querySelector(".view-input, .view-outline, .view-deck")').catch(() => false);
    if (ok === true) break;
    await sleep(300);
  }

  // 外层 harness 页面
  const outer = await evalTop(`JSON.stringify({
    viewport: [innerWidth, innerHeight],
    docHeight: document.documentElement.scrollHeight,
    pageScrolls: document.documentElement.scrollHeight > innerHeight + 1,
    iframeRect: (() => {
      const r = document.querySelector('iframe').getBoundingClientRect();
      return { top: Math.round(r.top), height: Math.round(r.height) };
    })(),
  })`);
  console.log('=== harness 外壳 ===');
  console.log(outer);

  // App 自己的 iframe
  const inner = await evalFrame(`
    const de = d.documentElement;
    const body = d.body;
    const stage = d.querySelector('.stage');
    const app = d.querySelector('.app');
    return JSON.stringify({
      viewport: [w.innerWidth, w.innerHeight],
      docScrollHeight: de.scrollHeight,
      bodyScrollHeight: body.scrollHeight,
      appHeight: app ? Math.round(app.getBoundingClientRect().height) : null,
      stageClient: stage ? stage.clientHeight : null,
      stageScroll: stage ? stage.scrollHeight : null,
      appScrolls: de.scrollHeight > w.innerHeight + 1,
      stageScrolls: stage ? stage.scrollHeight > stage.clientHeight + 1 : null,
      bodyOverflow: w.getComputedStyle(body).overflow,
    });
  `);
  console.log('\n=== App 内部 ===');
  console.log(inner);

  ws.close();
  chrome.kill();
  process.exit(0);
}

main().catch((e) => {
  console.error('失败:', e.message);
  try { chrome.kill(); } catch { /* 忽略 */ }
  process.exit(1);
});
