# MinerU 文档工作台

一个 [Hana](https://github.com/liliMozi/openhanako) 插件：通过 **MinerU** API 解析文档，输出结构化的 Markdown / JSON。提供三栏工作台页面、对话内引用，以及用你自己指定的 Hana 模型翻译文档。

支持的输入格式：PDF、图片（png / jpg / jpeg / jp2 / webp / gif / bmp）、DOC / DOCX、PPT / PPTX、XLS / XLSX。
<img width="2702" height="1553" alt="image" src="https://github.com/user-attachments/assets/000a6e45-afb3-404c-903b-364c8e071a5d" />



## 功能

- **三种解析方式，两个通道**
  - `MinerU VLM`：精准解析 API，视觉大模型，复杂版式、公式与图表效果更好（需要 Token）
  - `MinerU`：精准解析 API，传统管线模型，速度更快、输出更稳（需要 Token）
  - `Agent 轻量解析 API`：轻量通道，**不需要 Token**，单文件 ≤10MB、≤20 页、仅 Markdown
- **三栏工作台页面**：左边是解析历史，中间是结果预览，右边是上传与操作
- **真正渲染 Markdown**：标题、列表、代码块、管道表格与图片都能正常显示；MinerU 返回的原始 HTML 表格（常见于表格类文档的结果）会被保留
- **文档翻译**：选定目标语言与 Hana 中任意已配置的聊天模型即可翻译；长文档自动分块，代码块不翻译
- **历史管理**：每个任务的状态、等待时长、页进度都用中文显示，支持单条删除（记录连同结果文件一起删）
- **Agent 工具**：`submit_document`、`recover_batch`、`reference_result`、`translate_result`、`list_jobs`

## 安装

1. 从 [Releases](../../releases) 下载 `mineru-document-workbench-0.1.0.zip`（**不要解压**）。
2. 打开 HanaAgent 的 **设置 → 插件**，把 zip 文件拖到页面上的安装区，或点击安装区选择该文件。
3. 安装完成后，插件列表里会出现「MinerU 文档解析」。
4. 打开 **设置 → 插件 → MinerU 文档解析**，填入你的 MinerU API Token。可在 <https://mineru.net> 申请。

安装只写入插件目录，**不会影响插件配置与已有历史记录**（升级安装时同理）。

> Token 只有精准解析通道需要。`Agent 轻量解析 API` 方式不需要 Token，所以你可以先不注册账号就试用这个插件。
>
> 需要 HanaAgent 0.159.0 或更高版本（见 `manifest.json` 的 `minAppVersion`）。

想从源码安装或用 dev 循环调试，见文末的「开发」一节。

## 配置项

在 Hana 的插件设置页配置：

| 键 | 默认值 | 说明 |
|---|---|---|
| `apiBaseUrl` | `https://mineru.net` | MinerU API 地址 |
| `apiToken` | – | MinerU 的 Bearer Token |
| `modelVersion` | `vlm` | 默认解析方式：`vlm` / `pipeline` / `agent`，也可在插件页面上临时选择 |
| `translationTargetLanguage` | `中文` | 翻译的默认目标语言，与插件页面上的语言列表一致 |
| `pollIntervalMs` | `2000` | 保留参数 |
| `pollTimeoutMs` | `600000` | 保留参数 |


> 新增或删除配置项后需要**重启 Hana** 才会出现在设置页：配置表的 schema 在应用启动时缓存。

## 解析方式

选择器在页面右侧。你的选择会被记住（写回 `modelVersion`），每条历史记录也会标注当时用的方式。

| 选项 | 通道 | 需要 Token | 限制 |
|---|---|---|---|
| **MinerU VLM**（默认） | 精准解析 API | 是 | ≤200MB / ≤200 页，Markdown + JSON |
| **MinerU** | 精准解析 API | 是 | 同上 |
| **Agent 轻量解析 API** | 轻量通道 | **否** | ≤10MB / ≤20 页 / 单文件 / 仅 Markdown |

当精准通道对某种格式排队很慢时，轻量通道也是很好的备选：曾经有 Office 文件在精准通道排队数小时仍是 `pending`，换轻量通道后几秒就完成。

无法识别的解析方式会在读取文件、上传之前就被拒绝，所以敲错一个词不会白白消耗 MinerU 的额度。轻量通道按设计不返回 JSON，JSON 页签会说明原因，而不是显示一个空框。

Agent 工具接受同样的选择：`submit_document` / `parse_document` 有可选的 `modelVersion` 参数（`vlm` | `pipeline` | `agent`，别名如 `mineru` → `pipeline`、`nokey` → `agent`）。

> 不提供 `MinerU-HTML`，因为它只适用于 `.html` 输入，而本插件不接受该格式。

## 结果预览

选中一条历史记录，结果会显示在中间栏：

- **Markdown 页签**：渲染后的 HTML，包含图片
- **JSON 页签**：主要 JSON 文件（仅精准通道有）
- **译文页签**：各目标语言的译文，可切换语言

### 渲染内容的安全性

解析出来的文档属于外部输入，因此其内容不被信任：

- 原始 HTML 先被抽出，剩余文本做 HTML 转义，最后只允许白名单内的标签回来。`<script>`、`<iframe>`、`<object>` 以及事件属性（`onclick`、`onerror` 等）会被丢弃；`javascript:` 链接被剥除，只保留 `http(s)`。
- 属性按标签白名单（`colspan`、`rowspan`、`href`、`title` 等）。
- 渲染器在服务端运行，因此和其它逻辑一样有单元测试覆盖。

### 图片

结果图片由插件从该任务自己的结果目录提供（`GET /jobs/:jobId/asset/<相对路径>`），边界很明确：只允许图片扩展名，且只允许该任务 `recovered/` 目录下的路径。越权访问与非图片文件一律返回 404。

页面**不会**把 `<img src>` 直接指向这个路由：裸图片请求不携带任何凭据，宿主会以 403 拒绝。页面改为先摘掉 `src` 再插入标记，然后由页面脚本带着 surface session 经插件自己的路由取回字节，转成 `blob:` URL 加载。

## 翻译

「译文」页签用**你选择的 Hana 模型**把已完成的解析结果翻译成目标语言，走的是 Hana 里已配置的聊天模型，不经过外部翻译服务。

- 在右侧选择目标语言与模型，点「开始翻译」。进度按片段汇报；可以同时翻译第二个文档，最多两个并行。
- 译文保存在该任务的结果目录（`translated.<语言>.md`），按语言分类，并用与原文相同的净化渲染器显示。
- 长文档按约 1800 字符切片。**代码块永不送模型**，逐字节原样保留，所以译文里的代码不会被破坏。分块是无损的：重新拼装能完整还原原文（包括 `\n\n` 段落分隔），只有被翻译的部分不同。
- 某个片段失败会先提高 token 预算重试一次，仍失败则保留原文，页签报告有多少片段未翻译，而不是让整篇文档失败。
- 页面无法下载文件（插件 iframe 的沙箱没有 `allow-downloads`），所以「复制译文获取指令」会复制一句指令，由助手把译文 Markdown 作为附件交付。对应的工具是 `translate_result`。

### 模型是怎么被选中的

翻译通过宿主的 `model:sample-text` 事件调用模型，`agentId` 指向一个**插件私有 agent**（`mineru-translator`）。选择模型只会写入该 agent 的 `models.utility`，你其它 agent 及其聊天模型完全不受影响，选择也会跨文档保留。

系统提示词**原样发出**：宿主使用 `payload.systemPrompt || ""`，不追加任何内容，所以人格设定或额外指令不可能混进翻译里。只有两个占位符会被替换（目标语言、输入文本），输入文本用 `<translate_input>` 包裹。

推理型模型需要足够的空间：它可能把全部 token 预算花在思考上，一个正文字符都不返回。因此 token 下限设为 8192，重试时再提高。

## 工具

MinerU 本身是异步的，所以解析工具也是异步的。可靠的用法是两步：

1. `submit_document`：上传一个选中的文件，立即返回 `batchId`
2. `recover_batch`：查询该批次。如果 MinerU 已经返回结果，就直接从插件本地存储提供，不会重复上传；如果还在处理，则返回当前状态与进度

配套工具：

| 工具 | 说明 |
|---|---|
| `list_jobs` | 脱敏后的历史（不含凭据、不含本机路径） |
| `reference_result` | 把已完成任务的 Markdown（截取 1.2 万字符以内）及主要 JSON 附加到当前对话 |
| `translate_result` | 翻译已完成的任务，并把译文 Markdown 作为附件交付 |
| `parse_document` | `submit_document` 的兼容别名 |

`recover_batch` 从不重复上传，已完成的结果直接从磁盘读取，因此反复取回很便宜。

## HTTP 路由

供插件页面使用：

| 路由 | 用途 |
|---|---|
| `GET /options` | 可选的解析方式与当前方式 |
| `POST /jobs` | 提交一个选中的文件（可选 `modelVersion`） |
| `GET /jobs` | 脱敏的任务列表（每条含所用解析方式） |
| `GET /jobs/:jobId` | 有长度上限的 Markdown 预览（原文 + 净化后的 HTML）与主要 JSON |
| `POST /jobs/:jobId/refresh` | 查询一次批次状态并写入状态 / 进度 / 失败原因 |
| `GET /jobs/:jobId/asset/<路径>` | 该任务结果目录中的图片（仅图片、限定路径） |
| `GET /jobs/:jobId/deletion-preview` | 删除会带走什么（体积、是否进行中） |
| `DELETE /jobs/:jobId` | 删除一条记录**及其结果文件**；任务仍在进行时需带 `{ force: true }` |
| `POST /jobs/prune` | 维护用；**`dryRun` 默认为 `true`**，只清理已完成任务 |
| `GET /translation-models` | 可用于翻译的 Hana 聊天模型，以及上次记住的选择 |
| `POST /jobs/:jobId/translate` | 开始翻译（`{ targetLanguage, model? }`），立即返回 |
| `GET /jobs/:jobId/translate` | 运行状态（进度、失败）以及该任务已完成的译文 |
| `POST /jobs/:jobId/translate/cancel` | 取消进行中的翻译 |
| `GET /jobs/:jobId/translation/:lang` | 译文 Markdown 与渲染后的 HTML |
| `GET /jobs/:jobId/translation/:lang/download` | 纯 Markdown 下载（供 API 调用方使用） |

## 权限

`trust: full-access`，因为插件提供了页面与 widget，并自带后端路由。

- `network.fetch`：访问 MinerU 及其 CDN（`mineru.net`、`*.openxlab.org.cn`、`*.aliyuncs.com`）
- `resource.materialize`：读取用户选中的文件
- `model.sample` + `provider.read`：列出 Hana 的聊天模型并用选中的模型翻译
- `agent.write`：把选择记在插件自己的私有翻译 agent 里
- 宿主 UI 能力：`resource.pick`（文件选择器）与 `clipboard.writeText`（复制引用按钮）

插件只读取用户自己选择的文件，也只在自己的插件数据目录下写入任务元数据、结果与译文。

## 开发

无需构建步骤，也没有任何依赖：服务端只用 Node 内置模块与相对路径导入。

```bash
git clone <本仓库>
cd mineru-document-workbench

# 单元测试
node --test tests/*.test.mjs

# 构建可安装的插件包（产出到指定目录，默认当前目录）
# 只打运行时文件，manifest.json 位于 zip 根目录；tests/ docs/ scripts/ 不进包
node scripts/build-install-zip.mjs ..

# 发布前体检：若有凭据、本机路径或运行时文件会被发布出去，脚本会失败
node scripts/preflight-secrets.mjs .

# 生产边界冒烟：把交付包解压到仓库外，在没有 node_modules 的情况下
# 导入每一个服务端入口
node scripts/production-smoke.mjs ../mineru-document-workbench-0.1.0.zip
```

需要发布新版本时：改 `manifest.json` 里的 `version`，重新构建 zip，把它作为 release 资产上传即可（包名带版本号，文件名不需要手改）。

### 其他安装方式

- **直接放目录**：把本仓库目录复制到 `${HANA_HOME}/plugins/mineru-document-workbench`，然后重启 Hana。安装区也接受拖入整个文件夹。
- **dev 循环**：通过插件 dev 工具从本目录安装，然后 reload。社区安装的插件无法通过 dev 工具调用其工具，所以调试工具行为时请用 dev 循环。

### 修改这份代码时需要知道的事

- **共享运行时模块的文件名带内容版本号**（`job-store.v6.js`、`translate.v3.js` 等）。Hana 只对插件入口文件破除 ESM 缓存，共享模块会一直沿用进程首次加载的内容，直到服务端进程重启。修改这类模块时，请新建下一个版本、更新所有导入方、删除旧文件。
- **插件配置的 schema 在 Hana 启动时缓存**；新增或删除配置项需要重启应用，只 reload 插件不够。
- Hana 完全按 manifest 的 schema 渲染插件配置字段：布尔值 → 开关，**带 `enum` → 下拉框**，对象 / 数组 → 多行文本，其余 → 输入框（标了 `sensitive` 时是密码框）。
- 插件 iframe 的沙箱既没有 `allow-downloads` 也没有 `allow-modals`，所以点 `<a download>` 或 `window.confirm()` 不会有任何反应。

这些规则背后的宿主行为见 `docs/hana-plugin-gotchas.md`；翻译管线的设计见 `docs/translation-design.md`。

## 安全说明

- **本仓库不含任何凭据、解析结果或任务历史**，它们只存在于 Hana 运行时的插件数据目录里。
- **解析内容是外部输入，视为不可信**，渲染前会经过净化，详见上文的安全性小节。

## 已知限制

- MinerU 公开 API **不返回**控制台里那个「排在第 N 位」。页面改为显示已等待时长与页进度，同时防御性地读取位置类字段，以便 MinerU 将来提供时可以自动显示。
- 轻量通道只返回 Markdown，没有 JSON，这是 MinerU 接口的限制，不是插件的取舍。
- Office 格式是通过轻量通道验证的；精准通道对 Office 仍可能长时间排队。
- 翻译以片段为单位，长文档的术语不保证全局一致（没有术语表）。
- 翻译的运行状态在内存里：reload 插件会清掉进行中的进度。已经写入磁盘的译文不受影响。
- 插件结果存放于单一插件数据目录，不跨设备同步。

## 许可证

MIT，见 [LICENSE](LICENSE)。
