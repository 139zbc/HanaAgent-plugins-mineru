const PROTOCOL = "hana.plugin.ui";
const VERSION = 1;
let seq = 0;
function targetOrigin() {
  const p = new URLSearchParams(location.search).get("hana-host-origin");
  if (p) return p;
  try { return new URL(document.referrer).origin; } catch { return "*"; }
}
function post(message) { parent.postMessage(message, targetOrigin()); }
function request(type, payload, timeoutMs = 10000) {
  const id = `mineru-${Date.now()}-${++seq}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { removeEventListener("message", onMessage); reject(new Error(`Host request timed out: ${type}`)); }, timeoutMs);
    function onMessage(event) {
      if (event.source !== parent || (targetOrigin() !== "*" && event.origin !== targetOrigin())) return;
      const message = event.data || {};
      if (message.protocol !== PROTOCOL || message.version !== VERSION || message.id !== id || message.type !== type) return;
      clearTimeout(timer); removeEventListener("message", onMessage);
      if (message.kind === "error") reject(new Error(message.error?.message || "Host request failed"));
      else resolve(message.payload);
    }
    addEventListener("message", onMessage);
    post({ protocol: PROTOCOL, version: VERSION, id, kind: "request", type, payload });
  });
}
// 允许的路径字符：字母/数字/斜杠/下划线/短横/点/百分号。
// 点号是必需的（结果图片的扩展名，如 .png）——曾因漏掉点号导致
// 图片请求被当成非法路径而拒绝。
// 百分号也是必需的：译文路径里有中文语言名（如 translated/%E4%B8%AD%E6%96%87），
// 曾因漏掉百分号导致「译文」页签报 Invalid API path。
// `..` 与编码后的 `%2e` / `%2f` / `%5c` 单独拦，不靠字符白名单。
function apiPath(path) {
  if (typeof path !== "string" || !/^[A-Za-z0-9/_.%\-]+$/.test(path) || path.includes("..")) throw new Error("Invalid API path");
  if (/%2e|%2f|%5c/i.test(path)) throw new Error("Invalid API path");
  const pluginId = location.pathname.match(/^\/api\/plugins\/([^/]+)\//)?.[1];
  if (!pluginId) throw new Error("Plugin page is not hosted by Hana");
  return `${location.origin}/api/plugins/${pluginId}/${path}`;
}

async function apiFetch(path, init) {
  const response = await apiFetchRaw(path, init);
  const body = await response.json();
  return body;
}
// 原样返回 Response，供需要二进制（结果图片）的场景使用。
// 关键：这类请求必须走本插件路由并带上 surface session，
// 裸 <img src> 请求不带凭据，会被宿主以 403 missing_credential 拒绝。
async function apiFetchRaw(path, init) {
  const surface = new URLSearchParams(location.search).get("pluginSurfaceSession");
  if (!surface) throw new Error("Plugin surface session unavailable");
  const headers = new Headers(init?.headers || {});
  headers.set("X-Hana-Plugin-Surface-Session", surface);
  const response = await fetch(apiPath(path), { ...init, headers });
  if (!response.ok) {
    let detail = `HTTP ${response.status}`;
    try { const body = await response.json(); if (body?.error) detail = body.error; } catch { /* 非 JSON 响应 */ }
    throw new Error(detail);
  }
  return response;
}
const pick = () => request("resource.pick", {});
const copy = (text) => request("clipboard.writeText", { text });
const root = document.getElementById("root");
const surface = root?.dataset.surface || "page";
let selected = null;
let selectedJob = null;
let currentJobs = [];
function showStatus(message, bad = false) {
  const el = document.getElementById("status");
  el.textContent = message;
  el.classList.toggle("error", bad);
}
function normalizePicked(value) {
  if (value?.resource) return value.resource;
  if (value?.ref) return value.ref;
  if (value?.kind) return value;
  if (Array.isArray(value?.resources)) return normalizePicked(value.resources[0]);
  throw new Error("文件选择器未返回 ResourceRef");
}
function renderShell() {
  root.innerHTML = `<main class="workbench">
    <aside class="history"><header><h2>解析历史</h2><button id="reload" type="button">刷新</button></header><ul id="jobs"></ul></aside>
    <section class="viewer"><header><h1>MinerU 文档工作台</h1><p id="fileTitle">选择历史记录查看结果</p><p id="fileMeta" class="file-meta"></p></header><div class="tabs"><button id="markdownTab" class="active" type="button">Markdown</button><button id="jsonTab" type="button">JSON</button><button id="translationTab" type="button">译文</button></div><div id="translationBar" class="translation-bar" hidden><select id="translationLang"></select><button id="translationRef" class="button ghost" type="button">复制译文获取指令</button><span id="translationMeta" class="hint"></span></div><div id="preview" class="markdown-body"><p class="preview-empty">暂无解析结果</p></div></section>
    <aside class="actions"><h2>新建解析</h2><button id="pick" type="button">选择文件</button><p id="selection">尚未选择文件</p><label class="field"><span>解析模式</span><select id="mode"></select></label><p id="modeHint" class="hint"></p><label class="check" id="ocrRow"><input id="ocr" type="checkbox">启用 OCR</label><button id="submit" type="button" disabled>开始解析</button><button id="refreshJob" type="button" disabled>查询选中任务</button><button id="copyRef" type="button" disabled>复制对话引用</button><h2>翻译选中文档</h2><div class="field"><span>目标语言</span><div class="lang-select" id="langSelect"><button id="langTrigger" class="lang-trigger" type="button" aria-haspopup="listbox" aria-expanded="false"><span class="lang-value" id="langValue">简体中文</span><span class="lang-caret" aria-hidden="true"></span></button><ul id="langMenu" class="lang-menu" role="listbox" aria-label="目标语言" hidden></ul></div></div><label class="field"><span>翻译模型</span><select id="translateModel"></select></label><button id="translateBtn" type="button" disabled>开始翻译</button><button id="translateCancel" type="button" hidden>取消翻译</button><p id="translateStatus" class="hint"></p><p class="hint">上传到 MinerU 后异步处理；完成时点击“查询选中任务”。引用按钮只复制提示，不会自行发送消息。</p><p id="status" role="status"></p></aside>
  </main>`;
  document.getElementById("reload").onclick = loadJobs;
  document.getElementById("mode").addEventListener("change", renderModeHint);
  document.getElementById("pick").onclick = async () => {
    try { const result = await pick(); selected = normalizePicked(result); document.getElementById("selection").textContent = selected.path?.split(/[\\/]/).pop() || selected.label || selected.fileId || "已选择文件"; document.getElementById("submit").disabled = false; showStatus("文件已选择"); }
    catch (error) { showStatus(error.message, true); }
  };
  document.getElementById("submit").onclick = submit;
  document.getElementById("refreshJob").onclick = refreshJob;
  document.getElementById("copyRef").onclick = async () => {
    if (!selectedJob) return;
    try { await copy(`请调用 mineru-document-workbench_reference_result，jobId=${selectedJob.jobId}，分析这份解析结果。`); showStatus("引用指令已复制，可粘贴到当前对话"); }
    catch (error) { showStatus(error.message, true); }
  };
  document.getElementById("markdownTab").onclick = () => showPreview("markdown");
  document.getElementById("jsonTab").onclick = () => showPreview("json");
  document.getElementById("translationTab").onclick = () => showPreview("translation");
  document.getElementById("translationLang").onchange = () => showPreview("translation");
  document.getElementById("translationRef").onclick = copyTranslationRef;
  document.getElementById("langTrigger").onclick = toggleLangMenu;
  document.getElementById("langMenu").addEventListener("keydown", onLangMenuKeydown);
  // 点击浮层外部收起下拉
  document.addEventListener("click", (event) => {
    const holder = document.getElementById("langSelect");
    if (holder && !holder.contains(event.target)) closeLangMenu();
  });
  setTargetLanguage(currentTargetLanguage());
  document.getElementById("translateBtn").onclick = startTranslation;
  document.getElementById("translateCancel").onclick = cancelTranslation;
}
let imageObserver = null;
function stopImageLoading() {
  if (imageObserver) { imageObserver.disconnect(); imageObserver = null; }
}
function missingNote(text) {
  const span = document.createElement("span");
  span.className = "md-image-missing";
  span.textContent = text;
  return span;
}
async function loadResultImage(img) {
  const path = img.dataset.assetPath;
  try {
    const response = await apiFetchRaw(path);
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    img.addEventListener("load", () => URL.revokeObjectURL(url), { once: true });
    img.src = url;
    img.classList.remove("md-img-pending");
  } catch (error) {
    img.replaceWith(missingNote(`（图片加载失败：${error.message}）`));
  }
}
/**
 * 结果图片必须通过插件路由带凭据获取（裸 <img> 会被拒绝）。
 *
 * 分两步，顺序很重要：
 *  1) detachImageSources：在插入文档前摘掉 src，避免浏览器发出注定 403 的请求；
 *  2) observeImages：节点**已经挂在真实容器里之后**才开始观察。
 *
 * 曾出现的问题：把 IntersectionObserver 的 root 设为游离的临时容器，
 * 而节点随后被移走，导致回调永不触发、图片卡在占位态。
 */
function detachImageSources(container) {
  const locals = [];
  for (const img of container.querySelectorAll("img")) {
    const src = img.getAttribute("src") || "";
    if (/^https?:\/\//i.test(src)) {
      // 白名单主机上的绝对地址：浏览器直连，失败时给出提示。
      img.addEventListener("error", () => img.replaceWith(missingNote(`（图片加载失败：${src}）`)), { once: true });
      continue;
    }
    img.removeAttribute("src");
    img.dataset.assetPath = src;
    img.classList.add("md-img-pending");
    locals.push(img);
  }
  return locals;
}

function observeImages(images, root) {
  stopImageLoading();
  if (!images.length) return;
  if (typeof IntersectionObserver !== "function") { for (const img of images) loadResultImage(img); return; }

  let loadedAny = false;
  const original = loadResultImage;
  const load = (img) => { loadedAny = true; return original(img); };

  imageObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      imageObserver?.unobserve(entry.target);
      load(entry.target);
    }
  }, { root, rootMargin: "240px" });
  for (const img of images) imageObserver.observe(img);

  // 兜底：观察器若因容器/布局原因不触发，至少保证有一次立即加载。
  // 已检查过图片总数场景（最多几十张），因此不会造成意外的批量请求。
  setTimeout(() => {
    if (loadedAny) return;
    for (const img of images) {
      if (img.isConnected && img.dataset.assetPath && !img.src) load(img);
    }
  }, 800);
}

let preview = null;
let translations = [];
const translationCache = new Map();
let translatePollTimer = null;

// ── 目标语言下拉 ──────────────────────────────────────────────────────────────
// 用自定义浮层而不是 <select>：需要「当前语言 + 展开列表打勾」这种形态，
// 而页面在 iframe 里，原生 select 展开时的系统浮层无法控制样式。
const TARGET_LANGUAGES = [
  "中文", "繁体中文", "英语", "日语", "韩语", "法语", "德语",
  "西班牙语", "葡萄牙语", "意大利语", "俄语", "阿拉伯语", "泰语", "越南语",
];
let targetLanguage = TARGET_LANGUAGES[0];

// 旧数据兼容：早期目标语言是文本输入框，可能存着英文语言名（例如 English）。
// 归一化到列表里的中文名，避免同一语言在菜单里出现两次。
const LANGUAGE_ALIASES = {
  chinese: "中文",
  "simplified chinese": "中文",
  "简体中文": "中文",
  "简体": "中文",
  繁体中文: "繁体中文",
  "traditional chinese": "繁体中文",
  english: "英语",
  en: "英语",
  japanese: "日语",
  ja: "日语",
  korean: "韩语",
  ko: "韩语",
  french: "法语",
  fr: "法语",
  german: "德语",
  de: "德语",
  spanish: "西班牙语",
  es: "西班牙语",
  portuguese: "葡萄牙语",
  pt: "葡萄牙语",
  italian: "意大利语",
  it: "意大利语",
  russian: "俄语",
  ru: "俄语",
  arabic: "阿拉伯语",
  ar: "阿拉伯语",
  thai: "泰语",
  th: "泰语",
  vietnamese: "越南语",
  vi: "越南语",
};

function normalizeLanguage(value) {
  const text = String(value ?? "").trim();
  if (!text) return "";
  return LANGUAGE_ALIASES[text.toLowerCase()] || text;
}

function currentTargetLanguage() {
  return targetLanguage || TARGET_LANGUAGES[0];
}

function closeLangMenu() {
  const menu = document.getElementById("langMenu");
  if (!menu || menu.hidden) return;
  menu.hidden = true;
  document.getElementById("langTrigger")?.setAttribute("aria-expanded", "false");
}

function toggleLangMenu() {
  const menu = document.getElementById("langMenu");
  if (!menu) return;
  if (menu.hidden) {
    menu.hidden = false;
    document.getElementById("langTrigger")?.setAttribute("aria-expanded", "true");
    menu.querySelector('[aria-selected="true"]')?.focus();
  } else {
    closeLangMenu();
  }
}

// 列表 = 常用语言 + 当前值（配置里可能存着旧值，例如「中文」，不能丢）。
function renderLangMenu() {
  const menu = document.getElementById("langMenu");
  if (!menu) return;
  const options = TARGET_LANGUAGES.includes(targetLanguage)
    ? TARGET_LANGUAGES
    : [targetLanguage, ...TARGET_LANGUAGES];
  menu.replaceChildren();
  for (const lang of options) {
    const item = document.createElement("li");
    item.className = "lang-option";
    item.setAttribute("role", "option");
    item.setAttribute("aria-selected", lang === targetLanguage ? "true" : "false");
    item.tabIndex = -1;
    item.dataset.lang = lang;
    const name = document.createElement("span");
    name.className = "lang-name";
    name.textContent = lang;
    const check = document.createElement("span");
    check.className = "lang-check";
    check.textContent = "✓";
    item.append(name, check);
    item.onclick = () => { setTargetLanguage(lang); closeLangMenu(); };
    menu.append(item);
  }
}

function setTargetLanguage(lang) {
  const value = normalizeLanguage(lang);
  if (!value) return;
  targetLanguage = value;
  const label = document.getElementById("langValue");
  if (label) label.textContent = value;
  renderLangMenu();
}

function onLangMenuKeydown(event) {
  const items = [...event.currentTarget.querySelectorAll(".lang-option")];
  const index = items.indexOf(document.activeElement);
  if (event.key === "Escape") {
    closeLangMenu();
    document.getElementById("langTrigger")?.focus();
    return;
  }
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    const step = event.key === "ArrowDown" ? 1 : -1;
    items[(index + step + items.length) % items.length]?.focus();
    return;
  }
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    if (index >= 0) {
      setTargetLanguage(items[index].dataset.lang);
      closeLangMenu();
      document.getElementById("langTrigger")?.focus();
    }
  }
}

function currentTranslationLang() {
  const select = document.getElementById("translationLang");
  return select?.value || null;
}
async function showPreview(kind) {
  const el = document.getElementById("preview");
  stopImageLoading();
  el.replaceChildren();
  // 翻译工具条只在「译文」页签显示，且要有可切换的译文才有意义。
  // 之前它一直显示：.translation-bar 自带 display:flex，盖过了浏览器默认的
  // [hidden]{display:none}。修法是在全局补一条 [hidden]{display:none!important}。
  const bar = document.getElementById("translationBar");
  if (bar) bar.hidden = kind !== "translation" || !translations.length;
  for (const [id, tab] of [["markdownTab", "markdown"], ["jsonTab", "json"], ["translationTab", "translation"]]) {
    document.getElementById(id)?.classList.toggle("active", tab === kind);
  }

  if (kind === "json") {
    const pre = document.createElement("pre");
    pre.className = "json-view";
    pre.textContent = preview?.json ?? (preview?.jsonAvailable === false
      ? "该解析方式仅返回 Markdown，没有 JSON 结果（Agent 轻量解析 API 的限制）。"
      : "暂无 JSON 结果");
    el.append(pre);
    return;
  }

  if (kind === "translation") {
    if (!translations.length) {
      const hint = document.createElement("p");
      hint.className = "preview-empty";
      hint.textContent = "还没有译文。在右侧选择目标语言与模型后点击「开始翻译」。";
      el.append(hint);
      return;
    }
    const lang = currentTranslationLang() || translations[0].lang;
    const key = `${selectedJob?.jobId}|${lang}`;
    try {
      let data = translationCache.get(key);
      if (!data) {
        data = await apiFetch(`jobs/${selectedJob.jobId}/translation/${encodeURIComponent(lang)}`);
        translationCache.set(key, data);
      }
      const holder = document.createElement("div");
      holder.innerHTML = data.markdownHtml || "";
      const localImages = detachImageSources(holder);
      el.append(...holder.childNodes);
      observeImages(localImages, el);
      const meta = document.getElementById("translationMeta");
      if (meta) {
        const bits = [];
        if (data.modelLabel) bits.push(data.modelLabel);
        if (data.failedChunks) bits.push(`${data.failedChunks} 个片段保留原文`);
        meta.textContent = bits.join(" · ");
      }
      const refButton = document.getElementById("translationRef");
      if (refButton) refButton.hidden = false;
    } catch (error) {
      const hint = document.createElement("p");
      hint.className = "preview-empty";
      hint.textContent = error.message;
      el.append(hint);
    }
    return;
  }

  if (preview?.markdownHtml) {
    // markdownHtml 由服务端渲染并经过白名单净化。
    // 先摘 src（避免发出注定 403 的裸图片请求），插入真实容器后再观察加载。
    const holder = document.createElement("div");
    holder.innerHTML = preview.markdownHtml;
    const localImages = detachImageSources(holder);
    el.append(...holder.childNodes);
    observeImages(localImages, el);
    return;
  }
  if (preview?.markdown) { const pre = document.createElement("pre"); pre.textContent = preview.markdown; el.append(pre); return; }
  const hint = document.createElement("p");
  hint.className = "preview-empty";
  hint.textContent = preview?.state === "done" ? "该任务没有可预览的解析内容。" : "暂无解析结果";
  el.append(hint);
}
async function loadJobs() {
  try {
    currentJobs = (await apiFetch("jobs")).jobs;
    const list = document.getElementById("jobs"); list.replaceChildren();
    if (!currentJobs.length) { const li = document.createElement("li"); li.textContent = "还没有解析记录"; list.append(li); return; }
    for (const job of currentJobs) list.append(historyItem(job));
  } catch (error) { showStatus(error.message, true); }
}
function formatBytes(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}
function historyItem(job) {
  const li = document.createElement("li");
  li.className = "job-row";

  const open = document.createElement("button");
  open.type = "button";
  open.className = "job-open";
  const line1 = document.createElement("span"); line1.className = "job-name"; line1.textContent = job.fileName;
  const line2 = document.createElement("span"); line2.className = "job-meta"; line2.textContent = jobMetaText(job);
  open.append(line1, line2);
  open.onclick = () => selectJob(job);

  const del = document.createElement("button");
  del.type = "button";
  del.className = "job-delete";
  del.title = "删除这条记录（含解析结果）";
  del.setAttribute("aria-label", `删除 ${job.fileName}`);
  del.textContent = "×";
  del.onclick = (event) => { event.stopPropagation(); askDelete(job, li); };

  li.append(open, del);
  return li;
}
/**
 * 删除需二次确认。iframe 的 sandbox 不含 allow-modals，window.confirm 不可用，
 * 所以确认界面在页内实现。
 */
async function askDelete(job, li) {
  const inProgress = IN_PROGRESS.has(job.state);
  let detail = "将一并删除记录与该任务的解析结果文件。";
  try {
    const info = await apiFetch(`jobs/${job.jobId}/deletion-preview`);
    if (info.hasResults) detail = `将一并删除记录与解析结果文件（约 ${formatBytes(info.totalBytes)}）。`;
  } catch { /* 预览失败不阻止删除，用默认说明 */ }

  li.classList.add("confirming");
  li.replaceChildren();
  const box = document.createElement("div");
  box.className = "job-confirm";
  const text = document.createElement("p");
  text.className = "job-confirm-text";
  text.textContent = inProgress
    ? `删除「${job.fileName}」？该任务仍在进行中，删除后无法再查询进度；远程任务不会被中止。${detail}`
    : `删除「${job.fileName}」？${detail}`;

  const yes = document.createElement("button");
  yes.type = "button"; yes.className = "danger"; yes.textContent = "删除";
  const no = document.createElement("button");
  no.type = "button"; no.textContent = "取消";
  no.onclick = () => loadJobs();
  yes.onclick = async () => {
    yes.disabled = true; no.disabled = true;
    try {
      await apiFetch(`jobs/${job.jobId}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ force: inProgress }),
      });
      if (selectedJob?.jobId === job.jobId) clearSelection();
      showStatus(`已删除「${job.fileName}」`);
      await loadJobs();
    } catch (error) {
      showStatus(error.message, true);
      await loadJobs();
    }
  };
  box.append(text, yes, no);
  li.append(box);
}
function clearSelection() {
  selectedJob = null;
  stopAutoPoll();
  document.getElementById("fileTitle").textContent = "选择历史记录查看结果";
  document.getElementById("fileMeta").textContent = "";
  document.getElementById("refreshJob").disabled = true;
  document.getElementById("copyRef").disabled = true;
  preview = null;
  showPreview("markdown");
}
const IN_PROGRESS = new Set(["pending", "running", "converting", "uploading", "waiting-file", "submitting"]);
function elapsedText(job) {
  if (!job?.createdAt) return "";
  const ms = Date.now() - Date.parse(job.createdAt);
  if (!Number.isFinite(ms) || ms < 0) return "";
  const minutes = Math.round(ms / 60000);
  if (minutes < 1) return "刚刚提交";
  if (minutes < 60) return `已等待 ${minutes} 分钟`;
  return `已等待 ${(minutes / 60).toFixed(1)} 小时`;
}
function queueText(job) {
  const q = job?.progress?.queue;
  if (!q) return "";
  const parts = [`排在第 ${q.position} 位`];
  if (q.ahead !== null && q.ahead !== undefined) parts.push(`前方 ${q.ahead} 个任务`);
  return parts.join("，");
}
function pageText(job) {
  const p = job?.progress;
  if (!p?.totalPages) return "";
  return `解析进度 ${p.extractedPages ?? 0}/${p.totalPages} 页`;
}
function jobMetaText(job) {
  const label = job.stateLabel || job.state;
  const parts = [];
  if (job.modeLabel) parts.push(job.modeLabel);
  parts.push(label);
  if (IN_PROGRESS.has(job.state)) {
    const elapsed = elapsedText(job); if (elapsed) parts.push(elapsed);
    const queue = queueText(job); if (queue) parts.push(queue);
    const pages = pageText(job); if (pages) parts.push(pages);
  } else if (job.error) {
    parts.push(job.error);
  } else if (job.hasMarkdown) {
    parts.push(job.jsonCount ? `${job.jsonCount} 个 JSON` : "仅 Markdown");
  }
  return parts.join(" · ");
}
async function selectJob(job) {
  selectedJob = job;
  document.getElementById("fileTitle").textContent = `${job.fileName} · ${job.stateLabel || job.state}`;
  document.getElementById("fileMeta").textContent = jobMetaText(job);
  document.getElementById("refreshJob").disabled = !job.batchId || job.state === "done";
  document.getElementById("copyRef").disabled = job.state !== "done";
  document.getElementById("translateBtn").disabled = job.state !== "done";
  preview = null; showPreview("markdown");
  try { preview = await apiFetch(`jobs/${job.jobId}`); showPreview("markdown"); }
  catch (error) { showStatus(error.message, true); }
  await loadTranslations(job);
  startAutoPoll(job);
}

