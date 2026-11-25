// tools/test-export.mjs — 单独验证导出链路，不调用模型（零额度消耗）
//
// 这条测试回答一个关键未知：files.upload_init 返回的是跨域 R2 预签名 URL，
// 而线上 bundle 的 CSP 是 connect-src 'self'。本地 harness 没有 CSP，
// 所以这里能验证的是「API 契约通不通」，CSP 那一层要等发布后在线上验。
//
// 用法：node tools/test-export.mjs

import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9335;
const profile = join(tmpdir(), 'anna-export-profile');
try { rmSync(profile, { recursive: true, force: true }); } catch {}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const chrome = spawn(CHROME, [
  '--headless=new',
  `--remote-debugging-port=${PORT}`,
  '--disable-gpu',
  '--no-first-run',
  `--user-data-dir=${profile}`,
  '--window-size=1180,900',
  'http://localhost:5180/',
], { stdio: 'ignore' });

let ws = null;
let nextId = 1;
const pending = new Map();
const logs = [];

function send(method, params = {}) {
  const id = nextId++;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    setTimeout(() => pending.delete(id), 120000);
  });
}

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
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result?.value;
}

const DECK = {
  title: '导出链路验证',
  subtitle: '不消耗模型额度',
  theme: 'editorial',
  slides: [
    { layout: 'title', title: '导出链路验证', subtitle: '不消耗模型额度' },
    { layout: 'bullets', title: '测什么', bullets: ['pptx 构建', '上传主路径', '宿主代下载'] },
    { layout: 'closing', title: '结束', subtitle: 'Q & A' },
  ],
};

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
  if (!wsUrl) throw new Error('连不上 Chrome');

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
      const t = (msg.params.args || []).map((a) => a.value ?? a.description ?? '').join(' ');
      logs.push('[' + msg.params.type + '] ' + t);
    }
  };
  await send('Page.enable');
  await send('Runtime.enable');

  for (let i = 0; i < 40; i++) {
    const ok = await inFrame('return !!(w.__deckfx && w.__deckfx.getAnna())').catch(() => false);
    if (ok === true) break;
    await sleep(300);
  }

  // 1. 构建 pptx（不调模型）
  const build = await inFrame(`
    const fx = w.__deckfx;
    const deck = ${JSON.stringify(DECK)};
    return fx.buildPptx(deck)
      .then((buf) => JSON.stringify({ ok: true, bytes: buf.byteLength }))
      .catch((e) => JSON.stringify({ ok: false, message: String(e && e.message) }));
  `);
  console.log('=== 1. 构建 pptx ===');
  console.log(String(build));

  // 2. 直接看 files.* 是否可用（不下载，只探测）
  const probeFiles = await inFrame(`
    const anna = w.__deckfx.getAnna();
    if (!anna.files || typeof anna.files.upload_init !== 'function') return JSON.stringify({ ok: false, why: 'no files namespace' });
    const bytes = new TextEncoder().encode('probe');
    return anna.files.upload_init({ path: 'probe/' + Date.now() + '.txt', content_type: 'text/plain', size: bytes.length })
      .then((r) => JSON.stringify({ ok: true, hasPutUrl: !!(r && (r.put_url || r.proxy_upload_url)), keys: Object.keys(r || {}) }))
      .catch((e) => JSON.stringify({ ok: false, message: String(e && e.message).slice(0, 200) }));
  `);
  console.log('\n=== 2. files.upload_init 探测 ===');
  console.log(String(probeFiles));

  // 3. 完整保存链路
  const save = await inFrame(`
    const fx = w.__deckfx;
    const deck = ${JSON.stringify(DECK)};
    const t0 = Date.now();
    return fx.buildPptx(deck)
      .then((buf) => fx.uploadAndSave(fx.getAnna(), buf, '导出链路验证.pptx'))
      .then((r) => JSON.stringify({ ok: true, ms: Date.now() - t0, result: r }))
      .catch((e) => JSON.stringify({ ok: false, ms: Date.now() - t0, message: String(e && e.message).slice(0, 300) }));
  `);
  console.log('\n=== 3. 完整保存链路（buildPptx → 上传 → 下载）===');
  console.log(String(save));

  console.log('\n=== 页面 console ===');
  (logs.length ? logs : ['（无输出）']).forEach((l) => console.log(l));

  ws.close();
  chrome.kill();
  process.exit(0);
}

main().catch((e) => {
  console.error('失败:', e.message);
  try { chrome.kill(); } catch { /* 忽略 */ }
  process.exit(1);
});
