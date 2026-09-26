import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// 设置页的呈现完全由 manifest 的 settings schema 决定（宿主直接读 schema）：
//   boolean → 开关；有 enum → 下拉；object/array → 多行文本；其余 → 输入框
//   字符串字段若 sensitive:true，输入框是 password 且读取时被掩成 ********，
//   因此「能看见 Token」只能靠 sensitive:false。
// 这些断言把这个契约钉住，避免以后有人「顺手」改回去。
//
// v2 迁移把配置从 v1 的 `contributes.configuration.properties` 挪到了
// `contributes.settings.schema.properties`；schema 词汇表是同一套。
const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.join(here, "..", "mineru-document-workbench");
const manifest = JSON.parse(await fs.readFile(path.join(appDir, "manifest.json"), "utf8"));
const properties = manifest.contributes.settings.schema.properties;

const readPanelJs = () => fs.readFile(path.join(appDir, "ui", "assets", "panel.js"), "utf8");
const readPanelCss = () => fs.readFile(path.join(appDir, "ui", "assets", "panel.css"), "utf8");
const readPanelHtml = () => fs.readFile(path.join(appDir, "ui", "panel.html"), "utf8");
const readJobRoutes = () => fs.readFile(path.join(appDir, "lib", "routes", "jobs.js"), "utf8");
const readSidebarHtml = () => fs.readFile(path.join(appDir, "ui", "sidebar.html"), "utf8");
const readSidebarJs = () => fs.readFile(path.join(appDir, "ui", "assets", "sidebar.js"), "utf8");
const readSidebarCss = () => fs.readFile(path.join(appDir, "ui", "assets", "sidebar.css"), "utf8");

/**
 * 去掉行注释与块注释。
 *
 * 断言“某 API 不再被调用”时必预：注释里会写明历史与原因，
 * 直接搜原文会把解释文字当成调用点（已经被坑过一次）。
 */
function stripJsComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split(/\r?\n/)
    .filter((line) => !/^\s*\/\//.test(line))
    .join("\n");
}

/**
 * 取出一个 CSS 规则块（选择器到它自己的闭合花括号），**并剔除注释**。
 *
 * 剥注释走的是与 JS 那边同一个教训：解释性注释里会引用“曾经写错的写法”，
 * 不剥就会被当成真的声明（已经被坑过一次）。
 *
 * 比 `indexOf` + 固定长度切片可靠：规则里加几行注释也不会误判。
 */