// ── 翻译 ──────────────────────────────────────────────────────────────────────

async function loadTranslations(job) {
  const select = document.getElementById("translationLang");
  translations = [];
  select.replaceChildren();
  document.getElementById("translationRef").hidden = true;
  document.getElementById("translationMeta").textContent = "";
  if (!job) return;
  try {
    const state = await apiFetch(`jobs/${job.jobId}/translate`);
    translations = state.translations || [];
    for (const item of translations) {
      const option = document.createElement("option");
      option.value = item.lang;
      option.textContent = item.lang;
      select.append(option);
    }
    if (translations.length) document.getElementById("translationRef").hidden = false;
    if (state.state === "running") { setTranslateStatus(state); startTranslatePoll(); }
  } catch { /* 无译文时保持空列表 */ }
}

// 页面在沙箱 iframe 里（无 allow-downloads），下载会被静默拦掉。
// 与「复制对话引用」一致：只往剪贴板放一句提示，由对话里的助手真正交付译文文件。
async function copyTranslationRef() {
  if (!selectedJob) return;
  const lang = currentTranslationLang() || currentTargetLanguage();
  if (!lang) { showStatus("请先选择目标语言", true); return; }
  const text = `请用 MinerU 文档解析插件把已解析任务「${selectedJob.fileName || selectedJob.jobId}」（jobId: ${selectedJob.jobId}）的解析结果翻译为${lang}，并把译文 Markdown 作为附件交付给我。`;
  try { await copy(text); showStatus("已复制译文获取指令，粘贴到对话里即可拿到译文文件"); }
  catch (error) { showStatus(error.message, true); }
}

