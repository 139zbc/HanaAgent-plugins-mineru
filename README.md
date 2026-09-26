# MinerU 文档解析 — Hana v2 App

用 [MinerU](https://mineru.net) 解析 PDF、图片与 Office 文档，输出 Markdown / JSON，
可引用到对话，也可用你自己指定的 Hana 模型翻译。

HanaAgent版本是v0.450.0及以下版本请用v0.1.0版本
<img width="2702" height="1553" alt="image" src="https://github.com/user-attachments/assets/41a743bf-8686-4a9b-b7e1-81bb37d08b54" />


## 目录结构

```
mineru-document-workbench/      ← 应用目录。这一层就是要发布、要安装的东西，
│                                  目录名必须与 manifest id 一字不差。
├── manifest.json               v2 清单：能力声明、设置 schema、卡片、网络白名单
├── index.js                    入口：defineApp(sdk => ...)，注册工具与后端路由
├── v2-ctx.js                   v1 ctx → v2 SDK 适配层（详见文件头注释）
├── lib/                        业务逻辑（主体从 v1 搬迁，另有导出 / 上传等新增模块）
│   ├── job-store.v6.js         任务与结果存储
│   ├── translate.v3.js         翻译管线（分块 / 重试 / 代码块保护）
│   ├── markdown-render.v2.js   Markdown → HTML，带白名单净化
│   ├── mineru-client.js        MinerU 精准解析通道
│   ├── parse-channels.v1.js    双通道提交与查询
│   ├── parse-options.v2.js     解析方式定义
│   ├── result-assets.v2.js     结果目录与图片解析（含主机白名单校验）
│   ├── export-bundle.v1.js     导出装配：zip（保目录）/ inline（内联图片）
│   ├── zip-write.v1.js         最小 ZIP 打包器（导出用，含 CRC32）
│   ├── file-types.v1.js        可解析类型白名单（提交与上传共用）
│   ├── job-actions.v2.js       删除 / 清理
│   ├── tools/                  6 个 Agent 工具
│   └── routes/                 后端路由源
│       ├── jobs.js             列表 / 详情 / 刷新 / 改名 / 删除
│       ├── translate.js        翻译与译文读取
│       ├── export.js           导出（zip / inline，含外链图下载）
│       ├── intake.js           接收拖放 / 粘贴送来的字节
│       └── status.js           健康检查
├── ui/                         界面（官方 App UI 控件）
│   ├── panel.html              主卡：两栏骨架，带 data-hana-app-ui 挂载作用域
│   ├── sidebar.html            侧栏：功能面板里的解析历史
│   └── assets/
│       ├── panel.js            主卡逻辑（结果预览 + 操作 + 与侧栏的联动）
│       ├── panel.css           主卡两栏布局 + Markdown 渲染样式
│       ├── sidebar.js          侧栏逻辑（列表、单条/批量删除）
│       ├── sidebar.css         侧栏布局（窄容器友好）
│       ├── theme-fallback.css  宿主主题变量兜底（两个页面共用）
│       ├── app-ui.js/.css      官方控件包（随包携带，勿手改）
│       ├── sdk.js              浏览器 SDK（hana.api / storage / clipboard）
│       ├── cover.svg           卡片封面
│       └── assets/             控件包的纹理图，路径由 app-ui.css 决定，勿动
├── assets/icon.svg             应用身份图标
└── sdk/                        随包携带的 App SDK（入口 import 它）

tests/        单元测试
docs/         设计文档
scripts/      打包与发布前体检
reference/    v1 的手写工作台面板（保留作迁移参考，不参与打包）
```

应用目录之外的任何东西都不会进交付包。这是刻意设计的：官方打包器会把整个
`--dir` 目录打进 zip，所以「哪些属于仓库、哪些属于安装包」只能靠目录结构来保证。

## 界面

界面外壳用官方 App UI 控件，布局由各自的 CSS 决定。分两处：

**侧栏（宿主的功能面板）** —— `sidebar.html`

三段纵向布局：

- **头部**：标题 + 「多选」（进批量模式）+ 刷新
- **列表**：解析历史，每行右侧一个刷新图标（查进度）与一个垃圾桶（页内二次确认删除）；
  这块占满剩余空间、自己滚动。**在行上右键**弹菜单：重命名 / 刷新状态 / 删除记录
  （重命名只有这里有；行内图标负责“看得见”，右键负责“一处分全”）
- **页脚（固定置底）**：选中项操作（复制引用 / 复制译文）、多选时的批量条。
  两者归为一处、永远贴在底部。操作结果与错误**不在页脚里**：它们走宿主吐司
  （浮在上层、不参与布局，3 秒后自消），所以页脚高度不会因提示而抽高抽低

选中哪条经 App 存储广播给主卡；「复制指令」为何在侧栏而不在主卡，
见 MIGRATION.md 第六节。

**主卡（整页）** —— `panel.html`

- 左侧：Markdown / JSON / 译文三个页签，译文页签带语言选择；
  标题与页签固定，**只有中间的结果区自己上下滚动**（整页与整栏都不滚）
- 右侧：**上传区**（点一下选文件 / 拖进来 / 直接粘贴，三种入口同一个目标）；
  解析方式、OCR；目标语言、翻译模型、翻译与取消（这栏自己滚）
- 标题行右侧**一个**导出入口：格式下拉（打包 zip / 单个 md）+ 另存按钮。
  导出按当前页签分派：译文页签导当前译文，其余导结果 Markdown。
  zip = md + `images/` 目录（md 保持可读、体积不变）；
  inline = 图片内联成 data URI（单文件自包含、约 +33%）。
  外链图（host 在允许列表内）会在导出时下载下来一并打包，避免链接过期。
  细节见 MIGRATION.md 第七节
- 只负责「查看与操作」：读侧栏广播的选中 id，把结果渲染出来

两个页面是两个独立 iframe，**不共享 JS 对象**，靠 App 存储通信：
侧栏写 `ui.selectedJobId`，主卡写 `ui.jobsRevision` 与 `ui.targetLanguage`。

> 两处坑：
> 1. `hana.storage.global.get(key)` 返回的是**包装对象**（`{ key, value }`），
>    不是裸值。两个页面都走 `readStored()` 拆包装，
>    否则 `typeof x === 'string'` 永远判假。详见 MIGRATION.md 第四节问题 7。
> 2. 槽位决定能力：`clipboard.writeText` 的白名单不含 **card**，
>    `resource.saveFile` 的白名单正好只含 `card`/`preview`。
>    所以“复制”只能在侧栏、“另存”只能在主卡。详见第六节。

官方控件的配色跟随宿主主题（`app-ui.css` 引用宿主注入的 `--accent` / `--bg` /
`--border` 等变量，与两个页面的布局样式用的是同一套变量名）。详见
[MIGRATION.md](./MIGRATION.md) 的「视觉验证的发现」。

控件包不来自 npm，也没有构建步骤：`ui/assets/app-ui.js` 与 `app-ui.css` 是从
Hana App Creator 自带的 SDK 包里取出来的预构建产物（`skills/hana-app-creator/assets/sdk/hana-app-sdk.tgz`）。
升级宿主时可以用同一路径取新版本覆盖，不需要改动 `panel.js` 的用法。

## 开发

单元测试（不需要 Hana 环境，纯 Node 内置模块）：

```sh
node --test "tests/*.test.mjs"
node --test "reference/v1-panel/*.test.mjs"   # 归档的 v1 面板测试
```

静态校验（需要一个装着 `APPS.md` 的 Hana Server 目录）：

```sh
# PowerShell
$env:HANA_APP_TOOLS_ROOT = "<HANA_HOME>/artifacts/server/<版本>"
node "C:\Users\Fantasy\.hanako\skills\hana-app-creator\scripts\validate_app.mjs" --dir mineru-document-workbench --json
```


## 安装与生效

### 使用者：从 Release 下载

在 [Releases](https://github.com/139zbc/HanaAgent-plugins-mineru/releases) 页下载
`app-mineru-document-workbench-<version>.zip`，交给 Hana 的扩展管理器安装即可。

> **不要用仓库的 “Download ZIP”**，也不要直接粘 GitHub 地址。
> 两者都不是可安装的 App 包：
> - 仓库压缩包里有多层目录（源码、测试、文档），而 App 安装要求
>   **包根或唯一子目录下有 `manifest.json`**；
> - App 类型不支持 `repo` 安装源（只有 Skill / Recipe / Bundle 支持
>   GitHub 地址直装）。装 App 只能用本地路径、上传压缩包或市场条目。
>
> Release 里那个 zip 才是按应用目录打的：它里面就是 `manifest.json` + 各模块。

### 开发：本地目录安装

用 `extension_manager` 以
`source: { type: "local", path: "<仓库>/mineru-document-workbench" }` 安装，
再 `confirm`。改完代码 remove + 重新 install 即可，不需要重启宿主。

也可以把 `mineru-document-workbench/` 整个目录手动放进 `<HANA_HOME>/apps/`，
然后在市场「已安装」页的「待批准」区块批准。

### 发布者：怎么产出 Release 资产

```sh
$env:HANA_APP_TOOLS_ROOT = "<Hana Server 目录>"
$env:HANA_APP_PUBLISHER  = "139zbc"
node scripts/normalize-eol.mjs .        # 确保工作区是 LF（见下）
node scripts/build-install-zip.mjs
```

产出 `dist/` 下两个文件，**两个都要传**到同一个 GitHub Release：

| 文件 | 用途 |
| --- | --- |
| `app-mineru-document-workbench-<version>.zip` | 安装包本体 |
| `app-mineru-document-workbench-<version>.entry.json` | 市场条目（`MarketItemV2` 形状） |

打包是确定性的：同一份目录打两次字节完全一致（实测两处构建哈希相同），
所以同一个 tag 重新构建不会平白造成“包变了”。

> 这个结论有一个前提：**工作区必须是 LF 换行**。发布包是直接从工作区目录打的，
> 换行符也是字节，所以 CRLF 工作区会产出与 LF 工作区不同的 zip。
> 仓库根部的 `.gitattributes`（`* text=auto eol=lf`）负责保证全新的 clone
> 拿到的是 LF；`scripts/normalize-eol.mjs` 用于修正已经存在于磁盘上的 CRLF
> 文件（比如从旧版本目录搬过来的）。这两处都是在保这个前提，
> 不是风格洁癖——失掉它，“同一 tag 可重现”就不成立了。

> 上传后可以把版本写进市场 `hana-marketplace` 的 `registry.json`（首次收录要提 PR）；
> 之后目录会自动发现后续正式 Release，不必每版都提。

### 装完之后必须新开一个对话

宿主在**对话开始那一刻**为这个对话定稿一份工具清单；同一对话内新装、
改名或卸载的工具都不会反映进去（连调用路由也按这份清单解析）。
所以工具在当前对话里不可用，**新开一个对话**它们才会出现。

这一点很容易误判成「应用装坏了」：如果安装前恰好装过同名工具（例如 v1 插件），
旧对话的清单里会留着那些名字，调用时报 `Plugin … not found`——
报的是**已卸载的旧插件**，与刚装的 app 无关。

### 改代码后怎么生效

`reload` 读的是**安装目录**（`{HANA_HOME}/apps/<id>/`），不会读仓库里的文件：
在仓库里改完要先同步过去。实测最可靠的方式是 **remove + 重新 install**
（同一个宿主进程内完成，不需要重启）。

卸载不会删 `<HANA_HOME>/app-data/mineru-document-workbench/`，任务历史与结果留在那里。

## 配置

装载后在「设置 → 应用 → MinerU 文档解析」里配置：

| 键 | 默认值 | 说明 |
| --- | --- | --- |
| `apiBaseUrl` | `https://mineru.net` | MinerU 服务地址 |
| `apiToken` | – | MinerU 的 Bearer Token；只有精准通道需要。|
| `modelVersion` | `vlm` | 默认解析方式：`vlm` / `pipeline` / `agent` |
| `translationTargetLanguage` | `中文` | 翻译的默认目标语言 |
| `pollIntervalMs` / `pollTimeoutMs` | – | 保留参数 |

v2 的设置 schema 在装载时注册，不像 v1 那样需要重启 Hana 才能看到新增字段。

> `apiToken` 刻意声名为 `sensitive: false`（明文可见）。需要核对 Token 时会反复发生，
> 而宿主通用表单不提供“点击显示”按钮，打成圆点就只能从 MinerU 官网重贴一次。
> 已查清：即便改成 `sensitive: true`，脱敏也只发生在设置页的展示投影，
> 应用自己的 `ctx.config.get` 仍读到真值，且写入时不会用星号覆盖。
> 取舍与机制详见 MIGRATION.md 第二·七节。

## 能力声明

| 能力 | 用途 |
| --- | --- |
| `app/tools.expose-to-model` | 把 6 个工具暴露给模型循环 |
| `app/session.stage-file` | 把解析结果、译文交付到当前会话 |
| `app/models.infer` | 用你选的 Hana 模型做翻译 |
| `app/resources.read` | 读取你选中的文件（含卡片里的文件选择器） |
| `app/ui.clipboard-write` | 复制译文获取指令 |

出站网络白名单：`mineru.net`、`*.openxlab.org.cn`、`*.aliyuncs.com`（GET/POST/PUT）。

## 工具

| 工具 | 说明 |
| --- | --- |
| `mineru-document-workbench_submit_document` | 上传一个选中的文件，立刻返回 `batchId` |
| `mineru-document-workbench_parse_document` | 同上，兼容别名 |
| `mineru-document-workbench_recover_batch` | 按 `batchId` 取回结果，绝不重复上传 |
| `mineru-document-workbench_list_jobs` | 脱敏的历史列表 |
| `mineru-document-workbench_reference_result` | 把已完成结果的 Markdown（截断 1.2 万字符）与主要 JSON 附到对话 |
| `mineru-document-workbench_translate_result` | 翻译已完成的结果，译文作为附件交付 |

工具名刻意与 v1 完全一致（v1 宿主会自动加 `{插件id}_` 前缀，v2 不加，所以这里手工补上），
已经按旧名字写好的 Agent 提示词和技能文档不用改。

## 许可证

MIT，见 [LICENSE](./LICENSE)。