function cssRule(css, selector) {
  const start = css.indexOf(`${selector} {`);
  if (start < 0) return "";
  const end = css.indexOf("}", start);
  if (end < 0) return "";
  return css.slice(start, end + 1).replace(/\/\*[\s\S]*?\*\//g, "");
}

test("the manifest is a v2 app manifest", () => {
  assert.equal(manifest.manifestVersion, 2);
  assert.equal(manifest.entry, "index.js");
  assert.ok(Array.isArray(manifest.capabilities));
  // 迁移后不再有 v1 的 trust: full-access，能力改为逐条声明
  assert.equal(manifest.trust, undefined);
});

test("the declared capabilities cover exactly what the app actually calls", () => {
  // 声明与实际调用必须对齐：声明了不用是多余的常驻授权，
  // 用了没声明会在运行时被拒。这一条盯住两个方向。
  const caps = manifest.capabilities;
  // saveFile 需要 app/resources.write；侧栏写剪贴板需要 app/ui.clipboard-write。
  for (const word of ["app/resources.write", "app/ui.clipboard-write"]) {
    assert.ok(caps.includes(word), `应声明 ${word}`);
  }
  // start-turn 是 emit 专用的；而 emit 对整页卡无用
  // （见 MIGRATION.md 第五节），所以不应图省事把它留着。
  assert.equal(
    caps.includes("app/session.start-turn"),
    false,
    "整页卡无法 emit，不应常驻 start-turn 授权",
  );
});

test("the app name is used as the settings tab title, with no '设置' suffix", () => {
  // 设置 Tab 自己已经带着应用名，再缀“设置”显得冗余。
  assert.equal(manifest.contributes.settings.title, "MinerU 文档解析");
  assert.equal(/设置$/.test(manifest.contributes.settings.title), false, "标题不应缀“设置”");
});

// 关于 apiToken 的 sensitive 位：
//
// 用户拍板“先不打码”，所以这里是 false（设置页里明文可见，方便核对与复制）。
// 但下次想翻成 true 时不用重新考古，机制已查清并实测过：
//   · 脘敏只在**设置页的展示投影**（server/routes/settings-contributions.ts 的 cL）；
//   · App 自己的 ctx.config.get 走仓库的 getSettingsContributionValues，
//     后者“值原样返回，不掩码”（宿主源码注释原话），所以解析功能不受影响；
//   · 设置页写入时，值仍为 ******** 的字段会被 Pyt 从写入中剔除，
//     所以改其他设置不会把 Token 覆盖成星号。
// 实测过翻转前后已存 Token 的 SHA-256 前 12 位一致。
// 唯一做不到的是“点击才显示”：宿主通用表单只认 sensitive 布尔位，
// 没有自定义控件入口，且 Edge 对 type="password" 也不自带显示按钮。

test("the API token is plainly visible, because checking it is a routine action", () => {
  const token = properties.apiToken;
  assert.ok(token, "apiToken must stay declared");

  // 用户选择明文：核对 Token 是常见动作，而脘敏后宿主不提供显示按钮，
  // 只能从 MinerU 官网重贴一次。
  assert.notEqual(token.sensitive, true, "Token 应明文可见（用户已拍板）");
  assert.match(token.description, /直接可见/, "应说明直接可见");
  // 别留下上一次尝试的痕迹：描述里不该再提“以圆点显示”。
  assert.equal(/圆点/.test(token.description), false, "不应再声称以圆点显示");
});

test("the translation model is not a settings field anymore", () => {
  // 模型只在工作台页面上选择；v2 里记忆落在 App 私有存储（见 v2-ctx.js），
  // 不再占用一个设置项，也不再依赖 v1 的插件私有 agent。
  assert.equal(properties.translationModel, undefined);
  assert.equal(properties.translationTargetLanguage.type, "string");
});

test("the default target language renders as a dropdown and defaults to 中文", () => {
  const lang = properties.translationTargetLanguage;
  assert.ok(Array.isArray(lang.enum), "enum is what makes the host render a select");
  assert.equal(lang.default, "中文");
  assert.equal(lang.enum[0], "中文");
  // 宿主会校验写入值必须落在 enum 内
  assert.ok(lang.enum.includes(lang.default));
  for (const item of lang.enum) assert.equal(typeof item, "string");
  assert.ok(lang.enum.length >= 10);
});

test("the parse mode setting stays a dropdown too", () => {
  const mode = properties.modelVersion;
  assert.deepEqual(mode.enum, ["vlm", "pipeline", "agent"]);
  assert.equal(mode.default, "vlm");
});

test("the network allowlist keeps the MinerU hosts", () => {
  assert.deepEqual(manifest.network.allowedHosts, ["mineru.net", "*.openxlab.org.cn", "*.aliyuncs.com"]);
});

// ── 卡片界面：官方控件 ──────────────────────────────────────────────────────

test("both pages are built from the official App UI controls", async () => {
  const panelJs = await readPanelJs();
  const sidebarJs = await readSidebarJs();

  // 官方控件的两个入口：挂载函数与随包样式表
  for (const [name, src] of [["panel.js", panelJs], ["sidebar.js", sidebarJs]]) {
    assert.match(src, /mountAppUi/, `${name} 必须通过 mountAppUi 挂载官方控件`);
    assert.match(src, /from '\.\/app-ui\.js'/, `${name} 的控件来自随包的 app-ui.js`);
  }

  // 主卡（结果预览 + 操作）用到的原子件
  for (const control of ["'Button'", "'Select'", "'Tabs'"]) {
    assert.ok(panelJs.includes(control), `主卡应当使用官方控件 ${control}`);
  }

  // 侧栏（历史列表）用到的原子件
  for (const control of ["'Button'", "'Checkbox'", "'EmptyState'", "'Inline'"]) {
    assert.ok(sidebarJs.includes(control), `侧栏应当使用官方控件 ${control}`);
  }
});

test("the history list lives only in the sidebar, not in the main card", async () => {
  // 分工：侧栏只做「挑选」，主卡只做「查看与操作」。
  // 主卡曾经自带一份历史列表（截图里能看到重复），现已收掉。
  const panelJs = await readPanelJs();
  const html = await readPanelHtml();

  assert.equal(/renderHistory|col-history/.test(panelJs), false, "主卡不应再渲染历史列表");
  assert.equal(/id="jobs"/.test(html), false, "主卡页面不应再有历史列表容器");
  // 列表相关控件也应该一并搬走
  assert.equal(/'ListRow'/.test(panelJs), false, "主卡不应再挂载 ListRow");

  // 主卡通过 App 存储接收侧栏的选中态
  assert.match(panelJs, /STORAGE_SELECTED/, "主卡应读侧栏广播的选中 id");
  assert.match(panelJs, /watchSidebar/, "主卡应订阅存储变化");
  assert.match(panelJs, /STORAGE_REVISION/, "主卡新建任务后应通知侧栏刷新列表");
});

test("the main card lays out two columns", async () => {
  const css = await readPanelCss();
  const grid = css.slice(css.indexOf('#workbench {'), css.indexOf('.col {'));
  const columns = grid.match(/grid-template-columns:\s*([^;]+);/);
  assert.ok(columns, "必须声明 grid-template-columns");
  // 历史栏收掉后应只剩两栏
  assert.equal(columns[1].includes("23%"), false, "不应再有历史栏那一列");
  assert.equal((columns[1].match(/minmax\(/g) || []).length, 2, "应为两栏布局");
});

test("the card declares the official control scope in its HTML", async () => {
  const html = await readPanelHtml();
  // 没有 data-hana-app-ui 作用域，mountAppUi 会以 APP_UI_SCOPE_REQUIRED 拒绝
  assert.match(html, /data-hana-app-ui/, "官方控件需要 data-hana-app-ui 作用域");
  assert.match(html, /assets\/app-ui\.css/, "官方控件样式必须随页面加载");
});

test("the official control bundle ships in the package", async () => {
  for (const file of ["app-ui.js", "app-ui.css"]) {
    const stat = await fs.stat(path.join(appDir, "ui", "assets", file));
    assert.ok(stat.size > 0, `ui/assets/${file} 必须随包携带且非空`);
  }
});

// ── 功能面板（侧栏）──────────────────────────────────────────────────────────

test("the workbench page contributes a function panel hosting the history sidebar", async () => {
  const card = manifest.contributes.cards[0];
  // 侧栏就是宿主的功能面板（你截图里那块“此页尚无清单”的区域）。
  assert.ok(card.functionPanel, "整页卡必须声明 functionPanel，否则侧栏不会有入口");
  assert.equal(card.functionPanel.id, "history");
  assert.equal(card.functionPanel.route, "/sidebar.html");
  // fpFullPanel：切到本页时功能面板由本页内容全占。
  assert.equal(card.fpFullPanel, true);
  // 该键只在整页卡上生效。
  assert.equal(card.realization, "page");
});

test("the function panel route points at a bundled page", async () => {
  const route = manifest.contributes.cards[0].functionPanel.route;
  assert.match(route, /^\//, "route 必须以 / 开头");
  assert.equal(route.includes(".."), false, "route 不能含 ..");
  const stat = await fs.stat(path.join(appDir, "ui", route.slice(1)));
  assert.ok(stat.size > 0, `functionPanel.route 指向的 ${route} 必须随包存在且非空`);
});

test("the sidebar only picks a job and leaves rendering to the main card", async () => {
  // 职责约定：侧栏只做「挑选」，主卡只做「查看与操作」。
  // 这个约定靠存储键单向传递实现：侧栏写选中项，不写渲染逻辑。
  const sidebarJs = await readSidebarJs();
  assert.match(sidebarJs, /hana\.storage/, "侧栏应通过 App 存储与主卡通信（两个 iframe 不共享 JS）");
  assert.match(sidebarJs, /STORAGE_SELECTED/, "侧栏应广播选中的任务 id");
  // 侧栏不接管结果渲染：那部分归主卡。
  assert.equal(/markdownHtml|renderMarkdown/.test(sidebarJs), false, "侧栏不应渲染解析结果");
});

test("scrolling the main card scrolls only the preview area", async () => {
  // 以前 `.col { overflow: auto }`：标题、页签、译文工具条都跟着内容一起滚走。
  // 现在左栏是 flex 列、自己不滚，滚动的责任归预览区。
  const css = await readPanelCss();

  // 左栏基类不再自己滚。
  assert.equal(
    /overflow:\s*auto/.test(cssRule(css, ".col")),
    false,
    ".col 不应再自己滚（那样整栏都会跟着滚）",
  );

  // 左栏：flex 列 + 不出滚动条，且必须 min-height:0。
  const viewer = cssRule(css, ".col-viewer");
  assert.match(viewer, /display:\s*flex/, "左栏应是 flex 容器");
  assert.match(viewer, /flex-direction:\s*column/, "左栏应纵向排列");
  assert.match(viewer, /min-height:\s*0/, "左栏必须 min-height:0，否则内容一长就撑破本栏");
  assert.match(viewer, /overflow:\s*hidden/, "左栏自己不滚");

  // 预览区：吃掉剩余高度并自己滚。
  const preview = cssRule(css, ".preview");
  assert.match(preview, /flex:\s*1 1 auto/, "预览区应吃掉剩余高度");
  assert.match(preview, /min-height:\s*0/, "预览区必须 min-height:0 才能收缩");
  assert.match(preview, /overflow:\s*auto/, "预览区自己滚");
  // 回归钉子：固定下限而无上限，预览会随内容长高，自己那层滚动反而不触发。
  assert.equal(
    /min-height:\s*60%/.test(preview),
    false,
    "min-height:60% 是之前“整栏在滚”的成因，不能再出现",
  );

  // 右栏内容可能很长（上传区 + 翻译设置），保持整栏自己滚。
  const actions = cssRule(css, ".col-actions");
  assert.match(actions, /overflow:\s*auto/, "右栏应自己滚");
  assert.match(actions, /min-height:\s*0/, "右栏也要 min-height:0");
});

// ── 上传区：点 / 拖 / 贴 ──────────────────────────────────────────────────

test("the upload area offers click, drop and paste in one target", async () => {
  const html = await readPanelHtml();
  const js = stripJsComments(await readPanelJs());

  assert.match(html, /id="dropZone"/, "应有拖放区");
  assert.match(html, /id="pickSlot"/, "区内应有选择文件按钮的挂载位");
  assert.match(js, /function installDropZone/, "应有安装函数");
  assert.match(js, /hana\.resources\.pick/, "点击走宿主选择器");
  // 三类监听都得在，少一个都有一种入口不可用。
  for (const evt of ["'dragenter'", "'dragover'", "'dragleave'", "'drop'", "'paste'"]) {
    assert.ok(js.includes(evt), `应监听 ${evt}`);
  }
});

test("the drop zone prevents default so the browser does not open the file", async () => {
  // 不 preventDefault 的后果很具体：浏览器会直接导航到被拖进来的文件，页面就没了。
  const js = stripJsComments(await readPanelJs());
  const body = js.slice(js.indexOf("function installDropZone("));
  // 防止默认行为的动作集中在一个 helper 里。
  assert.match(body, /const stop = \(event\) => \{ event\.preventDefault\(\)/, "应有阻止默认的 helper");
  // dragenter / dragover / drop 三个都得经过它：
  // dragover 不阻止的话，drop 根本不会触发。
  for (const evt of ["dragenter", "dragover", "drop"]) {
    assert.match(body, new RegExp(`addEventListener\\('${evt}'[\\s\\S]{0,120}stop\\(event\\)`), `${evt} 必须阻止默认行为`);
  }
  // 拖到区域外面松手也不能让浏览器把它打开。
  assert.match(body, /document\.addEventListener\('drop', swallow\)/, "页面级也要拦");
});

test("dropped and pasted files are uploaded as raw bytes, not base64", async () => {
  // 浏览器沙箱不给本地路径，只能把字节送回去让后端落盘。
  // 用 base64 会让 100MB 变成 133MB，没必要。
  const js = stripJsComments(await readPanelJs());
  const body = js.slice(js.indexOf("async function intakeFile("), js.indexOf("async function acceptFiles("));
  assert.match(body, /hana\.api\.fetch\(`intake\?name=/, "应发给 /intake");
  assert.match(body, /body: file/, "请求体应是 File 本身（原始字节）");
  assert.equal(/contentBase64/.test(body), false, "不该用 base64");
});

test("the upload area rejects unsupported types before uploading", async () => {
  const js = stripJsComments(await readPanelJs());
  const body = js.slice(js.indexOf("async function acceptFiles("), js.indexOf("async function handleDrop("));
  // 先判类型再上传：白传一个 .exe 上去没意义。
  assert.ok(
    body.indexOf("isSupportedName(name)") < body.indexOf("intakeFile(file, name)"),
    "校验必须发生在上传之前",
  );
  assert.match(body, /一次只能解析一个文件/, "多文件应明确拒绝而不是静默取第一个");
});

test("pasted screenshots get a readable name instead of image.png", async () => {
  const js = stripJsComments(await readPanelJs());
  assert.match(js, /function nameForPastedFile/, "应有命名函数");
  assert.match(js, /粘贴图片-/, "名字应可辨认");
  // 不能把用户真实文件名也改掉：只改 image.png 这类通用名。
  assert.match(js, /\^\(image\|blob\|pasted\|clipboard\)/, "只对通用名生效");
});

test("paste is ignored while typing in an input", async () => {
  // 否则在输入框里粘一份文件会变成“选文件”，干扰正在输入的文本。
  const js = stripJsComments(await readPanelJs());
  const body = js.slice(js.indexOf("document.addEventListener('paste'"));
  assert.match(body, /INPUT/, "应排除 input");
  assert.match(body, /TEXTAREA/, "应排除 textarea");
});

test("an in-app drag falls back to the plain-text path", async () => {
  // 从 Hana 自己的文件区拖出来时 dataTransfer.files 是空的（拖拽源只能放字符串），
  // 但 text/plain 里是真实路径。
  const js = stripJsComments(await readPanelJs());
  const body = js.slice(js.indexOf("async function handleDrop("), js.indexOf("async function handlePaste("));
  assert.match(body, /getData\('text\/plain'\)/, "应读 text/plain");
  assert.match(body, /kind: 'local-file'/, "应回退成路径引用");
});

test("the upload area keeps the filename shrinkable and the actions fixed", async () => {
  const css = await readPanelCss();
  assert.match(css, /\.selection-name\s*\{[^}]*min-width:\s*0/s, "文件名要能缩");
  assert.match(css, /\.selection-row \.slot\s*\{[^}]*flex:\s*none/s, "操作按钮不可缩");
  // 拖放高亮是唯一可用的反馈。
  assert.match(css, /\.drop-zone\.is-over/, "应有拖到上方的高亮态");
});

// ── 行右键菜单 ──────────────────────────────────────────────────────────

test("each row offers a right-click menu with rename, refresh and delete", async () => {
  const html = await readSidebarHtml();
  const js = stripJsComments(await readSidebarJs());

  assert.match(html, /id="rowMenuMount"/, "应有菜单挂载点");
  assert.match(js, /addEventListener\('contextmenu'/, "行上应监听右键");
  assert.match(js, /openRowMenu\(/, "应有开关菜单的函数");
  assert.match(js, /mountAppUi\([^)]*'ContextMenu'/, "应使用官方 ContextMenu 控件");

  // 三项必须齐全（重命名只有这里有，另两个与行内图标重叠）。
  const menu = js.slice(js.indexOf("function openRowMenu("), js.indexOf("function closeRowMenu("));
  for (const label of ["重命名", "刷新状态", "删除记录"]) {
    assert.ok(menu.includes(`'${label}'`), `菜单应包含「${label}」`);
  }
  assert.match(menu, /danger:\s*true/, "删除项应标为危险");
});

test("the context menu mount point is inside the App UI scope, outside the list", async () => {
  // 实测：挂到作用域外会被 APP_UI_SCOPE_REQUIRED 拒。
  const html = await readSidebarHtml();
  const main = html.slice(html.indexOf('<main id="sidebar"'), html.indexOf("</main>"));
  assert.ok(main.includes('id="rowMenuMount"'), "挂载点必须在 data-hana-app-ui 作用域内");
  // 也不要在列表/页脚里：避开前者的滚动容器与后者的布局。
  const listToFooter = html.slice(html.indexOf('id="jobs"'), html.indexOf("</footer>"));
  assert.equal(
    listToFooter.includes('id="rowMenuMount"'),
    false,
    "挂载点不该在列表或页脚内部",
  );
});

test("the menu is rebuilt on every open so it repositions", async () => {
  // 实测：走 renderCtrl 的话同类型控件会走 update，而 update 不会重新定位
  // ——菜单会停在第一次的位置。所以每次开都必须重建。
  const js = stripJsComments(await readSidebarJs());
  const body = js.slice(js.indexOf("function openRowMenu("), js.indexOf("function closeRowMenu("));
  assert.match(body, /closeRowMenu\(\)/, "开之前先关掉旧的");
  assert.match(body, /createElement\('div'\)/, "应新建挂载节点（不复用旧的）");
  assert.match(body, /position:\s*\{ x, y \}/, "应把光标坐标传下去（控件自己会夹取边界）");
});

test("rename goes through the backend and refreshes the list", async () => {
  const js = stripJsComments(await readSidebarJs());
  const body = js.slice(js.indexOf("function askRename("), js.indexOf("function openPrompt("));
  assert.match(body, /jobs\/\$\{job\.jobId\}\/rename/, "应调后端的 rename 路由");
  assert.match(body, /loadJobs\(\)/, "改名后要重拉列表（新名字）");
  assert.match(body, /bumpRevision\(\)/, "也要通知主卡（标题会变）");
  assert.match(body, /名称不能为空/, "前端也要拦空名，不能只靠后端");
});

test("the rename prompt reuses the in-page modal with a text field", async () => {
  // iframe 无 allow-modals，window.prompt 用不了；官方控件里也没有 prompt。
  const html = await readSidebarHtml();
  const js = stripJsComments(await readSidebarJs());
  assert.match(html, /id="modalField"/, "确认浮层应带一个输入区");
  assert.match(js, /function openPrompt\(/, "应有带输入的浮层");
  assert.match(js, /renderCtrl\('modalField', 'TextInput'/, "输入区应挂官方 TextInput");
  assert.equal(/window\.prompt\s*\(/.test(js), false, "不得用 window.prompt");
  // 关浮层时要一并清掉输入控件，否则下次开会带着上次的值。
  const close = js.slice(js.indexOf("function closeConfirm("), js.indexOf("// ── 行右键菜单"));
  assert.match(close, /clearCtrl\('modalField'\)/, "关时应清掉输入控件");
});

// ── 侧栏操作（垃圾桶 + 确认浮层 + 批量删除）──────────────────────────────

test("each history row carries its own delete affordance, not a clipped overflow menu", async () => {
  // 回归：早先用官方 ListRow 的 overflowItems，在 ~350px 的窄侧栏里
  // 溢出菜单被挤掉，只露出半个“操作”（截图里可见）。
  const sidebarJs = await readSidebarJs();
  assert.equal(/overflowItems/.test(sidebarJs), false, "不应再用 ListRow 的溢出菜单作删除入口");
  assert.match(sidebarJs, /row-del/, "每行应有自己的删除按钮");
  assert.match(sidebarJs, /<svg/, "删除按钮用内联 SVG 图标（官方图标集无垃圾桶）");

  // 结构上不可缩是刻意写死的：flex:none 才是“不再被裁掉”的保证。
  const css = await readSidebarCss();
  assert.match(css, /\.row-del\s*\{[^}]*flex:\s*none/s, ".row-del 必须 flex:none，否则窄容器里会被裁");
  assert.match(css, /\.row-main\s*\{[^}]*min-width:\s*0/s, ".row-main 必须 min-width:0，长文件名才会省略而不是挤掉按钮");
});

test("the sidebar confirms before deleting, without relying on window.confirm", async () => {
  // iframe 的 sandbox 不含 allow-modals；官方控件集里也没有 Modal，
  // 所以确认界面必须是页内浮层。
  const sidebarJs = await readSidebarJs();
  const html = await readSidebarHtml();
  assert.equal(/window\.confirm\s*\(/.test(sidebarJs), false, "不能依靠 window.confirm");
  assert.match(sidebarJs, /openConfirm/, "删除前必须先弹确认");
  assert.match(html, /id="modal"/, "确认浮层的容器应在页面里");
  assert.match(html, /role="dialog"/, "确认浮层应有 dialog 语义");
});

test("the sidebar supports batch deletion", async () => {
  const sidebarJs = await readSidebarJs();
  const html = await readSidebarHtml();
  assert.match(sidebarJs, /selectMode/, "应有批量选择模式");
  assert.match(sidebarJs, /pickedIds/, "应记录已选中的任务");
  assert.match(sidebarJs, /deleteJobs/, "批量删除应走同一个删除实现");
  // 进行中的任务必须带 force，否则服务端返回 409
  assert.match(sidebarJs, /force:\s*IN_PROGRESS\.has/, "进行中的任务删除时必须带 force");
  assert.match(html, /id="batchBar"/, "批量操作条应在页面里");
});

test("single and batch deletion share one confirmed path", async () => {
  const sidebarJs = await readSidebarJs();
  // askDelete 同时服务于单条（垃圾桶）与批量（操作条），确保两条入口行为一致。
  assert.match(sidebarJs, /askDelete\(\[job\]\)/, "垃圾桶走 askDelete 单条");
  assert.match(sidebarJs, /askDelete\(jobs\)/, "批量走同一个 askDelete");
});

test("the revision bump is monotonic so two quick changes are not coalesced", async () => {
  const sidebarJs = await readSidebarJs();
  // 用 Date.now() 时，同一毫秒内的两次改动会写出同一个值，主卡可能收不到通知。
  assert.equal(/set\(STORAGE_REVISION,\s*Date\.now\(\)\)/.test(sidebarJs), false, "不要用时间戳做版本号");
  assert.match(sidebarJs, /\(typeof prev === 'number' \? prev : 0\) \+ 1/, "版本号应递增");
});

// ── App 存储的取值包装（回归：导致「选中不生效」的真因）────────────────────

async function loadUnwrap(side) {
  const src = side === 'sidebar' ? await readSidebarJs() : await readPanelJs();
  const match = /function unwrapStored\(raw\) \{[\s\S]*?\n\}/.exec(src);
  assert.ok(match, `${side}: unwrapStored 必须存在`);
  return new Function(`${match[0]}\nreturn unwrapStored;`)();
}

test("the card unwraps the app-storage value envelope", async () => {
  // 真因：hana.storage.global.get(key) 返回的不是裸值，而是包装对象
  // （与宿主 v1 存储版的 { key, value } 同形）。
  // 直接 typeof x === 'string' 会永远判假 —— 现象是“事件收到了、get 也没报错，
  // 但选中态始终是 null”。下面把真实实现抽出来跑一遍各形状。
  for (const side of ['panel', 'sidebar']) {
    const unwrap = await loadUnwrap(side);
    // 裸值
    assert.equal(unwrap('abc'), 'abc');
    assert.equal(unwrap(7), 7);
    assert.equal(unwrap(null), null);
    assert.equal(unwrap(undefined), null);
    // 一层包装（实测形状）
    assert.equal(unwrap({ key: 'k', value: 'abc' }), 'abc');
    assert.equal(unwrap({ value: 3 }), 3);
    // 包装里是 null（未设置）
    assert.equal(unwrap({ key: 'k', value: null }), null);
    // 双层包装（防御）
    assert.equal(unwrap({ value: { value: 'deep' } }), 'deep');
    // 对象值不应被误拆
    const obj = { id: 'MiniMax-M3', provider: 'minimax' };
    assert.deepEqual(unwrap(obj), obj, '没有 value 键的对象应原样返回');
  }
});

test("every storage read goes through the unwrapping helper", async () => {
  // 防止以后新增调用点又忘了拆包装。
  for (const [side, read] of [['panel', readPanelJs], ['sidebar', readSidebarJs]]) {
    const src = await read();
    // 去掉注释行再数，否则文档里的示例写法会被误计。
    const code = src
      .split(/\r?\n/)
      .filter((line) => !/^\s*(\*|\/\/)/.test(line))
      .join('\n');
    const direct = [...code.matchAll(/hana\.storage\.global\.get\(/g)].length;
    // 允许两处：readStored 内部一处 + panel 的诊断原始读取一处。
    const limit = side === 'panel' ? 2 : 1;
    assert.ok(
      direct <= limit,
      `${side}.js 不应有 ${direct} 处直接调用 get；请改用 readStored()（允许上限 ${limit}）`,
    );
  }
});

// ── 行内刷新（取代主卡的「查询选中任务」）────────────────────────────

test("each row has a refresh control placed left of the delete control", async () => {
  const sidebarJs = await readSidebarJs();
  const css = await readSidebarCss();

  assert.match(sidebarJs, /row-refresh/, "每行应有刷新按钮");
  assert.match(sidebarJs, /REFRESH_SVG/, "刷新图标应自绘（官方图标集无刷新）");

  // 位置：刷新在删除左侧（先中性、后危险）。
  const refreshAt = sidebarJs.indexOf("row.appendChild(refresh)");
  const delAt = sidebarJs.indexOf("row.appendChild(del)");
  assert.ok(refreshAt > 0 && delAt > refreshAt, "刷新按钮必须排在删除左侧");

  // 与删除一样不可缩，否则窄容器里会被裁。
  assert.match(css, /\.row-refresh\s*\{[^}]*flex:\s*none/s, ".row-refresh 必须 flex:none");
  assert.match(
    css,
    /\.row-refresh:focus-visible/s,
    "刷新按钮应参与焦点样式（与删除、主体一致）",
  );
});

test("the row refresh queries the remote state and notifies the main card", async () => {
  const sidebarJs = await readSidebarJs();
  const body = sidebarJs.slice(
    sidebarJs.indexOf("async function refreshOne("),
    sidebarJs.indexOf("function render()"),
  );
  assert.match(body, /refresh/, "应调用后端的刷新接口");
  assert.match(body, /method: 'POST'/, "刷新是 POST");
  // 状态可能变了，必须通知主卡重取结果。
  assert.match(body, /bumpRevision\(\)/, "刷新后应通知主卡");
  assert.match(body, /loadJobs\(\)/, "刷新后应重拉本地列表");
  // 点下去要有反馈，否则会被当成坏了。
  assert.match(body, /busy/, "刷新中应有忙碌态反馈");
});

test("the main card no longer offers a manual refresh button", async () => {
  // “查询选中任务”已搬到侧栏行内：它属于「对某条记录做操作」。
  const panelJs = await readPanelJs();
  const html = await readPanelHtml();
  assert.equal(/refreshJobSlot/.test(panelJs), false, "主卡不应再挂载查询按钮");
  assert.equal(/refreshJobSlot/.test(html), false, "主卡页面不应再有该挂载位");
  // 界面上不应再出现那个按钮文案（注释里的历史说明不算）。
  const code = panelJs
    .split(/\r?\n/)
    .filter((line) => !/^\s*(\*|\/\/)/.test(line))
    .join('\n');
  assert.equal(/查询选中任务/.test(html + code), false, "相关文案应一并移除");

  // 但**自动轮询要保留**：它不是手动入口，且用的还是同一个刷新接口。
  assert.match(panelJs, /function startAutoPoll/, "主卡的自动轮询不应被误删");
});

test("the main card reloads preview when the selected job's state changes", async () => {
  // 侧栏行内刷新把任务查成 done 后，主卡必须重取结果，
  // 否则会一直显示“正在解析”时的旧内容。
  const panelJs = await readPanelJs();
  const body = panelJs.slice(
    panelJs.indexOf("async function syncSelection("),
    panelJs.indexOf("function updateViewerHead("),
  );
  assert.match(body, /stateChanged/, "应检测选中任务的状态变化");
  assert.match(body, /loadPreview\(job\)/, "状态变化时要重取结果");
});

// ── 两个只有真跑界面才会暴露的坑（本地测试台拓到的）────────────────────

test("official controls are mounted only after the row is attached to the DOM", async () => {
  // mountAppUi 要求宿元素已在 data-hana-app-ui 作用域内（它用 closest() 查祖先）。
  // 在还没插入文档的行里挂控件会直接抛 APP_UI_SCOPE_REQUIRED，结果是
  // 整张列表变空——静态检查看不出来，只有真跑才暴露。
  const sidebarJs = await readSidebarJs();
  const buildRowBody = sidebarJs.slice(
    sidebarJs.indexOf("function buildRow("),
    sidebarJs.indexOf("function render()"),
  );
  assert.equal(
    /mountAppUi/.test(buildRowBody),
    false,
    "buildRow 里不能挂官方控件；它拿到的行还在游离状态",
  );
  assert.match(sidebarJs, /function attachPick/, "应由 attachPick 在入 DOM 后再挂");
  // 调用点必须排在 appendChild 之后
  const withRow = sidebarJs.indexOf("host.appendChild(row)");
  const attachAt = sidebarJs.indexOf("attachPick(row, job)");
  assert.ok(withRow > 0 && attachAt > withRow, "attachPick 必须排在 appendChild 之后");
});

test("toggling a pick writes the new state back to the controlled checkbox", async () => {
  // 官方 Checkbox 是受控组件：只改自己的状态、不更新 props，React 会把 DOM
  // 的勾选态复位——表现出来就是“行高亮了、勾选框却是空的”。
  const sidebarJs = await readSidebarJs();
  assert.match(sidebarJs, /handle\.update\(pickProps\(job\)\)/, "勾选后必须把新状态回写给控件");
  assert.match(sidebarJs, /pickHandles/, "需要按 jobId 记住控件 handle 才能回写");
  // 同时不要整表重渲染，否则连续勾选会打在旧节点上
  const toggleBody = sidebarJs.slice(
    sidebarJs.indexOf("function togglePick("),
    sidebarJs.indexOf("function syncPick("),
  );
  assert.equal(/\brender\(\)/.test(toggleBody), false, "togglePick 不应整表重渲染");
});

test("the batch bar wraps instead of overflowing a narrow panel", async () => {
  // 实测：文字 + 两个按钮固定占 236px 内容宽（即面板 ≥260px），
  // 再窄就开始溢出（260px 时溢出 2px）。实测面板窄到 ~240px 就要能换行。
  const css = await readSidebarCss();
  const batchBlock = css.slice(css.indexOf(".batch {"), css.indexOf(".batch-text"));
  assert.match(batchBlock, /flex-wrap:\s*wrap/, ".batch 必须允许换行");

  const textBlock = css.slice(css.indexOf(".batch-text {"), css.indexOf(".batch-actions"));
  // 默认 min-width:auto 会让 nowrap 的文字拒绍收缩，整条被撑破而不是换行。
  assert.match(textBlock, /min-width:\s*0/, ".batch-text 必须 min-width:0，否则撑破容器");
  assert.match(textBlock, /text-overflow:\s*ellipsis/, "计数文案过长时应省略号而不是撑破");

  const actionsBlock = css.slice(css.indexOf(".batch-actions {"));
  // 不写 min-width:0 的话，它以 max-content 宽度挺出去，内层永远换不了行。
  assert.match(actionsBlock.slice(0, 400), /min-width:\s*0/, ".batch-actions 必须 min-width:0（极端窄时才能被约束并内部换行）");
  assert.match(actionsBlock.slice(0, 400), /flex-wrap:\s*wrap/, ".batch-actions 自身也要能换行作兜底");
});

test("the card talks to the host through the browser SDK, not a private handshake", async () => {
  const panelJs = await readPanelJs();
  // v1 靠 postMessage 协议 + 手拼插件路径 + 回传 surface session 头；
  // v2 这三个都由 SDK 承担。
  assert.equal(/hana\.plugin\.ui/.test(panelJs), false, "不应再使用 v1 的 postMessage 协议");
  assert.equal(/X-Hana-Plugin-Surface-Session/.test(panelJs), false, "凭据不应由页面自己拼接");
  assert.equal(/\/api\/plugins\//.test(panelJs), false, "不应再手拼 v1 的插件路由前缀");
  assert.match(panelJs, /hana\.api\.fetch/, "后端调用走 hana.api.fetch");
  assert.match(panelJs, /hana\.resources\.pick/, "文件选择走 hana.resources.pick");
});

// ── 槽位与能力：谁做什么由宿主白名单决定 ────────────────────────────────
//
// 宿主的能力表（取自渲染器的 allowedSlots）：
//   clipboard.writeText → [page, widget, settings, function-panel]
//   resource.saveFile   → [card, preview]
// 应用卡是 card 槽位，侧栏是 function-panel，所以两张表的交集为空。
// 这不是选择，是约束：“复制”只能在侧栏，“另存”只能在主卡。

test("the main card saves instead of copying, because card slots cannot write the clipboard", async () => {
  const code = stripJsComments(await readPanelJs());
  // card 槽位调 clipboard.writeText 会被宿主拒（not allowed in card slots）。
  assert.equal(
    /hana\.clipboard/.test(code),
    false,
    "主卡是 card 槽位，不应再调剪贴板",
  );
  assert.match(code, /hana\.resources\.saveFile/, "主卡改用 resource.saveFile（白名单含 card）");
});

test("the card asks the backend to build the export instead of assembling it itself", async () => {
  // 图片在磁盘上、外链图要经宿主网络下载，这些只有后端做得了。
  // 页面只负责把字节交给 saveFile，不该自己拼内容。
  const panelJs = await readPanelJs();
  const body = panelJs.slice(
    panelJs.indexOf("async function saveCurrentView("),
    panelJs.indexOf("function safeSuggestedName("),
  );
  assert.match(body, /jobs\/\$\{selectedJob\.jobId\}\/export/, "应调后端导出接口");
  assert.match(body, /format: exportFormat/, "导出格式应随请求发出");
  assert.match(body, /hana\.resources\.saveFile/, "最终交给 saveFile");
  // 不能自己拿 preview.markdown 拼内容：那样图片全丢。
  assert.equal(/preview\?\.markdown/.test(body), false, "不应自己组装 markdown");
});

test("there is exactly one save control, and it lives in the title row", async () => {
  const html = await readPanelHtml();
  const js = stripJsComments(await readPanelJs());

  assert.equal(
    (js.match(/renderCtrl\('saveSlot'/g) || []).length,
    1,
    "另存按钮只应挂载一次",
  );
  // 位置：在 viewer-head 里（标题行右侧），而不是左栏或译文工具条。
  assert.match(
    html,
    /<header class="viewer-head">[\s\S]*id="saveSlot"[\s\S]*<\/header>/,
    "另存按钮必须在标题行内",
  );
  // 旧位置不得再留挂载位（连空 div 也不留，否则以后会被当成可用的插槽）。
  for (const gone of ["saveRefSlot", "translationRefSlot"]) {
    assert.equal(html.includes(gone), false, `${gone} 应已移除`);
  }
});

test("the single save button asks for whatever the current tab shows", async () => {
  // 全界面只留一个导出按钮，所以它必须按当前页签决定导出哪一份，
  // 否则译文就没地方导了。具体选哪份由后端按 translation 参数决定。
  const panelJs = await readPanelJs();
  const body = panelJs.slice(
    panelJs.indexOf("async function saveCurrentView("),
    panelJs.indexOf("function safeSuggestedName("),
  );
  assert.match(body, /activeTab === 'translation'/, "应判断当前是否在译文页签");
  assert.match(body, /params\.set\('translation', lang\)/, "译文页签应带上语言参数");
  assert.match(body, /exportFormat/, "应遵循下拉选的格式");
});

test("the title row keeps the save button from being squeezed out", async () => {
  // 标题可长可短，按钮不能被长文件名挤出去。
  const css = await readPanelCss();
  const headBlock = css.slice(css.indexOf(".viewer-head {"), css.indexOf(".viewer-head .meta"));
  assert.match(headBlock, /display:\s*flex/, "标题行是 flex 布局");
  assert.match(css, /\.viewer-title\s*\{[^}]*min-width:\s*0/s, "标题区必须 min-width:0 才肯收缩");
  assert.match(css, /\.viewer-actions\s*\{[^}]*flex:\s*none/s, "按钮不可缩");
});

test("there is an export format dropdown next to the save button", async () => {
  const html = await readPanelHtml();
  const js = stripJsComments(await readPanelJs());
  assert.match(js, /renderCtrl\('exportFormatSlot', 'Select'/, "格式应是一个官方 Select");
  assert.match(html, /id="exportFormatSlot"/, "页面里应有这个挂载位");
  // 两种格式都得在选项里，否则用户选不到。
  assert.match(js, /value: 'zip'/, "应有打包 zip 选项");
  assert.match(js, /value: 'inline'/, "应有单个 md 选项");
  // 两者必须在同一个容器里（标题行右侧的那组操作）。
  const actions = html.slice(html.indexOf('class="viewer-actions"'), html.indexOf("</header>"));
  assert.ok(actions.includes("exportFormatSlot") && actions.includes("saveSlot"), "下拉与按钮应在同一组");
});

test("export encodes UTF-8 safely and sanitizes the suggested name", async () => {
  // btoa 遇到非 ASCII 会抛错；中文文件名也不能带路径分隔符（宿主会拒）。
  const panelJs = await readPanelJs();
  assert.match(panelJs, /function bytesToBase64/, "应有字节→base64 的编码函数");
  assert.match(panelJs, /new TextEncoder\(\)\.encode/, "文本要先转 UTF-8 字节");
  assert.match(panelJs, /function safeSuggestedName/, "后端未回文件名时需自行净化");
  // zip 走二进制，不能当成文本读。
  assert.match(panelJs, /arrayBuffer\(\)/, "zip 应按二进制取字节");
});

test("the sidebar owns the clipboard instruction buttons", async () => {
  // 侧栏是 function-panel，白名单允许剪贴板；而且选中项本来就在侧栏手上。
  const sidebarJs = await readSidebarJs();
  const html = await readSidebarHtml();
  assert.match(stripJsComments(sidebarJs), /hana\.clipboard\.writeText/, "侧栏走剪贴板");
  assert.match(html, /id="copyRefSlot"/, "应有引用指令按钮位");
  assert.match(html, /id="copyTranslateSlot"/, "应有译文指令按钮位");
  assert.match(sidebarJs, /function renderSelectedActions/, "选中项操作区需有渲染函数");
});

test("the two instruction buttons are visually consistent", async () => {
  // 曾经的毛病：一个 secondary（灰底）一个 ghost（透明），看起来像“一个按钮 + 一条链接”。
  const js = stripJsComments(await readSidebarJs());
  const body = js.slice(
    js.indexOf("renderCtrl('copyRefSlot'"),
    js.indexOf("async function currentTargetLanguage("),
  );
  const variants = body.match(/variant:\s*'([a-z]+)'/g) || [];
  assert.equal(variants.length, 2, "应恰好两个按钮");
  assert.equal(new Set(variants).size, 1, `两个按钮应用同一个 variant，实际：${variants.join(', ')}`);
  // 两个都带悬停说明：标签缩短后，完整含义靠它补齐。
  assert.equal((body.match(/title:\s*'/g) || []).length, 2, "两个按钮都应有 title 提示");
});

test("the instruction buttons share the row and fill it", async () => {
  // 量过的两个坑：
  //   1. 官方按钮宽度按内容算，不填容器 → 槽变宽后按钮仍左对齐、右侧留白；
  //   2. 不限制最小宽度的话，flex 会把按钮压到比文字还窄。
  const css = await readSidebarCss();
  assert.match(css, /\.selected-buttons \.slot\s*\{[^}]*flex:\s*1 1 auto/s, "两个槽应平分行宽");
  assert.match(css, /\.selected-buttons \.slot\s*\{[^}]*min-width:\s*max-content/s, "槽不得窄于文字（否则被裁）");
  assert.match(css, /\.selected-buttons \.slot button\s*\{[^}]*width:\s*100%/s, "按钮要填满槽，否则右側留白");
});

test("the action block stays readable at the real panel width", async () => {
  // 面板实测约 190 CSS px（由用户截图推算）。标签过长会在这一档被挤成两行、
  // 格子不齐；所以按钮文案保持短，完整含义交给 title 与状态栏。
  const js = stripJsComments(await readSidebarJs());
  const labels = js.match(/children:\s*'复制[^']*'/g) || [];
  assert.equal(labels.length, 2, "应有两个复制按钮");
  for (const label of labels) {
    const text = label.replace(/children:\s*'/, '').replace(/'$/, '');
    assert.ok(text.length <= 4, `按钮文案应不超过 4 个字（实际 ${text.length}：「${text}」）`);
  }
});

test("a successful delete reports nothing, but a failed one still does", async () => {
  // 需求：侧栏不再显示「已删除「xxx」」。行已经从列表里消失，删除本身已是反馈，
  // 再报一遍只是重复。而且会把上一条操作结果（可能指向刚被删的记录）留在那里。
  const js = stripJsComments(await readSidebarJs());
  const body = js.slice(
    js.indexOf("async function deleteJobs("),
    js.indexOf("async function select("),
  );

  // 数调用次数比用正则去描述“哪一个分支”稳得多：
  // 整个 deleteJobs 里应当只剩一处通知（失败分支）。
  const calls = body.match(/notify\(/g) || [];
  assert.equal(calls.length, 1, `deleteJobs 里应只剩一处 notify，实际 ${calls.length} 处`);
  assert.match(body, /failed\.length/, "应区分成功与失败");
  assert.match(
    body,
    /notify\(`已删除[^`]*failed\[0\][^`]*`, 'error'\)/,
    "剩的那一处应是失败上报（且标为错误）",
  );
  // 成功路径不再通知。
  //（已确认全函数只剩一处 notify，且它在 if (failed.length) 里，
  // 所以“全部成功不提示”是结构上成立的，不必再单独断言。）
});

test("the sidebar hides its action block while batch-selecting", async () => {
  // 多选时人在挑“一批”，不是“一条”，指令按钮在那时是干扰。
  const sidebarJs = await readSidebarJs();
  const body = sidebarJs.slice(
    sidebarJs.indexOf("function renderSelectedActions("),
    sidebarJs.indexOf("async function currentTargetLanguage("),
  );
  assert.match(body, /selectMode \? null :/, "多选模式下就不该解析出选中项");
  assert.match(body, /host\.hidden = true/, "无选中项时整块隐藏");
});

// ── 固定置底的页脚 ──────────────────────────────────────────────────────
//
// 曾经的样子：操作区跟在列表后面，状态文字靠 `margin-top:auto` 单独被推到底，
// 两者之间在短列表时会空出一大段。现在两者同处一个 `flex:none` 的页脚，
// 列表负责吃掉剩余空间并自己滚动。

test("the sidebar keeps its action controls in one docked footer", async () => {
  const html = await readSidebarHtml();
  assert.match(html, /<footer class="foot"/, "应有页脚");

  // 两者必须都在页脚内，且顺序正确（选中操作 → 批量条）。
  const foot = html.slice(html.indexOf('<footer class="foot"'), html.indexOf("</footer>"));
  for (const id of ["selectedActions", "batchBar"]) {
    assert.ok(foot.includes(`id="${id}"`), `${id} 应在页脚内`);
  }
  assert.ok(
    foot.indexOf('id="selectedActions"') < foot.indexOf('id="batchBar"'),
    "顺序应为：选中操作 → 批量操作",
  );

  // 列表不得再出现在页脚里（它要在上面占满剩余空间）。
  assert.equal(/id="jobs"/.test(foot), false, "列表不该在页脚内");
  // 状态行已换成吐司，页脚里不应再有它。
  assert.equal(/id="status"/.test(foot), false, "页脚里不应再有状态行（已改吐司）");
});

test("the sidebar reports through host toasts, not a status line", async () => {
  // 需求：提示全部改吐司、几秒后消失。
  const html = await readSidebarHtml();
  const js = stripJsComments(await readSidebarJs());

  // 页面里不应再留状态行元素与相关样式。
  assert.equal(/id="status"/.test(html), false, "不应再有状态行元素");
  assert.equal(/showStatus|clearStatus/.test(js), false, "不应再有自绘状态函数");

  // 走宿主的 toast，并显式定 3s（宿主默认是 5s）。
  assert.match(js, /hana\.toast\.show\(/, "应用 hana.toast.show");
  assert.match(js, /duration:\s*TOAST_MS/, "应显式传时长");
  assert.match(js, /const TOAST_MS = 3000/, "时长应为 3000ms");

  // 类型只使用宿主允许的四个值。
  const types = js.match(/notify\([^;]*?'(success|error|info|warning)'\)/g) || [];
  assert.ok(types.length >= 6, `应有多个带类型的通知，实际 ${types.length}`);

  // 吐司失败不能反过来影响操作本身。
  assert.match(js, /\.catch\(/, "toast 失败应被接住");
});

test("selecting a row does not raise a toast, because the row already shows it", async () => {
  // 选中信息只在一处：选中项操作区。再弹吐司是重复。
  const js = stripJsComments(await readSidebarJs());
  const body = js.slice(
    js.indexOf("async function select("),
    js.indexOf("async function loadJobs("),
  );
  assert.equal(/notify\s*\(/.test(body), false, "选中时不应弹提示");
});

test("the list takes the leftover space and the footer never does", async () => {
  const css = await readSidebarCss();
  const listBlock = cssRule(css, ".list");
  const footBlock = cssRule(css, ".foot");

  assert.match(listBlock, /flex:\s*1 1 auto/, "列表要吃掉剩余空间");
  // 少了 min-height:0，flex 子项会拒绍收缩、把页脚顶出视野。
  assert.match(listBlock, /min-height:\s*0/, "列表必须 min-height:0 才能正确收缩");
  assert.match(footBlock, /flex:\s*none/, "页脚不参与伸缩");
});

test("the target language travels from the card to the sidebar through app storage", async () => {
  // 两个 iframe 不共享 JS：侧栏要生成“翻成某语言”的指令，语言选择器却在主卡上。
  const panelJs = await readPanelJs();
  const sidebarJs = await readSidebarJs();
  assert.match(panelJs, /STORAGE_TARGET_LANG/, "主卡应声明共享键");
  assert.match(panelJs, /function publishTargetLanguage/, "主卡应广播目标语言");
  assert.match(sidebarJs, /STORAGE_TARGET_LANG/, "侧栏应读同一个键");
  // 键名必须逐字一致，否则两边静默不连通。
  const keyIn = (js) => (js.match(/STORAGE_TARGET_LANG\s*=\s*'([^']+)'/) || [])[1];
  assert.equal(keyIn(panelJs), keyIn(sidebarJs), "两侧的存储键必须完全一致");
});

test("the card avoids window.confirm because the card sandbox has no allow-modals", async () => {
  const panelJs = await readPanelJs();
  assert.equal(/window\.confirm\s*\(/.test(panelJs), false, "删除确认必须是页内实现");
});

// ── 语言清单的单一事实来源 ──────────────────────────────────────────────────

test("the workbench page does not keep a second copy of the language list", async () => {
  // v1 的页面里有一份硬编码的 TARGET_LANGUAGES，需要一条测试盯着它别和 schema 漂移。
  // v2 的卡片改为从后端 /options 读取，单一事实来源在 lib/。
  const panelJs = await readPanelJs();
  assert.equal(
    /TARGET_LANGUAGES\s*=/.test(panelJs),
    false,
    "卡片不应该再维护第二份语言清单；语言从后端 /options 来",
  );
});

test("the backend hands the card a normalized language and the full list", async () => {
  const routeSource = await readJobRoutes();
  assert.match(routeSource, /languages:/, "/options 必须下发语言清单");
  // 配置里可能还存着 english / 简体中文 这类早期写法，归一化后页面才选得中
  assert.match(routeSource, /normalizeTargetLanguage/, "/options 必须归一化存下来的目标语言");
});

// ── 两个回归：主题变量兜底 与 右栏目标语言 ──────────────────────────────────

test("the app supplies fallbacks for the host theme variables", async () => {
  // 官方控件的样式中大量 var(--bg-card) / var(--accent) … 是不带兜底值的，
  // 而宿主主题样式表用 [data-theme="xxx"] 选择器、又不会跨进卡片 iframe。
  // 缺了这些值，下拉浮层这类没写兜底的地方会变成透明底、盖住正文。
  //
  // 兜底抽到了 theme-fallback.css，主卡与侧栏共用（两个页面都必须先引它）。
  const css = await fs.readFile(path.join(appDir, "ui", "assets", "theme-fallback.css"), "utf8");
  for (const name of ["--bg", "--bg-card", "--text", "--text-light", "--text-muted", "--border", "--accent", "--danger"]) {
    assert.match(
      css,
      new RegExp(`${name}\\s*:`),
      `theme-fallback.css 必须给 ${name} 一个兜底取值（官方控件会直接用，不写 fallback）`,
    );
  }
});

test("every app page loads the theme fallback before its own layout styles", async () => {
  // 顺序很重要：兜底必须在布局样式之前，宿主主题样式表进来后才能覆盖它。
  for (const page of ["panel.html", "sidebar.html"]) {
    const html = await fs.readFile(path.join(appDir, "ui", page), "utf8");
    const fallbackAt = html.indexOf("theme-fallback.css");
    assert.ok(fallbackAt > 0, `${page} 必须引入 theme-fallback.css`);
    const ownAt = html.indexOf(page === "panel.html" ? "panel.css" : "sidebar.css");
    assert.ok(ownAt > fallbackAt, `${page} 里 theme-fallback.css 必须排在自身布局样式之前`);
  }
});

test("the card applies the host theme attribute so a host theme can match", async () => {
  const panelJs = await readPanelJs();
  // 主题样式表是 [data-theme="xxx"] 选择器写的；SDK 只给标识、不写属性。
  assert.match(panelJs, /getSnapshot\(\)/, "应读 hana.theme.getSnapshot()");
  assert.match(panelJs, /dataset\.theme\s*=/, "应把主题标识写成 data-theme 属性，否则主题样式匹配不到");
  assert.match(panelJs, /theme\.subscribe/, "主题变化时应跟着更新");
});

test("the target language control is rendered into the right column", async () => {
  const panelJs = await readPanelJs();
  const html = await readPanelHtml();
  // 右栏有 translateLangSlot 这个挂载位，页面必须真的往里渲染东西，
  // 否则「目标语言」只剩一个标题、选择器是空的。
  assert.match(html, /id="translateLangSlot"/, "panel.html 里应有右栏目标语言挂载位");
  assert.match(
    panelJs,
    /renderCtrl\('translateLangSlot'/,
    "panel.js 必须真的把目标语言选择器渲染进 translateLangSlot",
  );
});
