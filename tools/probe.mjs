// tools/probe.mjs — 接真实模型后的两项探测：
//   1. 平台有哪些文本模型、单价多少 CU（目录接口带 pricing，比文档准）
//   2. 一次极小调用的真实消耗 + 当前剩余额度
//
// 用法：node tools/probe.mjs

import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9334;
const profile = join(tmpdir(), 'anna-probe-profile');
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

function send(method, params = {}) {
  const id = nextId++;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    setTimeout(() => pending.delete(id), 90000);
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
    }
  };
  await send('Page.enable');
  await send('Runtime.enable');

  for (let i = 0; i < 40; i++) {
    const ok = await inFrame('return !!(w.__deckfx && w.__deckfx.getAnna())').catch(() => false);
    if (ok === true) break;
    await sleep(300);
  }

  // --- 1. 文本模型 + 单价（加 call 参数可跳过，只测调用）---
  if (!process.argv.includes('call')) {
  const models = await inFrame(`
    const anna = w.__deckfx.getAnna();
    return anna.llm.catalog({}).then((c) => {
      const texts = (c.models || []).filter((m) => (m.serviceTypes || []).includes('text'));
      return JSON.stringify({
        quota: c.quota || null,
        models: texts.map((m) => ({
          name: m.modelName,
          display: m.displayName,
          ctx: m.capabilities && m.capabilities.contextLength,
          maxOut: m.capabilities && m.capabilities.maxOutputTokens,
          structured: m.capabilities && m.capabilities.supportsStructuredOutput,
          vision: m.capabilities && m.capabilities.supportsVision,
          tools: m.capabilities && m.capabilities.supportsFunctionCalling,
          inCU: m.pricing && m.pricing.inputCU,
          outCU: m.pricing && m.pricing.outputCU,
          platformDefault: m.isPlatformDefault,
          userPreferred: m.isUserPreferred,
        })),
      });
    });
  `);

  const parsed = JSON.parse(models);
  console.log('=== 剩余额度 ===');
  console.log(JSON.stringify(parsed.quota));

  console.log('\n=== 文本模型（按输出单价升序）===');
  const rows = parsed.models.filter((m) => m.outCU != null).sort((a, b) => a.outCU - b.outCU);
  const pad = (s, n) => String(s).padEnd(n).slice(0, n);
  console.log(pad('model', 34) + pad('ctx', 8) + pad('maxOut', 8) + pad('JSON', 6) + pad('inCU/M', 10) + pad('outCU/M', 10) + 'flag');
  for (const m of rows) {
    const flag = (m.platformDefault ? 'DEFAULT ' : '') + (m.userPreferred ? 'PREFERRED' : '');
    console.log(
      pad(m.name, 34) + pad(m.ctx, 8) + pad(m.maxOut, 8) +
      pad(m.structured ? 'yes' : 'no', 6) + pad(m.inCU, 10) + pad(m.outCU, 10) + flag
    );
  }

  // 按我们的实际用量估算：输入 ~900 tok，输出 ~2500 tok
  console.log('\n=== 一份 8 页 deck 的成本估算（输入 900 / 输出 2500 tok）===');
  for (const m of rows) {
    const cu = (900 * m.inCU + 2500 * m.outCU) / 1e6;
    console.log('  ' + pad(m.name, 34) + cu.toFixed(1) + ' CU');
  }
  }

  // --- 2. 极小调用实测（带 modelPreferences，重试 3 次看是不是持续故障）---
  const probe = await inFrame(`
    const anna = w.__deckfx.getAnna();
    const msg = [{ role: 'user', content: { type: 'text', text: '回复两个字：收到' } }];
    const attempts = [];
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    return (async () => {
      for (let i = 1; i <= 3; i++) {
        try {
          const r = await anna.llm.complete({
            messages: msg,
            maxTokens: 16,
            modelPreferences: { hints: [{ name: 'qwen3.8-flash' }] },
          });
          return JSON.stringify({ ok: true, attempt: i, model: r.model,
            text: r.content && r.content.text, usage: r.usage,
            quotaConsumed: r._meta && r._meta.quotaConsumed });
        } catch (e) {
          attempts.push({ attempt: i, code: e && e.code, msg: String(e && e.message).slice(0, 80) });
          if (i < 3) await sleep(4000);
        }
      }
      return JSON.stringify({ ok: false, attempts });
    })();
  `);
  console.log('\n=== 极小调用实测（3 次重试）===');
  console.log(String(probe));

  // --- 3. 测结构化输出：iframe 的 llm.complete 到底认不认 responseFormat ---
  const rf = await inFrame(`
    const anna = w.__deckfx.getAnna();
    return anna.llm.complete({
      messages: [
        { role: 'system', content: { type: 'text', text: '只输出 JSON，不要任何解释。格式：{"ok":true,"n":1}' } },
        { role: 'user', content: { type: 'text', text: '测试' } },
      ],
      maxTokens: 60,
      modelPreferences: { hints: [{ name: 'qwen3.8-flash' }] },
      responseFormat: { type: 'json_object' },
    }).then((r) => JSON.stringify({
      ok: true,
      text: r.content && r.content.text,
      jsonValid: (() => { try { JSON.parse(r.content.text); return true; } catch { return false; } })(),
      responseFormatMeta: r._meta && r._meta.responseFormat,
      quotaConsumed: r._meta && r._meta.quotaConsumed,
    })).catch((e) => JSON.stringify({ ok: false, code: e && e.code, message: String(e && e.message).slice(0, 200) }));
  `);
  console.log('\n=== responseFormat 结构化输出测试 ===');
  console.log(String(rf));

  // --- 4. 决定性判断：传非法 responseFormat，看是被校验还是被忽略 ---
  const rfBad = await inFrame(`
    const anna = w.__deckfx.getAnna();
    return anna.llm.complete({
      messages: [{ role: 'user', content: { type: 'text', text: '说一句话' } }],
      maxTokens: 40,
      modelPreferences: { hints: [{ name: 'qwen3.8-flash' }] },
      responseFormat: { type: 'definitely_not_a_format' },
    }).then((r) => JSON.stringify({ ok: true, ignored: true, text: r.content && r.content.text }))
      .catch((e) => JSON.stringify({ ok: false, rejected: true, code: e && e.code, message: String(e && e.message).slice(0, 160) }));
  `);
  console.log('\n=== 非法 responseFormat（被校验 = 字段生效；被忽略 = 字段无效）===');
  console.log(String(rfBad));

  ws.close();
  chrome.kill();
  process.exit(0);
}

main().catch((e) => {
  console.error('失败:', e.message);
  try { chrome.kill(); } catch {}
  process.exit(1);
});
