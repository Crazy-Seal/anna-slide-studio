# 实现笔记

记录实现过程中的实测数据、设计取舍和已知问题。入门怎么跑见 [README](../README.md)。

---

## 1. 调用的平台能力

产品内部**不接任何第三方模型 API**，全部经由 Anna Host API：

| 平台能力 | 用在哪 | 说明 |
|---|---|---|
| `llm.complete` | 生成大纲、生成正文、重写单页 | 指定 `qwen3.8-flash`；`modelPreferences.hints[0].name` 已实测生效 |
| `llm.catalog` | 读 `quota.remainingCU` | 界面右上角实时显示剩余额度 |
| `files.upload_init` / `files.upload_finalize` | 保存 .pptx | 浏览器直传 R2，用宿主签发的预签名地址 |
| `files.download` | 让用户保存文件 | 宿主代下载，不依赖 iframe 的 sandbox 权限 |
| `window.set_title` | 设置窗口标题 | — |
| `system_prompt_addendum` | 聊天里 `#幻灯片工坊` 时被主助手召唤 | 在 manifest 中声明 |

一次完整生成 = **2 次模型调用**（大纲 1 次 + 正文 1 次）。

---

## 2. 实测数据

| 环节 | 结果 |
|---|---|
| manifest（schema 4，无 Executa） | `validate --strict` 通过 |
| 输入 → 大纲 → 正文 → 画布 四态流转 | 浏览器实测，mock 与真实模型各一轮 |
| 7 种版式渲染 + 字号自适应 | 通过 |
| 4 套主题实时切换 | 通过 |
| 就地改字 | 通过 |
| 生成 .pptx | 8 页 / 112.9 KB / 合法 OOXML |
| pptx 内容校验 | 文字、字体、字号、页序均正确 |
| 导出主路径（`files.*` → R2 → 宿主代下载） | APS 模式下 4.9 秒走通，未降级 |
| 真实模型两阶段 | 均成功 |
| **额度实测** | **一份 8 页 deck = 0.70 CU** |

---

## 3. 额度账

平台默认模型是 `claude-sonnet-4.5`（同规模约 34.7 CU/份）。显式指定 `qwen3.8-flash` 后：

| 模型 | 一份 8 页 deck | 1000 CU 能出 |
|---|---|---|
| `claude-sonnet-4.5`（不指定时用它） | 34.7 CU | 约 28 份 |
| **`qwen3.8-flash`（当前选择）** | **0.70 CU（实测）** | **约 1400 份** |

CU 有 **0.01 的下限**，29 输入 + 1 输出 token 也收 0.01——所以调用次数本身也是成本，
不只是 token 量。这也是"两次调用"架构多出来的一条理由。

---

## 4. 关键设计取舍

### 4.1 几何与字号只有一份

`deck.js` 用 1280×720 像素坐标描述每个元素，并在这里算出每个文本元素的最终字号
（`fitFontSize`，纯函数估算，不依赖 DOM）。

渲染器、缩略图、pptx 导出都读同一个 `size`，导出时坐标除以 128 换成英寸、字号乘 0.5625 换成磅。
所以**预览看到的排版就是 pptx 里的排版**。

> 早期版本让画布用 DOM 测量动态缩字号，而缩略图和 pptx 用名义字号，
> 结果同一个"1个工作日"在画布是一行、在缩略图和 pptx 里换行。这是"两套渲染各自兜底"
> 的典型后果。修法是把最终尺寸变成数据的一部分，而不是让每个消费者自己想办法。

### 4.2 工作流，不是 Agent

做 PPT 是纯生成任务，平台没有"渲染一页幻灯片"这种工具可调。挂 agent 只会多转几圈、
多花几倍 token，产出同样的 JSON。Agent 只在需要联网调研时有价值 → 留作 v2「深度模式」。

### 4.3 模型只写内容，排版永远由代码算

文字放不下时按框大小确定性降字号，最低到名义值的 55%。模型写长了也不会撑破版式。

### 4.4 额度当用户的钱

只调 2 次模型；格式化失败只允许修复重试 1 次；不做后台预生成、不做静默调用；
默认不生成图片（图片 12–42 CU/张）。传输层错误重试 3 次，额度不足和未连接不重试。

### 4.5 叙事骨架：给参考，不给枷锁

两套骨架（提案 / 复盘）在提示词里只作**建议**，模型可以增删、拆分、自创环节
（比如加「风险与对策」）。代码只保证四件事：

| 代码保证 | 为什么 |
|---|---|
| 封面第一、结尾最后 | 这两页不属于任何环节，不能让模型决定 |
| 相邻同环节合并成一段 | 否则一个环节会被拆成两段，标签和进度条都会乱 |
| 环节名归一（大小写 / 空格 / 显示名） | `Background` 和「背景」必须是同一个环节 |
| 总页数收敛到 4–12 | 只在超上限时砍，欠着不管——页数本来就是大概值 |

**环节在成品里可见**：每页左上角有环节标签，底部有环节进度条（当前段高亮）。
两者与正文一样由 `deck.js` 生成，因此三处一致。

正文页与大纲的环节按**内容页对内容页**的顺序对齐，不是绝对下标——否则模型多写或
少写一页，后面所有标签都会错位一格。

---

## 5. 已知问题

### 5.1 本地 mock 只取第一条应答（已读源码确认）

`anna-app-runtime-local` 的 mock 匹配器是：

```js
const entry = this.mocks.find(m => m.ns === 'llm' && m.method === 'complete') ?? null;
```

它只取**第一条** `llm.complete` 应答，`contentIncludes` 不匹配时还会回落到同一条。
所以多个任务（大纲 / 正文 / 重写）无法靠一个 fixture 区分。

对策：把完整 deck 放第一条——大纲阶段能从 `slides[].title` 正确提取出大纲，
正文阶段拿到完整内容，一条数据跑通全流程。接真实模型后不受此限制影响。

### 5.2 导出上传：主路径已验证，CSP 仍待线上确认

已验证（`--storage aps`，不消耗模型额度，见 `tools/test-export.mjs`）：

```
files.upload_init → 返回 upload_id / put_url / headers / expires_at / r2_key
PUT 到 put_url    → 成功
files.upload_finalize → 成功
files.download    → 宿主代下载
整条 4.9 秒，走主路径
```

**仍未验证的一层**：线上 bundle 的 CSP 是 `connect-src 'self'`，而 `put_url` 指向跨域 R2。
本地 harness 不注入 CSP，所以本地能 PUT 成功不代表线上也能。

代码保留双路径：主路径失败自动降级 `upload.inline`（单次 RPC，无跨域请求）+ `<a download>`。

### 5.3 平台侧 502 是已知故障

staging 的 LLM 请求会间歇性返回 `HTTP 502`（[官方定性为平台侧 text-model 故障](https://forum.anna.partners/t/text-sampling-502s-on-anna-partners-platform-side-text-model-outage-not-an-app-bug/114)，不是 App 的 bug）。

`ai.js` 的 `callText` 对传输层错误做 3 次退避重试（1.2s / 2.4s）。

### 5.4 iframe 路径不支持结构化输出

`llm.complete` 会**静默忽略** `responseFormat`——用非法值实测过，调用照常成功。
`responseFormat` 只在插件（Executa）的 `sampling/createMessage` 路径实现。

所以结构化输出只能靠：prompt 约束 + 自己校验 + 失败后修复重试一次。