function setTranslateStatus(state) {
  const el = document.getElementById("translateStatus");
  const cancel = document.getElementById("translateCancel");
  if (state.state === "running") {
    el.textContent = `正在翻译：${state.done || 0}/${state.total || "?"} 片语`;
    cancel.hidden = false;
    return;
  }
  cancel.hidden = true;
  if (state.state === "done") el.textContent = `翻译完成（${state.total} 片语）`;
  else if (state.state === "done_with_errors") el.textContent = `翻译完成，${(state.failures || []).length} 个片段保留原文`;
  else if (state.state === "cancelled") el.textContent = "翻译已取消";
  else if (state.state === "failed") el.textContent = `翻译失败：${state.error || "未知错误"}`;
  else el.textContent = "";
}

function startTranslatePoll() {
  stopTranslatePoll();
  const jobId = selectedJob?.jobId;
  if (!jobId) return;
  translatePollTimer = setTimeout(async () => {
    if (selectedJob?.jobId !== jobId) return;
    try {
      const state = await apiFetch(`jobs/${jobId}/translate`);
      if (selectedJob?.jobId !== jobId) return;
      setTranslateStatus(state);
      if (state.state === "running") { startTranslatePoll(); return; }
      translationCache.clear();
      await loadTranslations(selectedJob);
      showPreview("translation");
    } catch (error) {
      document.getElementById("translateStatus").textContent = error.message;
    }
  }, 2500);
}
function stopTranslatePoll() {
  if (translatePollTimer) { clearTimeout(translatePollTimer); translatePollTimer = null; }
}

