# v1 插件 → v2 App 迁移记录

源仓库：[139zbc/HanaAgent-plugins-mineru](https://github.com/139zbc/HanaAgent-plugins-mineru)
（`manifestVersion: 1`、`trust: full-access`、入口是 `export default class Plugin`）

目标：`manifestVersion: 2` 的 App，装在 `<HANA_HOME>/apps/mineru-document-workbench/`。

**当前状态：迁移完成，界面已用官方控件重写，可直接打包安装。**
0 error 通过 Hana 静态校验，94 个单元测试全绿，官方打包器产出可安装包，
生产边界冒烟通过，本地浏览器渲染验证通过。

---

## 一、迁移策略：适配层，而不是重写

搬过来的业务代码（`job-store` / `translate` / `parse-channels` / `markdown-render` /
6 个工具 / 3 组路由）**一行逻辑都没改**，靠 `v2-ctx.js` 把它们依赖的 v1 插件上下文
投影到 v2 App SDK 上。所有工程量集中在接口翻译这一层。

### 映射表

| v1 插件 ctx | v2 App SDK | 备注 |
| --- | --- | --- |
| `ctx.dataDir` | `sdk.dataDir` | v2 是 `{HANA_HOME}/app-data/{appId}` |
| `ctx.config.get/set` | `sdk.config.get/set` | 同一套 schema 词汇 |
| `ctx.log.*` | `sdk.logger.*` | 适配层同时挂 `log` 与 `logger` 两个名字 |
| `ctx.network.fetch` | `sdk.network.fetch` | 白名单字段名不变 |
| `ctx.resources.materialize` | `sdk.resources.materialize` | 适配层归一化出 `filePath` |
| `ctx.stageFile({filePath,label})` | `sdk.resources.stage({path,name})` | **由同步变异步**，见下 |
| `ctx.pluginId` | 适配层填 manifest id | v2 没有 `ctx.pluginId` |
| `ctx.pluginDir` | 无 | v2 安装目录只读，用 `import.meta.url`。已弃用 `routes/ui.js` |
| `ctx.bus.handle` | `sdk.bus.handle` | 未使用（v1 的 `:status` 服务名没有 v2 对应物） |

### 四个必须处理的差异

1. **`model:sample-text` 在 v2 被明确拒绝。**
   v2 的 `ctx.bus.request` 有公开允许清单，`model:sample-text` 不在其中。
   适配层拦截这个动词，用 `sdk.models.streamEvents()` 实现语义等价的行为
   （`systemPrompt` 原样发出，与 v1 约定一致；累积 `text-delta` 拼出 `{ text }` 回包）。
2. **`ctx.stageFile` 由同步变异步。**
   v1 里 `ctx.stageFile({...}).mediaItem` 是同步取值，v2 的 `sdk.resources.stage`
   返回 Promise。三个交付工具（`reference_result` / `recover_batch` / `translate_result`）
   的调用点已加 `await`，并去掉了手传的 `sessionId/sessionRef/sessionPath`
   ——v2 的 `stage` 自己带本次调用的会话令牌。
3. **v1 的「插件私有 agent」在 v2 不存在。**
   v1 用 `agent:create(ownerPluginId, visibility: "plugin_private")` 造了一个
   `mineru-translator` agent 来记住「翻译用哪个模型」。v2 里 App 不能创建这种 agent。
   适配层拦截 `agent:profile / agent:create / agent:update-config` 三个动词，
   把模型选择改存到 `sdk.storage.global`（本 App 私有，不需要额外能力授权）。
   业务侧代码与对外行为不变，`translate.v3.js` 一个字没改。
   （按你的决定，这是**长期方案**，不是临时过渡。）
4. **后端路由的注册方式变了，且必须二选一。**
   v2 支持两种互斥写法：入口里 `ctx.routes.register()`，或应用根目录放 `routes/` 目录。
   这里选了入口注册，路由源因此放在 `lib/routes/`（不是根目录的 `routes/`），
   避免宿主把两边都挂上导致整个应用 `failed`。
   路由地址：`/api/apps/mineru-document-workbench/routes/<子路径>`。

---

## 二、清单层面的变化

| v1 | v2 |
| --- | --- |
| `manifestVersion: 1` | `manifestVersion: 2` |
| `trust: full-access` | 删掉；改为逐条 `capabilities` |
| `capabilities: [network.fetch, resource.materialize, model.sample, provider.read, agent.write]` | `[app/tools.expose-to-model, app/session.stage-file, app/models.infer, app/resources.read, app/ui.clipboard-write]` |
| `contributes.configuration.properties` | `contributes.settings.schema.properties`（schema 词汇表同一套） |
| `contributes.page` + `contributes.widget`（两个手写路由表面） | `contributes.cards[0]`（一个卡片，`route: /panel.html`） |
| `ui.hostCapabilities: [clipboard.writeText, resource.pick]` | 改成能力词：`app/ui.clipboard-write`、`app/resources.read`。卡片不再单独协商宿主能力 |
| `network.allowedHosts/methods/...` | 不变（这些键名 v2 也认） |
| 无 `icon` | 新增 `icon: assets/icon.svg`（v2 新包必须有身份图标） |

还有一条不容忽视的差异：**v2 不给工具名加前缀**（v1 会自动加 `{插件id}_`）。
重名会让整个应用当场拒载，所以 `index.js` 手工补回了同一个前缀，
工具名与 v1 完全一致。

## 二·五、卡片界面：官方控件重写

界面外壳换成官方 App UI 控件，三栏布局由 `panel.css` 决定。

| 界面位置 | v1 做法 | v2 做法 |
| --- | --- | --- |
| 解析历史每一条 | 手写 `button` + `×` 删除钮 | 官方 `ListRow`（`onActivate` + `overflowItems` 放删除） |
| 删除确认 | 页内自绘确认块 | 保留页内确认，按钮换成官方 `Button` + `Inline` |
| Markdown / JSON / 译文 | 手写三个 `button` 切换 | 官方 `Tabs`（`variant: 'line'`） |
| 解析方式 / 目标语言 / 翻译模型 | 原生 `select`，语言是自绘浮层 | 官方 `Select` |
| 启用 OCR | 原生 checkbox | 官方 `Checkbox` |
| 各类操作按钮 | 手写 `button` | 官方 `Button`（primary / secondary / ghost / danger） |
| 空历史 | 一行纯文本 | 官方 `EmptyState` |
| 结果预览内容 | 服务端渲染的净化 HTML | **不变**（内容是文档，不是界面） |
| 结果图片 | 插件路由 + `blob:` 绕开凭据 | 不变思路，取数换成 `hana.api.fetch` |

三处实现约定（都是官方控件包的硬要求）：
- 挂载作用域：`<main data-hana-app-ui>`。没有它 `mountAppUi` 会以 `APP_UI_SCOPE_REQUIRED` 拒绝；
  挂载点还不能是 `<body>`/`<html>`。
- 一个元素只能挂一个控件（`APP_UI_NODE_OCCUPIED`）。`panel.js` 的 `renderCtrl` 因此
  记住每个 slot 挂的是哪个控件：同控件走 `handle.update()`，换控件才 `destroy()` 后重建。
- 控件是挂载出来的，不是页面上的原生表单元素——**取值一律读 `panel.js` 里的状态变量**，
  不能按 DOM id 去拿。每个 `onChange` 回写变量后再 `update` 一次，显示才跟着走。

语言清单的单一事实来源也顺势收紧了：v1 的页面自带一份 `TARGET_LANGUAGES`，
v2 改为由 `/options` 下发（`lib/routes/jobs.js` 里返回，来源是 `lib/translate.v3.js`），
并顺手把配置里可能存的早期写法（`english` / `简体中文`）用 `normalizeTargetLanguage`
归一化后再给页面，避免选择器的当前值与选项对不上。

### 视觉验证的发现（重要）

用本地浏览器渲染真实页面做了验证，结论分两半：

**已验证正常**：三栏布局、`ListRow`（含选中态与溢出菜单）、`Tabs` 选中态、
`Select`、`Checkbox`、`EmptyState`、`Inline`、danger 按钮、以及服务端渲染的
Markdown 排版（标题 / 表格 / 代码块 / 引用 / 列表）。

**依赖宿主变量**：控件内部是 Ant Design，颜色走一套 `--ant-*` 变量。
`app-ui.css` 引用 `--accent` / `--bg` / `--text` / `--border` / `--danger` 等
以及 `--control-height`、`--ant-button-default-border-color` 这类变量，
但**自己不定义它们**——设计上就是由宿主运行时注入。本地预览没有这套变量，
于是 outlined / solid 按钮呈扁平外观（背景与边框色解析为空）。

这一点值得注意的地方是：**`panel.css`（承自 v1）与 `app-ui.css` 用的是同一套变量名**，
所以「页面自己画的」与「官方控件画的」在真实宿主里跟着同一个主题走，
不会出现两套配色。预览时补上这套变量后，视觉即恢复正常。

**尚未验证**：官方控件在真实宿主里的最终配色与尺寸（`--control-height` 等由宿主给定）。
这需要真的装一次看，静态检查与本地预览都证明不了。

### 滚动只发生在预览区

用户反馈：在主卡里上下滚，整个卡片都在滚，标题和页签跟着走了。他们要的是
只滚中间那块结果区域。

根因有两条，必须一起改：

```css
/* 旧 */
.col { overflow: auto; }          /* ① 整栏都是滚动容器 */
.preview { min-height: 60%; overflow: auto; }  /* ② 只给下限、不给上限 */
```

① 让标题、页签、译文工具条都变成了可滚内容；② 让预览区随内容无限长高，
于是它自己那层 `overflow: auto` **永远不触发**——滚动自然全落到整栏上。

改法是把“谁滚”明确下来：左栏变成 flex 列、自己不出滚动条，预览区吃掉剩余高度
并自己滚。

```css
.col { min-width: 0; padding: 18px; }   /* 不再自己滚 */
.col-viewer {
  display: flex; flex-direction: column;
  min-height: 0;      /* 不写这条：内容一长就撑破本栏，滚动又回到整页 */
  overflow: hidden;
}
.preview {
  flex: 1 1 auto;     /* 吃掉剩余高度 */
  min-height: 0;      /* 同上：不写就不肯收缩 */
  overflow: auto;
}
```

两处 `min-height: 0` 都是“不写就坏”的：flex 子项默认 `min-height: auto`，
会拒绝缩到比内容还小。右栏（`.col-actions`）内容可能很长（上传区 + 翻译设置），
仍然整栏自己滚。

实测（无头 Edge，卡片 1180×700，结果文档 121 个节点 / 4908 字）：

| 指标 | 值 |
| --- | --- |
| 整页可滚高度 | 0 |
| 左栏可滚高度 | 0 |
| 预览区可滚高度 | 5030 |
| 预览滚到底后，标题视口位置 | 18 → 18（未动） |
| 预览滚到底后，页签视口位置 | 81 → 81（未动） |
| 预览区四周内边距 | 18 / 18（未被吃掉） |

---

## 二·六、侧栏（功能面板）

历史列表从主卡左侧栏搬到了宿主的功能面板——也就是你截图里那块「此页尚无清单」的区域。
那块文案的键是 `page.fpEmpty`，同族还有 `fpPaneFailed` / `fpPaneUntitled` / `fpPanelWaiting`，
`fp` 就是 Function Panel。DSHana 也把自己的侧栏放在这里。

### 落点

```json
"functionPanel": { "id": "history", "label": "解析历史", "route": "/sidebar.html" },
"fpFullPanel": true
```

`fpFullPanel` 只在 `realization: "page"` 上生效（本卡是整页卡）。
宿主卡片表里的投影与 DSHana 逐字同构。

### 职责与通信

约定：**侧栏只做「挑选」，主卡只做「查看与操作」**。主卡原先自带的历史栏已收掉，
两栏布局（结果预览 + 操作）。

两个页面是两个独立 iframe，**不共享 JS 对象**，所以通信走 App 存储：

| 方向 | 键 | 含义 |
| --- | --- | --- |
| 侧栏 → 主卡 | `ui.selectedJobId` | 选中了哪条历史 |
| 主卡 → 侧栏 | `ui.jobsRevision` | 列表变了，重拉 |

版本号用**递增计数**而不是 `Date.now()`：同一毫秒内的两次改动会写出同一个值，
订阅方可能收不到通知。

主卡只拿到一个 id，需要自己拉一次 `/jobs` 把它映射成任务对象（本地调用，很便宜）。
`syncSelection()` 在 id 未变时只刷新状态、**不重载预览**，否则列表每次变化都会
打断正在阅读的内容。

主卡新建任务后会把它设为当前选中（侧栏高亮它，主卡直接开始显示结果）。

**验证**（双 iframe 测试台，用 localStorage + `storage` 事件模拟跨文档通知）：

| 步骤 | 结果 |
| --- | --- |
| 初始 | 主卡两栏、无历史容器；侧栏 2 条、各带垃圾桶 |
| 侧栏点一条 | 主卡标题/元信息/预览全部切到该任务；侧栏高亮它 |
| 侧栏删除选中的那条 | 侧栏 2→1 条；主卡自动清空；`ui.selectedJobId` 置空 |

### 行内操作：刷新与删除

每行右侧两个图标（不可缩、不裁）：**刷新在左、删除在右**（先中性、后危险）。

- **刷新**：查询这一条的远端状态（`POST /jobs/:id/refresh`）。
  原先它是主卡右栏的「查询选中任务」——职责上它属于「对某条记录做操作」，
  所以随历史列表一起搬到了侧栏。查询中图标转圈（尊重 `prefers-reduced-motion`）。
- **删除**：弹确认（见下）。

上一版用 `ListRow` + `overflowItems` 做删除入口，在 ~350px 的窄侧栏里
溢出菜单被挤掉，只露出半个「操作」（截图里可见）。
改用自绘行 + 常驻图标，结构上就不会再被裁：
`.row-main { flex: 1 1 auto; min-width: 0 }` 负责可缩（长文件名走省略号），
`.row-refresh` / `.row-del { flex: none }` 负责不可缩。

图标都是内联 SVG：官方图标集只有 `chevron` / `check` / `loading` / `failure`，
没有垃圾桶与刷新；而 `IconButton` 要求 `children` 是 React 元素，页面侧造不出
（`appUi` 只认已注册控件、`appUiIcon` 只有那四个名字）。

### 刷新后的联动

行内刷新把任务查成「已完成」后，主卡必须**重取结果**，否则会一直显示
解析中时的旧内容。所以 `syncSelection()` 会检测选中任务的**状态变化**：
同一条通常只刷新状态、不重载预览（否则列表每次变化都会打断阅读），
但状态确实变了就重取预览与译文。

### 确认浮层

iframe 的 sandbox 不含 `allow-modals`，`window.confirm` 不可用；官方控件集里也
**没有 Modal/Dialog**。所以确认界面是页内浮层（`position: fixed` + backdrop，
只覆盖本侧栏），支持点背景或 Esc 关闭。

### 批量删除

头部「多选」进入批量模式：行首出现官方 Checkbox，底部出现操作条
（已选 N / M 项、全选 / 取消全选、删除 N 项）。清单合并为一条确认；
进行中的任务删除时带 `force`，否则服务端返回 409。

**窄宽度适配。** 实测这条操作条的内容需要 236px（即面板 ≥260px），再窄就开始溢出
（260px 时溢出 2px，越窄越明显）。修法是让它能换行，而不是缩小字号：

- `.batch { flex-wrap: wrap }` —— 装得下就一行，装不下就让操作落到下一行
- `.batch-text { min-width: 0 }` —— **这是关键**。默认 `min-width: auto` 会让
  `nowrap` 的文字拒绍收缩，结果是整条被撑破而不是换行
- `.batch-actions { flex: 0 1 auto; min-width: 0; flex-wrap: wrap }` ——
  不写 `min-width: 0` 时它以 max-content 宽度挺出去，内层永远换不了行；
  加上之后极端窄（≤200px）时按钮也能再叠一层

实测各宽度下均无溢出，且自适应：≥ 300px 一行；~240px 两行（计数一行 + 按钮一行）；
≤ 200px 三行。

### 固定置底的页脚

侧栏纵向分三段：**头部**（标题 + 多选/刷新）、**列表**（占满剩余空间、自己滚动）、
**页脚**（选中操作 + 批量操作 + 状态提示）。

怎么发现的：截图里选中操作区贴在列表下面、状态文字却在最底，中间空出一大段。
原因是当时的写法：`.list` 没有任何 `flex`，而 `.status` 靠 `margin-top: auto`
**自己一个人**被推到底。于是列表越短、中间空得越多；列表一长，两者又会被分开。

修法是把三样归入一个 `flex: none` 的页脚，让列表去吃掉剩余空间：

```css
.list { flex: 1 1 auto; min-height: 0; overflow-y: auto; }
.foot { flex: none; display: flex; flex-direction: column; gap: 8px; }
```

两个关键点：

- **`min-height: 0` 不能省**。flex 子项默认 `min-height: auto`，内容很高时会
  拒绝收缩，结果是整个侧栏溢出、页脚被顶出视野（而不是列表内部滚动）。
- **删掉 `.status` 的 `margin-top: auto`**。页脚贴底现在由「列表撑满 +
  页脚 `flex:none`」共同完成，不再需要单个元素自己推自己。
  但保留 `min-height: 1.5em`：状态文字时有时无，留一行高度免得页脚跳。

为什么这三样归为一处：都是「对当前选择做什么」的反馈与控制；
而列表长度是变的，让它们跟着列表走就会时而留空、时而看不见。

实测（无头 Edge，面板 190px 宽 × 360px 高）：

| 场景 | 页脚底距面板底 | 列表→页脚 | 选中→状态 | 溢出 |
| --- | --- | --- | --- | --- |
| 3 条 + 选中 | 12 | 10 | 8 | 0 |
| 30 条 + 选中 | **12** | **10** | **8** | 0 |
| 30 条 + 多选 | 12 | 10 | — | 0 |

页脚底距正好等于面板内边距（12），且**短列表与长列表的数字完全一致**
——这才是“固定”的定义。

### 选中信息只在一处（合并选中操作区与状态行）

后来的截图又暴露一个重复：选中一条后，选中操作区已经显示文件名，
状态行又报一遍「已选择「xxx」」——同一信息说了两次。而且状态行空着时
仍占一行高度，页脚看着像“卡片 + 一条独立文字”两个东西。

改了两处：

**一、选中时不再往状态行写消息**。`select()` 改调 `clearStatus()`。
状态行从此只承载「操作结果」（如「引用指令已复制」）与「错误」，
选中状态由选中操作区独家负责。顺带也清掉上一条操作结果，不残留。

**二、空状态行不占位**：

```css
.status:empty { display: none; }
```

无消息时页脚就只剩那一个卡片（真的“一个组件”）；有消息时它才出现。
代价是页脚会略涨一点，但因为消息总是用户主动触发、且是临时的，可以接受。

实测（无头 Edge，面板 190×360）：

| 时机 | 状态行 | 页脚里可见的元素 | 页脚高 |
| --- | --- | --- | --- |
| 未选中 | 空、不占位 | （无） | 0 |
| 已选中 | 空、不占位 | **selectedActions** | 101 |
| 点了复制 | 「引用指令已复制…」 | selectedActions, status | 144 |
| 换选中另一条 | 空（上一条已清） | **selectedActions** | 101 |

关键在第二、四行：选中时页脚里**只有选中操作区一个元素**。

### 删除成功后不报「已删除」

批量删除里的成功提示也去掉了。理由与选中提示同构：

- 行已经从列表里消失，**删除本身就是反馈**，再报一遍是重复；
- 更要紧的是它会**覆盖或留下**上一条操作结果（比如“引用指令已复制”），
  而那条消息可能指向刚被删掉的记录。

改成成功后 `clearStatus()`，只保留失败上报。

**失败分支必须保留**：不报的话用户会以为都删干净了。所以是
“去掉成功提示”而不是“去掉全部提示”。详见下表。

实测（无头 Edge，驱动真实的垃圾桶→确认浮层流程）：

| 时机 | 状态行 | 列表行数 |
| --- | --- | --- |
| 先选中并复制（有旧消息） | 「引用指令已复制…」 | 2 |
| 删一条服务端拒绝的 | 「已删除 0 项，1 项失败：拒绝删除.pdf：任务正在运行，无法删除」 | 2（未被删） |
| 删一条可删的 | **（空，不占位）** | 1 |

最后一行是关键：成功删除后状态行**连上一条“已复制”也一并清掉了**。

### 行右键菜单（重命名 / 刷新 / 删除）

三条单条操作聚到一个右键菜单里。行内图标照旧保留（负责“看得见”），
右键负责“一处分全”，而且**重命名只有这里有**。

不管批量模式还是普通模式都给菜单：右键是明确手势，三个动作也都是单条操作。

#### 用官方 `ContextMenu`，先实测了两件关键事

侧栏只有约 190px 宽，而以前 `ListRow` 的溢出菜单就是在这里被裁掉的，
所以先把控件的两个行为量清楚：

**一、它不受容器溢出裁剪。** 渲染出来的结构是 `挂载点 > DIV.pa(position:fixed) > 菜单`：

| 量项 | 值 |
| --- | --- |
| 挂载点 `offsetHeight` | **0**（不占布局） |
| 菜单外层 `position` | `fixed` |
| 开菜单前后页脚位置 | `[12,318,166,0]` → 一模一样（零位移） |

**二、它自带边界调整。** 把靠边的坐标自动贴到视口内：

| 请求 | 实际渲染 |
| --- | --- |
| (178,330) | (96,216) |
| (185,335) | (103,221) |

两个都是“菜单右下角贴到光标”的翻转行为。所以在侧栏 iframe 里\ 
不需要自己夹取坐标——直接把光标位置传进去就行。

#### 一个必须注意的实现细节

**挂载点必须在 `data-hana-app-ui` 作用域内**，否则 `APP_UI_SCOPE_REQUIRED`。
所以放在 `#sidebar` 直系（不在 `.list` 里，也避开后者的滚动容器）。

**每次开菜单必须重建控件**，不能走 `renderCtrl`：同类型控件会走 `handle.update`，
而 `update` 不会重新定位——菜单会停在第一次的位置。这也是要新节点、
并在关时 `destroy()` 的原因。

### 重命名

后端新开 `POST /jobs/:jobId/rename`。安全依据：

**`fileName` 在这个应用里是纯展示字段。** 磁盘上的结果靠
`batchId` / `markdownPath` / `jsonPaths` 定位，与文件名无关；它只流向列表显示、
删除预览、`reference_result` / `translate_result` 的工具文案，以及导出时的
建议文件名。所以改名不会弄丢任何东西——它反而会让导出的文件名跟着变，这是想要的。

即便如此仍然严格校验，因为它会进入导出文件名与 HTTP 头：

| 输入 | 结果 |
| --- | --- |
| `../evil/name.pdf` | → `.._evil_name.pdf`（分隔符换成下划线） |
| `a\b.pdf` | → `a_b.pdf` |
| `a\u0000b.pdf` | → `ab.pdf`（控制字符剔除） |
| 空 / 全空白 / 全是控制字符 | 400 拒 |
| 201 字 | 400 拒（上限 200） |
| 目录里只留 `metadata.json` | 无临时文件残留（走 `updateJob` 的原子写） |

提示界面复用已有的页内确认浮层（`window.prompt` 在 iframe 里不可用），
多挂一个官方 `TextInput`。改名成功后同时 `loadJobs()`（新名字）与 `bumpRevision()`
（主卡标题也跟着变）。

实测（无头 Edge 驱动真实右键 → 点菜单项）：

| 步骤 | 结果 |
| --- | --- |
| 右键行 | 菜单三项 `[重命名, 刷新状态, 删除记录]`，页脚零位移 |
| 点重命名 | 输入框预填 `原始名字.pdf`，输入回读一致，保存后行名变 `改过的名字.pdf`，后端收到 |
| 点刷新状态 | 后端收到，状态行拿到进度 |
| 点删除记录 | 二次确认 `[取消, 删除]`，行数 2 → 1 |

### 提示改走宿主吐司

页脚里的状态行整个拆了，所有提示改成宿主吐司（3 秒后自消）。

改的理由不只是“好看”：状态行是页脚的一部分，**它一出现页脚就长高、一空就缩回去**，
布局跟着跳；吐司浮在上层、不参与布局。

#### 能力前提（实测宿主能力表）

```js
{ name: 'toast.show', allowedSlots: ['page','widget','card','settings','function-panel'], requiresGrant: false }
```

`function-panel`（侧栏）在允许列表里，且 **不需要授权**，
所以本次改动**没动 manifest 的能力声明**。

载荷是 `{ message, type?, duration? }`：

- `type` 限定 `success` / `error` / `info` / `warning`；
- 宿主**默认时长是 5000ms**，所以 3s 必须显式传 `duration: 3000`（常量 `TOAST_MS`）。

#### 映射规则

原来的 `showStatus(msg, bad)` 变成 `notify(msg, type)`：

| 原调用 | 新类型 |
| --- | --- |
| 刷新成功 / 指令已复制 / 已重命名 | `success` |
| 刷新失败 / 复制失败 / 打不开菜单 / 名称为空 / 重命名失败 / 删除部分失败 / 列表拉取失败 | `error` |

共 10 处调用。两个“不提示”的位置仍不提示：

- **选中一行**：选中项操作区已经显示文件名了；
- **删除全部成功**：行已从列表里消失。

#### 实测

吐司由宿主渲染在 iframe **之外**，所以本地测试台只能验调用与载荷（视觉归宿主）：

| 操作 | 产生的吐司 |
| --- | --- |
| 选中一行 | **0 条** |
| 复制引用指令 | `{type:'success', duration:3000}` |
| 删除一条服务端拒绝的 | `{type:'error', duration:3000}` |
| 删除一条成功的 | **0 条** |
| 重命名成功 | `{type:'success', duration:3000}` |

页脚高度：未选中时 **0**，选中后 **101**（只剩选中项操作区，不再有状态行）。

#### 主卡片暂未动

主卡右栏底部也有一个同类型的状态行，但它的消息**语义不同**：
里面有正在进行中的状态（“正在提交到 MinerU…”、“正在打包图片…”），
那不是“一闪而过的结果”，用 3 秒自动消失的吐司反而会丢掉信息。
所以这次只改了侧栏，主卡等用户拍板。

### 本地测试台挖到的两个坑

这两个都是静态检查和单元测试看不出来、只有真跑界面才暴露的：

1. **向游离节点挂官方控件会被拒**。`mountAppUi` 要用 `closest()` 检查宿元素是否在
   `data-hana-app-ui` 作用域内；在还没插入文档的行里挂 Checkbox 会直接抛
   `APP_UI_SCOPE_REQUIRED`，结果是**整张列表变空**。修法：先 `appendChild(row)`，
   再由 `attachPick(row, job)` 挂控件。
2. **受控勾选框需要回写 props**。官方 Checkbox 是受控组件：只改自己的状态、
   不调 `handle.update()`，React 会把 DOM 的勾选态复位——表现出来就是
   “行高亮了、勾选框却是空的”。修法：按 jobId 记住 handle，切换时回写。

另外一个实现细节：勾选**不整表重渲染**（只更新该行与底部操作条）。
重建所有行会让控件被替换，连续勾选时第二次点击会打在旧节点上
（实测：连点两个只中一个）。

---

## 二·七、设置页（标题与 Token 可见性）

### 标题

`contributes.settings.title` 从「MinerU 文档解析**设置**」改成「MinerU 文档解析」。
设置 Tab 本身已经在应用名下，再缀“设置”是冗余。

### Token：暂不明文打码（机制已查清，存愿）

需求是“Token 默认以 `***` 显示，点按钮才看明文”。结论：**先不打码**，
但机制已经摸清并实测过，将来想开随时能开。

#### 先把一个旧误判修正

当初把 `sensitive` 设为 `false` 的理由是“宿主对 sensitive:true 的字段一律脱敏，
无法查看”——**后半句是错的**。把宿主源码读完后的真实分层：

| 层 | 函数 | 行为 |
| --- | --- | --- |
| 设置页展示 | `cL` / `Cyt` | `sensitive && 非空` → 掩成 `********` |
| 应用读取 `ctx.config.get` | 直接读仓库 | **原值返回，不脱敏** |
| 设置页写入 | `Pyt` | 值仍为 `********` 时**从写入中剔除**，不用星号覆盖真值 |

仓库层自己的注释写得很直白（原文）：

> 值原样返回，不掩码：掩码是投影层的事（见 server/routes/settings-contributions.ts），
> 这里是仓库本身，仓库要说真话。

> 这是 App 自己读取配置时所需的原始投影，不在这里应用 schema 默认值或敏感字段掩码。

所以 `sensitive: true` 其实**不影响解析功能**，只影响设置页能不能看见。
（曾担心“翻转会把已存 Token 用星号覆盖”——实测过：安装前后 SHA-256 前 12 位一致。）

#### 那为什么还是不打码

因为脱敏不是无代价的：宿主通用表单**不提供“点击显示”按钮**。

- schema 只支持 `sensitive` 这个布尔位，没有自定义控件入口；
- 渲染出来就是裸的 `type="password"`；
- Edge 对这类输入框也**不自带**显示按钮（无头 Edge 实测：只有圆点，没有眼睛图标）。

于是选了打码之后，想核对 Token 就得从 MinerU 官网重贴一次。
而核对 Token 是个会反复发生的动作（换了套餐、怀疑额度不对、排查 401），
把它变成“看不到”的代价大于“页面上多显示一段密钥”的代价——
那页本来就只有用户自己能看。

真要做“点击才显示”，路只有一条：用 `contributes.settings.ui: { route }`
拿自己的页面替掉通用表单（需 Hana ≥ 0.939.0）。注意声明 `ui` 时仍需保留 `schema`，
因为校验、默认值与敏感值处理都在 schema 那边。代价是自己维护整张设置页（6 个字段
+ 读写路由 + 校验反馈），而通用表单的样式与校验是白送的。

---

## 三、你已拍板的三个决定

1. **卡片界面用官方控件重写** —— 已按此完成，见上节。
2. **翻译模型的记忆位置不改动** —— 维持 `sdk.storage.global`。
   代价是卸载重装会丢这个选择；换来的是不新增设置项、不依赖 agent。
3. **`minAppVersion` 暂定 `0.1050.9`** —— 即随包 SDK 的版本，只有较新的宿主能装。

---

## 四、在真实宿主里装载后发现的七个问题

前五节都是静态检查能证明的东西。真正装进宿主之后，又碰到三个只有跑起来才会暴露的问题。

### 1. 工具目录是「对话开始时」的快照

**现象**：应用装好了，日志显示 apply 跑完、工具注册成功，但调用报
`Plugin "mineru-document-workbench" not found`。

**根因**：宿主在**对话开始那一刻**为这个对话定稿一份工具清单；同一对话内
新注册、改名或卸载的工具都不会反映进去。本对话开始于 11:36，当时在场的
是 **v1 插件**；12:44 把 v1 卸载后，清单里那 6 个名字仍然存在，于是调用时
按名字回查插件——而那个插件已经不存在了，所以是 `Plugin not found`，
与实际注册的 app 无关。

**验证**：`dshana`（11:20 装）与 `guanlan`（11:06 装）在本对话开始时就在场，
它们的工具一直正常。新建一个子实例（等于新对话）后，工具清单里包含全部 6 个
工具，调用返回正常，不再报错。

**结论**：**装完应用后需要新开一个对话**，它的工具才会出现并可用。
工具名带 `{appId}_` 前缀完全没问题——不需要为它改名。

### 2. v1 的字符串返回值在 v2 会被当成空结果

**现象**：工具调用“成功”，但没有任何输出（`(no tool output)`）。

**根因**：v1 的 `execute` 有两种返回形态——纯字符串（`list_jobs` 的
`JSON.stringify(summary)`、`submit_document` 的模板串）和 `{ content, details }`。
**v2 只认 `{ content: [{ type: "text", text }] }`**，字符串被当成空结果，
既不报错也不出声。

**修复**：`index.js` 里的 `normalizeToolResult()` 在适配层统一归一化
（字符串→文本块，已是 v2 形态的原样返回，其余序列化），
`lib/tools/` 里的业务代码仍然一行没改。

### 3. 改完入口代码后，「重新加载」不足以验证

因为问题 1，「当前对话看不到新工具」这个现象无法用来判断 reload 是否生效。
实测有效的办法是 **remove + 重新 install**（同一个宿主进程内完成，不需要重启）：
每次重装都是新的子进程装载，会读最新的 on-disk 代码。
本次迁移的整个调试过程都走的这条路。

**注意**：`reload` 读的是**安装目录**（`{HANA_HOME}/apps/<id>/`）。
如果你在仓库里改代码，要先同步到安装目录、或重走 install，改仓库里的文件不会被 reload 看到。

### 4. 宿主主题变量不会跟进卡片 iframe，浮层变透明

**现象**：右栏「解析方式」「翻译模型」的下拉展开后**没有背景**，选项直接叠在页面正文上看不清。

**根因**（两层叠在一起）：

1. 官方控件包里的样式大量引用一套宿主主题变量，如
   `.x { background: var(--bg-card) }`、`.r.r { background: var(--bg-card) }`
   ——**没有写兜底值**。变量缺失时 `background` 在计算值时失效，回退到初始值
   也就是透明。
2. 那套变量由主窗口的主题样式表定义，但它们全部写在
   **`[data-theme="xxx"]` 选择器**下（见 `themes/warm-paper.css` 等）。
   卡片是独立 iframe 文档，主窗口的变量不会跟进去；而浏览器 SDK
   虽然会把主题标识告诉页面（`hana.theme.getSnapshot().theme`，
   来自 iframe 的 `hana-theme` / `hana-css` 参数），
   **却从不把它写成 `data-theme` 属性**，也只在收到主题变更事件时才注入主题样式，
   初次加载不做。于是选择器匹配不到任何元素，变量集体落空。

自己的 CSS 之所以没露馅，是因为 v1 那份样式一直写着 `var(--bg-card, #fff)` 这类兜底值。

**修复**（两半，互补）：

- `panel.css` 里用 Hana 默认主题 warm-paper 的真实取值补上这套变量（`--bg-card`、
  `--accent`、`--border`、`--text` …），作为交底。若宿主后续确实注入/推送了主题，
  那份样式在 head 里排在本文件之后，同优先级下后者生效，卡片仍会跟随宿主主题。
- `panel.js` 里 `followHostTheme()`：从快照读主题标识写进 `data-theme`，
  并用 `fetch` 把 `cssUrl` 自己注入一次（用与 SDK 同一个 `data-hana-theme-style`
  属性，不重复注入），再订阅后续变化。

**验证**：本地测试台（桩 SDK，不定义任何主题变量）里展开下拉，
浮层背景 = `rgb(252,250,245)`，描边 `1px rgba(122,96,88,.18)`，与 warm-paper 一致。

### 5. 右栏「目标语言」压根没渲染

**现象**：右栏只剩一个「目标语言」标题，下面空着，没地方选语言。

**根因**：两个问题叠在一起。

1. 我在翻译那段里写了一个 `renderTranslationBar()`，它渲染的是中栏译文工具条的
   `langSlot`；而**右栏那个 `translateLangSlot` 从来没人往里渲染过**，
   而 `panel.css` 里 `.slot:empty { display: none }` 让这个空挂载位直接隐形。
2. 更深一层：「目标语言」（下次翻成什么，应当始终可见）与
   「查看哪份译文」（中栏，只在有译文时出现）是**两件事**。
   v1 本来就是两个控件，我在重写时把它们合并成了一个变量。

**修复**：拆回两个职责。`renderTargetLanguageSelect()` 渲染右栏，绑 `targetLanguage`，
在 `renderActionState()` 里跟随其他右栏控件一起更新（所以始终可见）；
中栏工具条的选择器改绑 `viewTranslationLang`，只负责切换当前查看的译文。

**验证**：本地测试台里 `目标语言` 渲染出 combobox，并正确选中了后端下发的
`defaultTargetLanguage`（桩数据故意给「英语」，界面确实显示「英语」）。

### 6. 解析时报 `--allow-fs-read`：外部文件读不了

**现象**：选好文件点「开始解析」，报
`Access to this API has been restricted. Use --allow-fs-read to manage permissions.`
任务列表里也不出现新记录（app-data 下连 jobs 目录都没建）。

**根因**：v2 的 `ctx.resources.materialize` 返回的是**用户的原始文件路径**，
而 app 子进程开着 Node Permission Model，读取许可根只有 `dataDir`（与安装目录）。
业务代码（`parse-channels.v1.js` / `mineru-client.js`）直接
`fs.readFile(filePath)`，被运行时直接拒绕。

v1 插件没有这层隔离，所以那份“直接读路径”的代码在 v1 一直是对的。
这也是隔离本身要防的事：APPS.md 明说“裸 `fs` 读取许可根以外会被运行时拒绕”。

实测的宿主行为（用临时诊断工具跑的）：

| 探测 | 结果 |
| --- | --- |
| `materialize` 返回 | `{ resourceKey, resource, filePath, version }`，`filePath` 是原文件路径 |
| 裸 `fs.stat(该路径)` | ❌ `Access to this API has been restricted…` |
| `ctx.resources.copy` 到 dataDir | ✅ 成功（`changeType: "created"`） |
| 复制后 `fs.stat` 那份副本 | ✅ `size: 74` |

（错误发生在「创建任务目录」之前，因为业务代码先提交上传、再建目录记录。）

**修复**：适配层的 `resources.materialize` 在拿到路径后，判断它是否在 `dataDir`
内；不在就用 `sdk.resources.copy` 复制到 `dataDir/uploads/<短哈希>-<文件名>`，
把这份**可读的副本路径**交给业务代码。`lib/` 里仍然一行不改。

暂存文件名带源路径短哈希，同一文件重复提交会复用同一个文件、不会堆积；
每次 materialize 顺手清掉超过 30 分钟的旧暂存（best-effort）。
复制失败时抛一个清楚的错误，**不退回原路径**——退回只会又暴露那个难懂的权限错误。

**验证**：

1. `tests/v2-ctx-materialize.test.mjs` 四条回归（外部文件被暂存且内容一致、
   已在 dataDir 的不重复复制、同一文件复用、复制失败报清楚错误）。
2. 本地独立复现宿主机理：`node --permission --allow-fs-read=<dataDir>`
   下 dataDir 内可读、外部路径报**完全同一条** `ERR_ACCESS_DENIED`。
3. 真实宿主下跑完整解析（无参自检工具，内部调用真实 `submit_document`）：

   ```
   MinerU task submitted: sample.png; mode=Agent;
   taskId=68ab49ae-fe4d-4376-82b1-1111ec31fa5e16（该模式仅返回 Markdown）
   ```

   文件读取通过、上传成功、拿到真实 taskId；
   `app-data/jobs/<jobId>/metadata.json` 也正确落盘，`batchId` 与之一致。

### 7. App 存储的 get 返回的是**包装对象**，不是裸值

**现象**：侧栏点一条记录，侧栏高亮正常（写入成功），但主卡毫无反应；
右下状态栏提示“已选择「…」”——看起来像「通知没送到」。

**排查过程（踩了两次坑）**：

| 猜测 | 结论 |
| --- | --- |
| 存储槽位不允许 `card` | ❌ 排除。白名单是 `card / function-panel / settings` |
| 变更事件不推送给卡片 iframe | ❌ 排除。诊断显示 `gotKeys` 里确实收到了 `ui.selectedJobId` |
| 官方 SDK 的事件过滤有 bug | ❌ 排除。`appStorageScopesMatch` 逻辑干净 |

把主卡的诊断写进 storage 后（因为页面不活跃时 `not_mounted`、读不到 DOM），
三个观测同时成立：

```
getErr: null      ← get 没报错
gotKeys: [... 'ui.selectedJobId' ...]   ← 事件到了
sel: null         ← 但值没被采纳
```

“没报错 + 事件到了 + 值没采纳”只有一个解释：**`get()` 返回的不是裸值**。
后来的诊断字段 `rawType: "object"` / `rawJson: {"key":"ui.selectedJobId","value":null}`
坐实了这一点——它与宿主 v1 存储版的 `{ key, value }` 同形。

所以这行永远为假：

```js
const next = await hana.storage.global.get(KEY);
if (typeof next === 'string') selectedJobId = next;   // 包装对象 → 判假
```

**修复**：`readStored()` + `unwrapStored()`（两个页面共用同一逻辑）：
裸值、`{ value }`、双层包装都认；两个页面**所有** storage 读取都改走它，
并加测试防止以后新增调用点又忘了拆。

**教训**：`get()` 不报错不等于拿到了值。当“写入成功、通知到达、消费方无反应”
三者同时成立时，优先怀疑**取值形状**，而不是传输通道。

顺带两个实现问题：

- **自反馈循环**：诊断回写自己会触发变更事件、事件又叫我回写。
  `gotKeys` 里那串 `__diagMain, ui.selectedJobId, __diagMain, …` 交替出现就是证据。
  修法是内容没变就不写（比逐个判断哪些键该忽略可靠）。
- **`slice` 截断导致假阴性**：`ownPingSeen: false` 是错的——
  `__diagPing` 早被 `slice(-8)` 截掉了。读诊断时要注意窗口大小。

---

## 五、`hana.emit` 能不能从整页卡送达会话（实测结论：不能）

起因是「把解析结果引用到对话」这个需求。v1 的做法是把一段绕路指令写进剪贴板，
让用户自己粘到聊天里；v2 有 `hana.emit`（卡片把一次用户操作送回会话并唤醒 agent），
看起来正好取代那条绕路。读过官方文档后本以为可行，实际实测把它否掉了。

### 实测过程

在真宿主里给主卡加了一段临时探针，测三个变体。结果（从 app-data 读回）：

| 探针 | 结果 |
| --- | --- |
| `surface.getContext()` | `slot: "card"`、`embeddedSessionId: null`、`originSessionId: null` |
| 不带 `to` 的 emit | `PLUGIN_EMIT_NO_ROUTE` |
| 带 `to`（候选 sessionId） | `PLUGIN_EMIT_INPUT_INVALID` |
| `sessions.getActive()` | `APP_SESSION_PERMISSION_DENIED`（要 `app/sessions.read`） |

### 两道独立的墙

**第一道：卡片实例 id 的形状。** 服务端 handler 开头就有：

```js
function VO(t) { return typeof t == "string" && /^[am]_[0-9a-f]{20}$/.test(t); }
// …
if (!VO(s) || !s.startsWith("a_")) {
  return Jg("events/emit cardInstanceId must be a host-minted app card id.");
}
```

而 `a_*` 只从两处铸出来：

```js
function _Ae(t) {
  if (toolCallId) return Hfe("a", ["app", toolCallId, pluginId, route]);
  return Hfe("a", ["app-custom", customType, messageId, pluginId, route]);
}
```

也就是：`a_*` 只属于「模型工具调用的结果卡」或「自定义消息卡」。
而清单里 `realization: "page"` 的整页卡拿到的是布局实例 id
（`wb-card-plugin-webview-card-*`）——这个 App 永远没有 `a_*`。

**第二道：不知道要投给哪个会话。** 整页卡的 `embeddedSessionId` 与
`originSessionId` 都是 `null`（它不嵌在任何会话里），而不带 `to` 时宿主
要求「活动表面 kind === chat」——整页卡被查看时活动表面就是它自己
（`kind: "plugin"`），所以这一条**结构性**不成立。唯一出路是显式传 `to`，
但拿 sessionId 要 `app/sessions.read`（设置里叫 “Read other sessions”）。

两道墙相互独立：就算补上 `app/sessions.read` 拿到 sessionId，第一道墙依然在。

### 为什么它“理论上”该对

文档写的是「流内**或钉出的** v2 应用卡可以把一次用户操作送回会话」，
服务端 handler 也只查一个能力（`app/session.start-turn`，实测确认没有
sessions.read/manage 要求）。所以设计意图是真的，但实现上只接受
从工具调用/自定义消息铸出的流内卡 id。整页卡不在这个集合里。

### 遗留的权限记录

探针期间往清单加过 `app/session.start-turn`，为实测授权了一次。
能力已从清单移除（该词在 emit 路径下对整页卡永远用不上），但权限台账里
会留下 3 条 `allowed / always` 的旧记录。它们现在**惰性**（清单不再声明），
但若将来重新声明该能力，这几条会直接生效。要彻底弄干净得在
设置 → 应用能力 里手动撤销。

---

## 六、槽位边界把「复制」与「另存」分到了两个页面（已落地）

第五节排除了 emit，剩下的问题是怎么安置原来那两个复制按钮。
宿主的能力表给出了一个不需要选、只能接受的答案：

| 操作 | 白名单（取自渲染器 `allowedSlots`） | 结果 |
| --- | --- | --- |
| `clipboard.writeText` | `page` / `widget` / `settings` / `function-panel` | **不含 card** |
| `resource.saveFile` | `card` / `preview` | 正好含 card |

应用卡是 **card** 槽位，侧栏是 **function-panel**，两张表交集为空。
所以：

- **侧栏**（function-panel）→ 生成「引用 / 译文获取」指令写进剪贴板
- **主卡**（card）→ 「另存为 .md」走 `resource.saveFile`

### 三条路各自的位置

**① 侧栏剪贴板**（`copyRefInstruction` / `copyTranslateInstruction`）

侧栏本来就持有选中项，生成指令的原料在它手上；而且零新增权限
（`app/ui.clipboard-write` 早已声明）。选中项操作区在**多选模式下隐藏**：
那时人在挑“一批”，不是“一条”。

**② 主卡另存**（`saveCurrentView`）

主卡上**只留一个**另存按钮，位置在标题行右侧（`viewer-head` 里的 `#saveSlot`）。
左侧竖栏与译文工具条里的重复按钮都已删掉。因为只有一个入口，它必须
按当前页签分派：

| 当前页签 | 存什么 |
| --- | --- |
| 译文（且有译文） | 当前那份译文 |
| Markdown / JSON | 结果 Markdown |

JSON 页签也存结果 Markdown：同一个任务的 JSON 视图只是另一面，
存成 .md 仍然是份真的 Markdown，不会得到“后缀写 md 但内容是 JSON”的假文件。

两个细节值得记：

- 存的是 `preview.markdown`（原始 Markdown），**不是** `markdownHtml`。
  后者是预览用的 HTML，存成 .md 会得到一个带标签的假文件。
- `contentBase64` 要求 base64，而 `btoa` 遇非 ASCII 会抛错，所以先经
  `TextEncoder` 转 UTF-8 字节再编码，并分块拼接避开
  `String.fromCharCode(...bigArray)` 的参数上限（中文文档很容易超）。
  文件名也要净化：宿主会拒含路径分隔符的 `suggestedName`。

标题行是 flex：标题区 `flex:1 1 auto; min-width:0`（否则默认 `min-width:auto`
会拒绍收缩），按钮 `flex:none`。实测 240～520px 五档宽度下按钮恒定 88px、
零裁切、长文件名不会把它挤出去。

**③ 工具路径（“不做按钮”的那条）**

`reference_result` / `translate_result` 本来就把结果登记成会话文件
（`app/session.stage-file`），所以「进对话」这件事其实已经通了。
主卡上留一句提示：“要把结果带进对话，直接说一句「引用这条解析结果」就行，
不用复制粘贴。”——按钮省下的只是一句话。

### 顺带修的联动

侧栏生成译文指令需要知道**目标语言**，而语言选择器在主卡上、
两个 iframe 不共享 JS。所以主卡把 `targetLanguage` 广播到
`ui.targetLanguage`，侧栏读取（兵底「中文」）。
测试里专门钉了“两侧的键名必须逐字一致”——键名写错会静默不连通。

---

## 七、导出：图片怎么办（两种格式 + 外链图下载）

### 问题

结果 Markdown 里的图片是**相对路径**：

```markdown
![](images/eb1286cf…854.jpg)
```

它只在 `recovered/<taskId>/` 那个目录里才有意义。单独把 .md 存到别处，
图片就全裂了。预览能显示是因为走了另一条路（后端改写成 `jobs/:id/asset/…`、
前端带凭据 fetch 成 blob），那条路出了应用就断。

还有一种隐蔽情形：MinerU 有时返回**临时签名 URL** 的外链图，
那种链接过几天会过期，导出包会随时间自己烂掉。

### 两种格式，各自解决不同场合

标题栏的下拉让用户自己选：

| | `打包 zip` | `单个 md` |
| --- | --- | --- |
| 形态 | md + `images/` 目录 | 图片内联成 data: URI |
| md 可读性 | 保持原样 | 图片一多就不适合当文本读 |
| 体积 | 不变 | 约 +33%（图片部分） |
| 适合 | 一份完整可打开的文档 | 拖到哪儿都能看的单文件 |

**zip 的关键好处：md 一个字都不用改。** `images/xxx.jpg` 本来就是相对路径，
只要保持「md 在根、images 在子目录」，相对关系自动成立。这是 Markdown 生态的
标准做法，Typora / Obsidian / VSCode / GitHub 全认。

### 外链图会在导出时下载下来一并打包

host 在允许列表内的外链图会**下载后落到 `images/`**，并把 md 里的引用改写成
包内路径——否则包里的链接依旧指向随时会过期的远端。下载不成功的保持原链接
并在状态栏报一句，而不是静默丢掉。

host 不在允许列表的不尝试下载：不是不想下，是宿主网络层不放行
（见清单的 `network.allowedHosts`）。

### 自己写了个 ZIP 打包器（`lib/zip-write.v1.js`）

导出要产出「md + images/」这种目录结构，而唯一的交付通道是
`resource.saveFile`——它只收一个 base64 文件。宿主没提供「打包」能力，
应用也不能起子进程，所以自己实现了最小的一版（约 170 行）：

- 只支持 store 与 deflate 两种方法，**两种都算一遍取小的**，
  比按扩展名硬编码更稳（图片再 deflate 通常更大，文本能显著变小）。
- UTF-8 标志位必须设（第 11 位），否则中文文件名在别的解压器里乱码。
- 条目名当外部输入处理：拒绝对路径、`..`、控制字符。
  本写入器的条目名都是自己生成的，出现绝对路径就说明调用方有 bug——
  宁可拒绝并报出来，也不要默默改写成相对路径。

### 顺手修了一个越权漏洞（升级 `result-assets` 到 v2）

写导出时把主机允许判定抽成共用函数，结果发现**预览侧的老实现写错了**：

```js
// v1（两份实现都是这样写的）
host === suffix || host.endsWith(suffix)
```

只判 `endsWith` 会让 `notmineru.net`、`evil-aliyuncs.com` 这类**构造域名**通过
校验——它们确实以允许的后缀结尾，但不是那些域名的子域。于是未经允许的主机
上的图片也能被渲染（抳像素、泄露 IP）。

修法是加上点前缀：`h === s || h.endsWith('.' + s)`。现在预览渲染与导出下载
共用同一份实现（`result-assets.v2.js` 的 `hostMatchesSuffix`），不再会分叉。
按仓库约定，共享模块改了要换文件名，所以 v1 → v2 并更新了三个导入方。

### 真实数据实测

拿磁盘上那份 6 图的结果跑过：

| 项 | 结果 |
| --- | --- |
| zip 大小 | 18,758 B（md 走 deflate，图片 store） |
| 条目 | 7（md + 6 图，路径与原目录一致） |
| CRC32 | 7/7 通过，解出长度与头部声明一致 |
| 解压后图片 | **6/6 与磁盘原图逐字节一致** |
| 包内 md | 与源文件**逐字节相同** |
| inline | 6 个 data URI，无残留相对引用 |

---

## 八、上传区：点 / 拖 / 贴（已落地）

原来只有一个「选择文件」按钮。现在是一块拖放区，三种入口殊途同归：

| 入口 | 走什么 |
| --- | --- |
| 点击区域 | `hana.resources.pick`（宿主选择器，拿真实路径） |
| 拖入 | `dataTransfer.files` → 字节传给后端 `/intake` |
| 粘贴 | `clipboardData.files` / `items` → 同上 |

### 为什么拖放和粘贴必须把字节传回后端

浏览器沙箱**不把本地路径给页面**。而解析链路的入口是
`ctx.resources.materialize(ref)`，它要的就是路径。

所以后端新开了一个 `POST /intake`：页面把原始字节 POST 过来，后端落到
`dataDir/intake/`，回一个 `{kind:'local-file', path}`。这个路径在 dataDir 内，
`materialize` 会直接采用（不再复制），子进程也读得到。

两个细节：

- **发原始字节，不发 base64**。`hana.api.fetch` 把 `init` 原样透给 `fetch`，
  所以 `body: file` 直接可行；用 base64 会让 100MB 变成 133MB。
- **按内容哈希命名**。同一份文件重复拖进来会落到同一个路径，不会堆副本。

### 应用内拖拽的退化路径

从 Hana 自己的文件区拖出来时 `dataTransfer.files` 是**空的**——拖拽源只能放
字符串。但宿主的拖拽协议会在 `text/plain` 里写上真实路径，所以这时
直接拿那个路径当 `{kind:'local-file'}` 引用，能不能读交给宿主授权。

### 顺手做对的两件事

- **`preventDefault`**：`dragenter` / `dragover` / `drop` 都走同一个 helper。
  漏了 `dragover` 的阻止，`drop` 根本不会触发；三个都不阻止，
  浏览器会直接导航到被拖进来的文件、页面就没了。
- **粘贴要避开输入框**：在 `INPUT` / `TEXTAREA` 里粘一份文件不该变成“选文件”。

### 顺带修的：类型白名单两处会漂移

提交侧（`routes/jobs.js`）原本自己写了一份扩展名列表。现在上传侧也要同一份——
分头写迟早漂移，现象是「能选中但提交时说类型不支持」。所以抽出了
`lib/file-types.v1.js`，两边共用。测试里钉住了这一点。

写入时还发现一个小 bug：`isSupportedFile` 不 trim，文件名带尾随空格会被误判。
已修（任何调用方都受益，不只是上传）。

---

## 八·五、页面图标的悬停变色（实测结论：App 侧做不到，已放弃自定义图标）

左侧栏导航入口的图标（`contributes.cards[].pageIcon`）试过三轮，最终**移除**，
改用宿主内置图标。原因是一个改不动的前提：**宿主的悬停变色靠 `currentColor`，
而 App 的页面图标只能是 `<img>`**。

### 宿主的机制

悬停规则是 `.sidebar-activity-bar:hover { color: var(--accent) }`，图标与标签
都从这条 `color` 取色。兄弟图标是**内联 SVG**，所以 `currentColor` 生效，
默认态再被 `.sidebar-activity-bar svg { opacity: .45 }` 淡化。实测印证了这个模型：

| 主题 | 行背景 | 标签文字（`currentColor`） | 兄弟图标实测 | 45% 混合推算 |
| --- | --- | --- | --- | --- |
| 暖米色 | `#EFE8DB` | `#6B6158` | `#B3ABA0` | `#B3ABA0` |
| 中性浅色 | `#EFEFF2` | `#95959C` | `#C7C7CB` | —— |
| 深色 | `#202C34` | `#B7C8D3` | `#64727C` | `#64727C` |

### 三道墙（都验过）

1. **`<img>` 里的 SVG 无法继承父页面 `currentColor`。**
   CSS 规范：通过 `<img>` 引用的 SVG 是独立文档，处于安全静态模式，
   父文档的 `color` 传不进去。所以不管宿主文字怎么变色，图标都是固定的一个灰。

2. **插槽系统进不了侧栏。** `contributes.ui.slotContributions` 确实能让 App
   往槽里塞按钮或 iframe，但文档明确：`slot` 不能以 `hana/` 开头——那是宿主
   自己的槽，只走 `messageActions` / `cardChrome` / `contextMenus`。
   侧栏导航正是宿主的槽，禁止投递。

3. **宿主的内联 SVG 通路对 App 不可达。** 渲染器里确实有一条能继承 `currentColor`
   的路（`dangerouslySetInnerHTML`，输入是卡片级 `icon`），但服务端投影把
   app 卡片的 `icon` **硬编码为 `null`**：

   ```js
   return { pluginId: n, id: e.id, type: "webview", ..., icon: null, channel: "app", ... }
   ```

   而且卡片键白名单（`bC`）里没有 `icon`，只有 `face` / `pageIcon` 这些。
   那条路走的是内置卡。

### 曾试过的两条替代路径，都不可行

- **靠半透明混背景间接跟随。** 图标渲染色 = `透明度 × 固有色 + (1−透明度) × 背景`。
  要让图标在常态落在 187、悬停落到主题色 114：
  `(1−a) × (240.0 − 232.7) = 187 − 114`，解出 **`a = −9`**。
  宿主的悬停背景亮度只差 **7**，需要的差是 **73**。物理上不可能。
  这也解释了为什么前几轮调色始终追不上——调参余地本来就不存在。
- **改用宿主内置图标。** 这是最终采纳的方案。宿主画它自己的页面图标（内联 SVG），
  `currentColor` + 45% 淡化，主题色与悬停都完美跟随，与左侧栏其它条目完全一致。
  代价是丢掉 MinerU 的图形辨识度。

### 悬停态实测（从截图量的）

| | 行背景 | 标签文字 |
| --- | --- | --- |
| 常态 | `#F0F0F2`（亮度 240.0） | `#95959C` |
| 悬停 | `#E8E8F2`（亮度 232.7） | `#636AE8`（主题色） |

### 另外两个只有实测才知道的坑

- **`pageIconUrl` 不带内容哈希，跨安装不变。** 地址是
  `/api/apps/<id>/ui/assets/<文件名>`。React 用「revision + url」当 `<img>` 的 key，
  地址不变就不重建节点，浏览器也就不重新取图，界面会一直显示第一次解码的旧图。
  宿主给 SVG 设了 `Cache-Control: no-store`，但那只拦 HTTP 缓存，
  拦不住「节点不重建就不发请求」这条路径。
  **改图标内容后必须同时改文件名**，否则改动压根不会上屏。
- **`pageIcon` 会被真正解码并做安全检查**（比封面严）。塞一个带 `<script>` 的图，
  校验直接报 `INVALID_PAGE_ICON | app icon: SVG must not contain <script>`；
  它还拦 `<foreignObject>` / 外链 `href` / 实体声明 / SMIL 动画。
  而 `face.image` 的封面**完全不检查能否解码**（写坏成非法 XML 照样 0 error）。

### 若要找回图标：需要宿主改一处

宿主把 `pageIcon` 从 `<img>` 改成 CSS `mask` 渲染即可两全：

```css
.fpSiteNavEntryIcon {
  mask-image: url(页面图标);
  background-color: currentColor;   /* 于是自动跟随主题色与悬停 */
}
```

这样既保留自定义图标，又跟随主题色与悬停。这是宿主侧的设计缺口，
App 侧无解。

---

## 九、后续待办

- [ ] 在真实宿主里复核侧栏新增的选中项操作区（本轮已在 240～360px 四档宽度、
      420/560/760px 三档高度、20 行长列表下验过零溢出且不遮挡）
- [x] 权限台账里探针期间的 3 条 `app/session.start-turn` 旧记录已清（0626）。
      直接编辑了 `security/permission-ledger.json`，删的是已撤销的那 3 条；
      **dshana 的同类记录是它在用的能力，已保留**。
      注意宿主是**内存缓存 + 全量重写**（`build()` 每进程只读盘一次，
      `persist()` 从 `this.records` 整体写回），所以这次编辑要**重启宿主**
      才会稳定生效；在重启前若发生任一权限变更，会被内存里的副本盖回去。
- [ ] 侧栏现在是历史的唯一入口；若将来要多开几个侧栏面板，
      需注意 `functionPanel` 每张卡只能声明一块。
      （尤其 `--control-height`：预览里该变量为空，按钮高度走的是内联兜底值）
- [ ] 决定要不要「整页主卡」（v1 同时提供过 page 与 widget 两个表面）；
      现在是普通卡，可拆窗但不当整页
- [ ] 迁移后首次装载时把 v1 的旧配置搬过来（`translationTargetLanguage` 的别名归一化
      已在 `/options` 里做了，但旧的 `translationModel` 字段还留在旧配置里没人读）
- [ ] `job-store` / `translate` 的共享模块版本号规矩要写进 v2 文档
      （v2 一样有 ESM 缓存问题，文件名带版本号的做法继续有效）
- [ ] 复核 `docs/hana-plugin-gotchas.md` 里哪些 v1 限制在 v2 已不成立
      （例：v1「改配置要重启 Hana」在 v2 不再需要）
- [ ] 结果图片的 `blob:` 方案在 v2 里是否还有必要
      （v1 是被迫的：裸 `<img>` 不带凭据会被 403。v2 的 `hana.api.fetch` 走 header 认证，
      所以仍然需要 fetch → blob；但值得在真实宿主里确认一次）

关于目录里那个看起来别扭的 `ui/assets/assets/rice-paper-*.png`：
它由 `app-ui.css` 以相对路径引用，位置不能动，删了控件背景会缺图。

---

## 十、验证记录

| 检查 | 结果 |
| --- | --- |
| `validate-app.mjs --dir <app>` | 0 error，1 warning（动态依赖无法静态证明，脚手架生成时也有） |
| `node --test "tests/*.test.mjs"` | 190 pass / 0 fail |
| `node --test "reference/v1-panel/*.test.mjs"` | 10 pass / 0 fail |
| 全模块导入冒烟（Node，含随包 SDK 100 个模块） | 100/100 干净加载 |
| `extension-pack.mjs --kind app` | 产出 `dist/app-mineru-document-workbench-0.2.1.zip` |
| `production-smoke.mjs` | 通过：入口、工具、路由、能力声明、页面资源引用、无仓库材料、无凭据 |
| `preflight-secrets.mjs` | 通过：无敏感信息、无本机路径 |
| 本地浏览器渲染 | 通过：控件全部挂载，布局与 Markdown 排版正常 |

### 真实宿主验收（本次实际做的）

| 检查 | 结果 |
| --- | --- |
| 正式安装（`extension_manager` 本地目录安装 + 确认） | 成功；`host=on agent=on`，v0.2.1 |
| apply 执行与工具注册 | 成功；日志 `PROBE-RESULT ok=[四个名字] fail=[]` |
| 权限授权 | 5 项能力全部 `allowed` / `tier: always` |
| 工具调用（新对话） | 成功；`list_jobs` 返回真实内容 `[]`，无报错 |
| 工具名兼容性 | **确认不需要改名**，`{appId}_` 前缀在 v2 完全可用 |
| 卡片在真实宿主渲染 | 成功；三栏布局、官方控件、三个后端路由（`/options` `/jobs` `/translation-models`）全部调通 |
| 浮层背景与目标语言控件 | 本地测试台（桩 SDK 跑真实 `panel.js`）验证通过 |
| 侧栏（功能面板）落点 | 宿主卡片表投影与 DSHana 逐字同构 ✅ |
| 侧栏操作界面 | 本地测试台验证：刷新/垃圾桶全部在行内（240/280/320/360px 四档零裁切、零溢出）、
  长文件名省略、批量勾选与计数一致、确认浮层文案带文件名与体积 |
| 行内刷新 | 双 iframe 测试台验证：点击→忙碌态→侧栏状态更新→**主卡自动重载结果** |
| 批量条窄宽度适配 | 本地测试台实测 150/180/200/240/300/380px 六档，`scrollWidth - clientWidth` 均为 0（修复前 260px 已溢出 2px，越窄越明显） |
| 侧栏↔主卡联动 | 双 iframe 测试台验证：初始两栏无历史容；侧栏点选→主卡切换任务；
  侧栏删除选中项→主卡自动清空 |
| App 存储取值包装 | 单测把 `unwrapStored` 抽出真跑各形状（裸值 / 一层包装 / 双层 / 对象值不误拆） |
| 卡槽位实测 | 探针读到 `surface.slot: "card"`（与能力白名单的推断一致） |
| `hana.emit` 从整页卡 | 实测被拒（`PLUGIN_EMIT_NO_ROUTE` / `PLUGIN_EMIT_INPUT_INVALID`），见第五节 |
| 侧栏选中项操作区 | 测试台验证：未选中时隐藏、选中后两个按钮、多选模式下隐藏；
  240/280/320/360px × 420/560/760px × 20 行长列表下零溢出且不被推出视野 |
| 侧栏剪贴板指令 | 测试台验证两份指令文本正确，且译文指令带上了主卡广播的目标语言 |
| 主卡另存 | 测试台验证 `.md` 内容等于 `preview.markdown`（非 HTML），
  UTF-8 base64 往返一致，文件名已净化，译文另存同样取原始 Markdown |
| 另存入口唯一且随页签分派 | 测试台验证：DOM 里只有 1 个另存按钮、在标题行内；
  Markdown 页签存结果、译文页签存译文、JSON 页签存结果 Markdown；
  240～520px 五档宽度下按钮恒定 88px、零裁切、长标题不挤出 |
| 导出格式下拉 | 测试台验证：与另存按钮同组、在标题行内；7 档宽度（260～900px）
  零裁切零溢出；选 zip 发 `format=zip` 并存成 `application/zip`（字节以 `PK\x03\x04` 开头，
  证明二进制完整穿过 base64）；选 inline 发 `format=inline` 并存成 `text/markdown`；
  译文页签额外带 `translation=中文`、文件名 `.中文.md` |
| 导出（真实数据） | 见第七节：7 个条目 CRC 全过，6 张图解压后与磁盘原图逐字节一致，
  包内 md 与源文件逐字节相同 |
| 主机允许判定 | 单测：`notmineru.net` / `evil-aliyuncs.com` / `mineru.net.evil.com`
  一律拒绝，真正的子域放行；预览渲染与导出下载走同一函数 |
| 上传区（拖放 / 粘贴） | 测试台验证：拖入 `季度总结.pdf` 时请求体是 **File （原始字节 12B）**、
  收到引用后选中行出现、开始解析可用；粘贴 `image.png` 被重命名为`粘贴图片-<时间戳>.png`；
  提交时携带的是 intake 返回的 `{kind:'local-file'}` 引用与文件名；
  `.exe` 被**前端**拦下（intake 计数未增）且不破坏已有选择；移除按钮清空全部状态 |
| intake 落点 | 单测：字节逐字节一致、路径在 dataDir 的 `intake/` 子目录内、
  同内容复用同一路径、`../../evil.pdf` 不得越出 dataDir、空 body 与缺名被拒、
  超限先被 content-length 拦下 |
| 侧栏固定页脚 | 无头 Edge 实测（面板 190×360）：3 条 / 30 条 / 30 条+多选 三个场景下，
  页脚底距均为 12（= 面板内边距）、列表→页脚均为 10、溢出均为 0；
  页脚位置在短列表与长列表之间**完全一致** |
| 主卡滚动归属 | 无头 Edge 实测（卡片 1180×700，长文档）：整页与左栏的可滚高度均为 0，
  预览区为 5030；预览滚到底后标题/页签的视口位置不变；预览内边距未被吃掉 |
| 设置页 Token | 无头 Edge 实测：`type="password"` 渲染为圆点、**无**显示按钮
  （这是“先不打码”的直接原因）；曾试过 `sensitive: true`，安装前后已存 Token 的
  SHA-256 前 12 位一致（`716f5d45d0a5`）、长度 51 未变，证明敏感位翻转不会用星号覆盖真值 |
| 删除提示 | 无头 Edge 驱动真实删除流程（垃圾桶 → 确认浮层）：
  失败的那条如实上报且行未被删；成功的那条状态行**为空且不占位**，
  上一条“已复制”也被一并清掉 |
| 行右键菜单 | 无头 Edge 实测：菜单三项齐全；开启前后页脚位置完全相同（零位移）；
  靠右下的坐标 (178,330)/(185,335) 被自动调到界内；
  重命名/刷新/删除三条路径的后端调用与界面更新都符合预期 |
| 提示改吐司 | 无头 Edge 实测（验调用与载荷，视觉归宿主）：选中→0 条；复制→success；
  删失败→error；删成功→0 条；重命名→success；每条 `duration` 均为 3000 且 type 合法；
  页脚高度未选中时 0、选中后 101（不再随消息变化） |
| 重命名后端 | 单测（9 条）：只改文件名不动其他字段、分隔符与控制字符被清洗、
  空名与超长被拒、不存在的 job 为 404、非法 id 为 400、无临时文件残留 |
| 外部文件读取（`--allow-fs-read` 问题） | 修复后端到端解析成功（见第四节问题 6） |
| Node 权限模型行为 | 本地独立复现：`--allow-fs-read=<dataDir>` 下 dataDir 内可读、外部路径报同一条 `ERR_ACCESS_DENIED` |

### 仍未验证的

- 翻译通过 `sdk.models.streamEvents` 的实际效果
- 卡片 iframe 里结果图片的加载（需真实解析结果与图片）
- `sdk.resources.stage` 的真实回包形状（适配层做了防御性归一化）
- 侧栏在真实宿主里的最终观感（本轮布局在 300px 宽的测试台里验证）
