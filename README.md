# 幻灯片工坊（Slide Studio）

一个 Anna App：把一句话变成一份**能下载、能继续编辑的 .pptx**。

先出大纲，你确认了再写正文；全程两次模型调用，导出的是真正的 PowerPoint 文件，
不是图片、不是 PDF。

## 交付信息

| 项 | 值 |
|---|---|
| 仓库 | <https://github.com/Crazy-Seal/anna-slide-studio> |
| App 名称 | 幻灯片工坊 |
| Slug | `slide-studio` |
| 完整标识 | `@crazyseal/slide-studio` |
| 平台 | <https://staging.anna.partners> |
| 截图 | `docs/screenshots/`（6 张，商店直接用 raw URL） |

---

## 现在做到哪了（M0 完成）

已经打通并验证过的：

| 环节 | 状态 |
|---|---|
| manifest（schema 4，无 Executa） | ✅ `validate --strict` 通过 |
| 输入 → 大纲 → 正文 → 画布 四态流转 | ✅ 浏览器实测（mock + 真实模型各一轮） |
| 7 种版式渲染 + 字号自适应 | ✅ |
| 4 套主题实时切换 | ✅ |
| 就地改字（点文字直接编辑） | ✅ |
| 生成真 .pptx | ✅ 8 页 / 112.9 KB / 合法 OOXML |
| pptx 内容校验 | ✅ 文字、字体、字号、页序全对 |
| 导出上传**主路径**（`files.*` → R2 → 宿主代下载） | ✅ APS 模式下 4.9 秒走通、未降级 |
| 接真实模型（qwen3.8-flash） | ✅ 两阶段均成功 |
| **额度实测** | ✅ **一份 8 页 deck = 0.70 CU** |

证据在 `.shots/`：界面截图 + `deck.pptx`（可直接用 PowerPoint 打开验货）。

### 额度账

平台默认模型是 `claude-sonnet-4.5`（约 34.7 CU/份），我们**显式指定** `qwen3.8-flash`：

| 模型 | 一份 deck | 1000 CU 能出 |
|---|---|---|
| `claude-sonnet-4.5`（平台默认，未指定时用它） | 34.7 CU | 约 28 份 |
| **`qwen3.8-flash`（我们的选择）** | **0.70 CU（实测）** | **约 1400 份** |

一次生成 = 大纲 1 次 + 正文 1 次 = 2 次模型调用。CU 有 0.01 的下限，所以调用次数本身也是成本。

---

## 怎么跑

依赖都锁在项目内，不写系统环境。

```powershell
cd E:\Projects\anna_ppt

# 本地开发（mock 模型，不花额度、不需要账号）
.\dev.cmd dev --slug slide-studio --mock-llm fixtures\replies.jsonl
# 浏览器打开 http://localhost:5180/

# 校验
.\dev.cmd validate --strict

# 重新生成 mock 数据
node tools/gen-fixtures.mjs

# 自动跑一遍全流程并截图（需要上一条 dev 正在运行）
node tools/shoot.mjs
```

> `dev.cmd` 会把 `UV_CACHE_DIR` 锁到项目内 `.uv-cache/`，并把 uv/uvx 的运行时不写进全局缓存。

---

## 代码结构

```
manifest.json          App 声明：schema 4、一个 studio 视图、无 required_executas
app.json               商店信息
bundle/
  index.html           外壳（CSP：无内联脚本）
  css/theme.css        全部样式，配色由 JS 注入 CSS 变量
  js/
    deck.js            数据契约：画布几何、主题、7 种版式、规范化与校验
    ai.js              提示词 + 模型调用 + 宽松 JSON 解析
    render.js          坐标驱动的 DOM 渲染 + 字号自适应 + 就地编辑
    export.js          PptxGenJS → ArrayBuffer → 上传 → 保存（双路径）
    quota.js           额度读取与展示
    app.js             状态机与界面编排
  vendor/
    pptxgen.bundle.js  450 KB，按需懒加载
fixtures/              本地 mock 应答
tools/                 mock 数据生成、CDP 截图脚本
docs/                  技术方案 + 产品设计
```

**没有构建工具**：原生 ES Module 直接跑。产物本来就是静态文件，多一层构建只多一处失败点。

---

## 几个关键设计决定

**1. 几何只定义一次。** `deck.js` 用 1280×720 像素坐标描述每个元素，渲染器直接用它，
导出时除以 128 换成英寸、字号乘 0.5625 换成磅。所以**预览里看到的排版就是 pptx 里的排版**，
不存在"网页和文件不一致"。