async function startTranslation() {
  if (!selectedJob) return;
  const language = currentTargetLanguage();
  if (!language) { showStatus("请选择目标语言", true); return; }
  const value = document.getElementById("translateModel").value;
  let model = null;
  if (value) { try { model = JSON.parse(value); } catch { model = null; } }
  const button = document.getElementById("translateBtn");
  button.disabled = true;
  try {
    await apiFetch(`jobs/${selectedJob.jobId}/translate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ targetLanguage: language, model }),
    });
    document.getElementById("translateStatus").textContent = "已开始翻译…";
    document.getElementById("translateCancel").hidden = false;
    startTranslatePoll();
  } catch (error) {
    showStatus(error.message, true);
  } finally {
    button.disabled = selectedJob?.state !== "done";
  }
}

async function cancelTranslation() {
  if (!selectedJob) return;
  try {
    await apiFetch(`jobs/${selectedJob.jobId}/translate/cancel`, { method: "POST" });
    document.getElementById("translateStatus").textContent = "正在取消…";
  } catch (error) { showStatus(error.message, true); }
}

async function submit() {
  if (!selected) return;
  const button = document.getElementById("submit"); button.disabled = true; showStatus("正在提交到 MinerU…");
  try {
    const fileName = document.getElementById("selection").textContent;
    const job = await apiFetch("jobs", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ source: selected, fileName, isOcr: document.getElementById("ocr").checked, modelVersion: document.getElementById("mode").value }) });
    const modeLabel = job.modeLabel ? `${job.modeLabel} · ` : "";
    const jsonNote = job.modelVersion === "agent" ? "（仅 Markdown）" : "";
    showStatus(`已提交（${modeLabel}${job.stateLabel || job.state}）${jsonNote}，稍后查询状态`); await loadJobs();
  } catch (error) { showStatus(error.message, true); }
  finally { button.disabled = false; }
}
let parseModes = [];
let credentialConfigured = true;
let chatModels = [];

async function loadTranslationModels() {
  const select = document.getElementById("translateModel");
  try {
    const data = await apiFetch("translation-models");
    chatModels = data.models || [];
    select.replaceChildren();
    const auto = document.createElement("option");
    auto.value = "";
    auto.textContent = "默认（用当前 agent 的实用模型）";
    select.append(auto);
    for (const model of chatModels) {
      const option = document.createElement("option");
      option.value = JSON.stringify({ id: model.id, provider: model.provider, name: model.name });
      option.textContent = model.label || model.id;
      select.append(option);
    }
    if (data.current?.id) {
      const match = [...select.options].find((option) => {
        try { return JSON.parse(option.value).id === data.current.id; } catch { return false; }
      });
      if (match) select.value = match.value;
    }
    if (!chatModels.length) {
      const option = document.createElement("option");
      option.value = "";
      option.textContent = data.error ? `无法读取模型列表：${data.error}` : "没有已配置的聊天模型";
      select.replaceChildren(option);
    }
  } catch (error) {
    select.replaceChildren();
    const option = document.createElement("option");
    option.value = "";
    option.textContent = `无法读取模型列表：${error.message}`;
    select.append(option);
  }
  // 默认目标语言取插件配置，失败则保持页面默认值
  try {
    const options = await apiFetch("options");
    if (typeof options.defaultTargetLanguage === "string" && options.defaultTargetLanguage.trim()) {
      setTargetLanguage(options.defaultTargetLanguage.trim());
    }
  } catch { /* 保持默认 */ }
}

async function loadOptions() {
  const select = document.getElementById("mode");
  try {
    const options = await apiFetch("options");
    parseModes = options.modes || [];
    credentialConfigured = options.configured !== false;
    select.replaceChildren();
    for (const mode of parseModes) {
      const option = document.createElement("option");
      option.value = mode.id; option.textContent = mode.label;
      select.append(option);
    }
    select.value = options.current || options.default || parseModes[0]?.id || "vlm";
    renderModeHint();
  } catch (error) {
    // 拿不到模式列表时仍然可用：退回两个内置选项。
    select.replaceChildren();
    for (const [id, label] of [["vlm", "MinerU VLM"], ["pipeline", "MinerU"], ["agent", "Agent 轻量解析 API（免 Token）"]]) {
      const option = document.createElement("option");
      option.value = id; option.textContent = label;
      select.append(option);
    }
    select.value = "vlm";
    renderModeHint();
  }
}
function renderModeHint() {
  const selected = document.getElementById("mode").value;
  const mode = parseModes.find((item) => item.id === selected);
  const hint = document.getElementById("modeHint");
  if (hint) hint.textContent = mode?.hint || "";
  // 轻量通道无需 Token；这里提示当前是否已配置，避免用户误以为报错是 Key 问题。
  const submit = document.getElementById("submit");
  if (submit) {
    const needsToken = mode ? mode.requiresToken !== false : true;
    submit.title = needsToken ? "需要 MinerU API Token" : "免 Token，无需配置 API Key";
  }
  const ocrRow = document.getElementById("ocrRow");
  if (ocrRow) ocrRow.title = "OCR 仅对 PDF 生效";
}
async function refreshJob() {
  if (!selectedJob) return;
  try {
    const result = await apiFetch(`jobs/${selectedJob.jobId}/refresh`, { method: "POST" });
    const bits = [result.error ? "刷新失败" : `状态：${result.stateLabel || result.state}`];
    if (result.progress?.totalPages) bits.push(`解析进度 ${result.progress.extractedPages ?? 0}/${result.progress.totalPages} 页`);
    if (result.progress?.queue) bits.push(`排在第 ${result.progress.queue.position} 位`);
    showStatus(bits.join(" · "), Boolean(result.error));
    await loadJobs(); const next = currentJobs.find((job) => job.jobId === selectedJob.jobId); if (next) await selectJob(next);
  } catch (error) { showStatus(error.message, true); }
}
let pollTimer = null;
function stopAutoPoll() { if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; } }
function startAutoPoll(job) {
  stopAutoPoll();
  if (!job?.batchId || !IN_PROGRESS.has(job.state)) return;
  const jobId = job.jobId;
  pollTimer = setTimeout(async () => {
    if (selectedJob?.jobId !== jobId) return;
    try {
      const result = await apiFetch(`jobs/${jobId}/refresh`, { method: "POST" });
      if (selectedJob?.jobId !== jobId) return;
      await loadJobs();
      const next = currentJobs.find((item) => item.jobId === jobId);
      if (next) { selectedJob = next; document.getElementById("fileTitle").textContent = `${next.fileName} · ${next.stateLabel || next.state}`; document.getElementById("fileMeta").textContent = jobMetaText(next); document.getElementById("refreshJob").disabled = !next.batchId || next.state === "done"; document.getElementById("copyRef").disabled = next.state !== "done"; startAutoPoll(next); }
      if (result.error) showStatus(result.error, true);
      else if (result.state !== "pending") showStatus(`状态：${result.stateLabel || result.state}`);
    } catch { /* transient; the manual refresh button remains available */ setTimeout(() => startAutoPoll(selectedJob), 30000); }
  }, 20000);
}
renderShell();
function signalReady() {
  post({ protocol: PROTOCOL, version: VERSION, kind: "event", type: "hana.ready", payload: {} });
  // Some Hana desktop builds still listen for the original iframe handshake.
  parent.postMessage({ type: "ready" }, targetOrigin());
}
signalReady();
setTimeout(signalReady, 200);
setTimeout(signalReady, 500);
post({ protocol: PROTOCOL, version: VERSION, kind: "event", type: "ui.resize", payload: { height: surface === "widget" ? 580 : 760 } });
loadOptions();
loadTranslationModels();
loadJobs();
