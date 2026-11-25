// quota.js — 额度读取与展示
//
// 平台的文本生成单价没有公开，所以策略是「不估算，先测量」：
// 每次调用后读 _meta.quotaConsumed（真实计量值），并尝试从 llm.catalog
// 读 remainingCU。读不到就只显示消耗，不编造剩余。

function deepFind(node, key, depth) {
  if (depth > 6 || node == null || typeof node !== 'object') return null;
  if (Object.prototype.hasOwnProperty.call(node, key)) {
    const v = node[key];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
  }
  for (const k of Object.keys(node)) {
    const r = deepFind(node[k], key, depth + 1);
    if (r != null) return r;
  }
  return null;
}

export async function readRemaining(anna) {
  if (!anna || !anna.llm || typeof anna.llm.catalog !== 'function') return null;
  try {
    const cat = await anna.llm.catalog({});
    return deepFind(cat, 'remainingCU', 0);
  } catch (_) {
    return null;
  }
}

export function fmtCu(n) {
  if (n == null || !Number.isFinite(n)) return null;
  return Math.abs(n) >= 10 ? String(Math.round(n)) : String(Math.round(n * 10) / 10);
}