**2. 工作流，不是 Agent。** 做 PPT 是纯生成任务，平台没有"渲染幻灯片"这种工具可调。
挂 Agent 只会多转几圈、多花几倍 token，产出同样的 JSON。

**3. 模型只写内容，排版永远由代码算。** 文字超长先降字号、再截断，
所以模型写长了也不会把版式撑破。

**4. 额度当用户的钱。** 只调 2 次模型；格式化失败只允许修复重试 1 次；
不做后台预生成、不做静默调用、默认不生成图片（图片 12–42 CU/张）。

**5. 叙事骨架：给参考，不给枷锁。**
大纲不是让模型自由发挥，但也不写死结构。两套参考骨架（提案 / 复盘）只在提示词里当**建议**，
模型可以增删环节、自创环节（比如加「风险与对策」）。代码只保证四件事：

| 代码保证 | 为什么 |
|---|---|
| 封面第一、结尾最后 | 这两页不属于任何环节，不能让模型决定 |
| 相邻同环节合并成一段 | 否则一个环节会被拆成两段，进度条和标签都会乱 |
| 环节名归一（大小写 / 空格 / 显示名） | `Background` 和「背景」必须是同一个环节 |
| 总页数收敛到 4–12 | 只在超上限时砍，欠着不管——页数本来就是大概值 |

**环节在成品里可见**：每页左上角有环节标签（kicker），底部有环节进度条（当前段高亮）。
这两个元素和正文一样由 `deck.js` 生成，所以预览、缩略图、pptx 三处必然一致。

正文页与大纲的环节按**内容页对内容页**的顺序对齐，不是绝对下标——
否则模型多写或少写一页，后面所有标签都会错位一格。

---

## 已知问题 / 待验证

### 本地 mock 的硬限制（已读源码确认）

`anna-app-runtime-local` 的 mock 匹配器是：

```js
const entry = this.mocks.find(m => m.ns === 'llm' && m.method === 'complete') ?? null;
```

**它只取第一条 `llm.complete` 应答**，`contentIncludes` 不匹配时还会回落到同一条。
所以多个任务（大纲 / 正文 / 重写）没法靠一个 fixture 区分。

对策：把完整 deck 放第一条——大纲阶段 `normalizeOutline` 能从 `slides[].title`
正确提取出大纲，正文阶段拿到完整内容，一条数据跑通全流程。
接真实模型后两个阶段各自返回正确结构，不受影响。

### 导出上传：主路径已验证，CSP 仍待线上确认

**已验证**（`--storage aps`，不花模型额度，见 `tools/test-export.mjs`）：

```
files.upload_init  → 返回 upload_id / put_url / headers / expires_at / r2_key
PUT 到 put_url     → 成功
files.upload_finalize → 成功
files.download     → 宿主代下载
整条链路 4.9 秒，走的是主路径，没有降级
```

**仍未验证的一层**：线上 bundle 的 CSP 是 `connect-src 'self'`，而 `put_url` 指向跨域 R2。
本地 harness 不注入 CSP，所以本地能 PUT 成功**不代表线上也能**。

代码里保留了双路径：主路径失败自动降级 `upload.inline`（单次 RPC，无跨域请求）+ `<a download>`。
发布后第一件事就是实测这一层，再决定要不要裁掉降级分支。

### 平台侧 502 是已知故障

staging 的 LLM 请求会间歇性返回 `HTTP 502`（[官方定性为平台侧 text-model 故障](https://forum.anna.partners/t/text-sampling-502s-on-anna-partners-platform-side-text-model-outage-not-an-app-bug/114)，不是 App 的 bug）。

`ai.js` 的 `callText` 对传输层错误做 3 次退避重试（1.2s / 2.4s），额度不足和未连接**不重试**（重试没意义）。

---

## 下一步

1. 注册 Anna staging 账号 + 邮箱验证（拿额度）
2. 激活 Verified Developer（`/developer` 自助，即时）
3. `anna-app login --host <staging nexus>`
4. `.\dev.cmd dev --llm real` 接真实模型联调
5. 实测导出主路径，定最终方案
6. 准备商店素材（图标、6 张截图、简介）
7. `apps push` → `cut` → `submit-review` → 管理员 approve → `release`

详细的平台规则、发布流程、额度经济学见 `docs/anna-app-brief.md`。
