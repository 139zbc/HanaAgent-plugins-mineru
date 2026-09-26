/*
 * MinerU 工作台 —— v2 主卡（官方控件）
 * ====================================
 *
 * 职责：**只做「查看与操作」**。解析历史在宿主的功能面板（sidebar.js），
 * 那里负责「挑选」；选中态由侧栏经 App 存储广播过来。
 *
 * 界面外壳用官方 App UI 控件（按钮 / 下拉 / 页签 / 状态），
 * 两栏布局由 panel.css 决定。
 *
 * 与 v1 手写面板的对应关系（v1 源码保留在 reference/v1-panel/）：
 *   页面向宿主发消息的私有协议  → hana.* 浏览器 SDK
 *   文件选择                  → hana.resources.pick
 *   结果另存为 .md            → hana.resources.saveFile
 *   自定义语言浮层              → 官方 Select（宿主自己的选择器）
 *   手写 tab / 按钮 / 输入框    → 官方 Tabs / Button / Checkbox
 *   手拼插件路由 + 回传会话凭据 → hana.api.fetch（自动带凭据）
 *
 * 预览区（#preview）刻意不走官方控件：里面是服务端渲染并白名单净化过的
 * 文档 HTML，属于内容而非界面。
 *
 * 关于「复制指令」：v1 的两个复制按钮已移到侧栏。不是版面调整，
 * 是宿主按槽位划的硬边界：clipboard.writeText 白名单不含 card。
 * 详见 MIGRATION.md 第六节。
 */

import { hana } from './sdk.js';
import { mountAppUi } from './app-ui.js';

const $ = (id) => document.getElementById(id);

// ── 状态 ────────────────────────────────────────────────────────────────────
let selectedSource = null;      // 已选中待解析的文件（ResourceRef）—— 详见下方「点 / 拖 / 贴」一节
let selectedJobId = null;       // 侧栏广播过来的选中任务 id
let selectedJob = null;         // 该 id 对应的任务对象
let currentJobs = [];           // 最近一次拉取的列表（用来把 id 映射成任务）
let parseModes = [];
let languages = [];
let targetLanguage = '';
let modelOptions = [];          // [{ value, label }]
let activeTab = 'markdown';
let submitting = false;
let translating = false;

/**
 * 导出格式。用户在标题栏的下拉里选，存在页面状态里（不持久化）。
 *   zip    → md + images/ 打包（保目录关系，体积不变）
 *   inline → 图片内联进 md（单文件，体积约 +33%）
 * 区别与取舍见 lib/export-bundle.v1.js 头部。
 */
let exportFormat = 'zip';
/** 正在导出（可能要等外链图下载），用来给按钮上忙碌态。 */
let exporting = false;
let preview = null;
const translations = [];
// 中栏译文工具条正在查看哪一份译文。它与右栏的「目标语言」是两件事：
// 一个决定下次翻成什么，一个决定当前显示哪份（v1 也是两个控件）。
let viewTranslationLang = '';
const translationCache = new Map();
let autoPollTimer = null;
let translatePollTimer = null;
let imageObserver = null;

const IN_PROGRESS = new Set(['pending', 'running', 'converting', 'uploading', 'waiting-file', 'submitting']);

/**
 * 与侧栏约定的存储键。
 * 侧栏（功能面板）与主卡是两个独立 iframe，**不共享 JS 对象**，
 * 所以历史列表与选中态的通信只能走 App 存储。
 */
const STORAGE_SELECTED = 'ui.selectedJobId';
const STORAGE_REVISION = 'ui.jobsRevision';
// 当前目标语言也得广播给侧栏：侧栏要生成「翻成某语言」的指令，
// 而语言选择器在主卡上（侧栏读不到本页的 JS 变量）。
const STORAGE_TARGET_LANG = 'ui.targetLanguage';

/**
 * 从 App 存储读一个值，并**拆掉包装**。
 *
 * 实测坑：`hana.storage.global.get(key)` 返回的不是裸值，而是一个包装对象
 * （与宿主 v1 存储版的 `{ key, value }` 同形）。直接 `typeof x === 'string'`
 * 会永远判假——现象就是“事件收到了、get 也没报错，但选中态始终是 null”。
 *
 * 这里三种形状都认：裸值、`{ value }`、以及再包一层的情况。
 */
async function readStored(key) {
  const raw = await hana.storage.global.get(key);
  return unwrapStored(raw);
}

function unwrapStored(raw) {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== 'object') return raw;
  // { value } 是最常见的包装；若那一层还是对象再拆一次（防御）。
  if ('value' in raw) {
    const inner = raw.value;
    if (inner !== null && typeof inner === 'object' && 'value' in inner && !Array.isArray(inner)) {
      return inner.value ?? null;
    }
    return inner ?? null;
  }
  return raw;
}

// ── 官方控件的挂载辅助 ───────────────────────────────────────────────────────

/**
 * 每个 slot 记住自己挂的是哪个控件：控件类型没变就 update（保住焦点与动画），
 * 变了才销毁重建。直接重建会让按钮在频繁状态更新时闪。
 */
const ctrlRegistry = new Map();

function renderCtrl(hostId, control, props) {
  const entry = ctrlRegistry.get(hostId);
  if (entry && entry.control === control) {
    entry.handle.update(props);
    return entry.handle;
  }
  if (entry) {
    try { entry.handle.destroy(); } catch { /* 已销毁 */ }
    ctrlRegistry.delete(hostId);
  }
  const host = $(hostId);
  if (!host) return null;
  host.replaceChildren();
  const el = document.createElement('div');
  el.className = 'ui-slot';
  host.appendChild(el);
  const handle = mountAppUi(el, control, props);
  ctrlRegistry.set(hostId, { control, handle });
  return handle;
}

function clearSlot(hostId) {
  const entry = ctrlRegistry.get(hostId);
  if (entry) {
    try { entry.handle.destroy(); } catch { /* 已销毁 */ }
    ctrlRegistry.delete(hostId);
  }
  const host = $(hostId);
  if (host) host.replaceChildren();
}

function setSlotHidden(hostId, hidden) {
  const host = $(hostId);
  if (host) host.hidden = Boolean(hidden);
}

// ── 宿主主题 ────────────────────────────────────────────────────────────────

/**
 * 跟随宿主主题。
 *
 * 背景：官方控件的样式依赖一套宿主主题变量，而主题样式表是按
 * `[data-theme="xxx"]` 选择器写的。SDK 会把主题标识告诉页面
 * （hana.theme.getSnapshot().theme），但不会把它写成属性；
 * 属性没人设，主题样式即使注入进来也匹配不到任何元素。
 *
 * 这里补上这个属性，让宿主主题真正生效；panel.css 里的兜底取值
 * 只是底线（见该文件的说明）。
 */
function applyThemeAttribute(snapshot) {
  const id = typeof snapshot?.theme === 'string' ? snapshot.theme.trim() : '';
  if (id) document.documentElement.dataset.theme = id;
}

const THEME_STYLE_ATTR = 'data-hana-theme-style';

/**
 * 把宿主主题样式表注入本卡片。
 *
 * SDK 只在收到「主题变更」事件时才会去做这件事，初次加载不做；
 * 但快照里其实已经带着 cssUrl（来自 iframe 的 hana-css 参数），
 * 所以这里自己补一次。用了与 SDK 同一个 style 属性，不会重复注入。
 */
async function applyHostThemeCss(cssUrl) {
  if (typeof cssUrl !== 'string' || !cssUrl) return;
  try {
    const response = await fetch(cssUrl, { credentials: 'same-origin' });
    if (!response.ok) return;
    const css = await response.text();
    let el = document.querySelector(`style[${THEME_STYLE_ATTR}]`);
    if (!el) {
      el = document.createElement('style');
      el.setAttribute(THEME_STYLE_ATTR, '');
      document.head.appendChild(el);
    }
    el.textContent = css;
  } catch {
    // 主题样式表拿不到不是致命错误：panel.css 里有兜底取值。
  }
}

function followHostTheme() {
  try {
    const snapshot = hana.theme.getSnapshot();
    applyThemeAttribute(snapshot);
    void applyHostThemeCss(snapshot?.cssUrl);
    hana.theme.subscribe((next) => {
      applyThemeAttribute(next);
      void applyHostThemeCss(next?.cssUrl);
    });
  } catch {
    // 主题不可用时保持 panel.css 的兜底外观。
  }
}

// ── 后端调用 ────────────────────────────────────────────────────────────────

/**
 * hana.api.fetch 只对本 App 自己的路由（/api/apps/<appId>/routes/）带凭据。
 * 错误形状兼容宿主 { error, code } 与 App 自己的 { error }。
 */
async function api(path, init) {
  const response = await hana.api.fetch(path, init);
  let body = null;
  try { body = await response.json(); } catch { /* 空响应或非 JSON */ }
  if (!response.ok) {
    throw new Error(body?.error || body?.message || `HTTP ${response.status}`);
  }
  return body ?? {};
}

async function apiRaw(path, init) {
  const response = await hana.api.fetch(path, init);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response;
}

const jsonInit = (method, payload) => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(payload),
});

// ── 状态提示 ────────────────────────────────────────────────────────────────

function showStatus(message, bad = false) {
  const el = $('status');
  if (!el) return;
  el.textContent = message;
  el.classList.toggle('error', bad);
}

function clearStatus() {
  const el = $('status');
  if (el) { el.textContent = ''; el.classList.remove('error'); }
}

// ── 结果图片 ────────────────────────────────────────────────────────────────

function stopImageLoading() {
  if (imageObserver) { imageObserver.disconnect(); imageObserver = null; }
}

function missingNote(text) {
  const span = document.createElement('span');
  span.className = 'md-image-missing';
  span.textContent = text;
  return span;
}

/**
 * 结果图片位于本 App 的后端路由（jobs/<id>/asset/<相对路径>），
 * 不是 ui/ 包内静态资源，所以 <img src> 拿不到凭据。走 hana.api.fetch
 * 取字节再转 blob: URL。
 */
async function loadResultImage(img) {
  const path = img.dataset.assetPath;
  try {
    const response = await apiRaw(path);
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    img.addEventListener('load', () => URL.revokeObjectURL(url), { once: true });
    img.src = url;
    img.classList.remove('md-img-pending');
  } catch (error) {
    img.replaceWith(missingNote(`（图片加载失败：${error?.message || error}）`));
  }
}

/**
 * 分两步，顺序很重要：
 *  1) detachImageSources：插入文档前摘掉 src，避免浏览器发出注定被拒的请求；
 *  2) observeImages：节点**已经挂在真实容器里之后**才开始观察。
 * 曾出现的问题是把 IntersectionObserver 的 root 设为游离容器，节点随后被移走，
 * 回调永不触发、图片卡在占位态。
 */
function detachImageSources(container) {
  const locals = [];
  for (const img of container.querySelectorAll('img')) {
    const src = img.getAttribute('src') || '';
    if (/^https?:\/\//i.test(src)) {
      // 白名单主机上的绝对地址：浏览器直连，失败时给出提示。
      img.addEventListener('error', () => img.replaceWith(missingNote(`（图片加载失败：${src}）`)), { once: true });
      continue;
    }
    img.removeAttribute('src');
    img.dataset.assetPath = src;
    img.classList.add('md-img-pending');
    locals.push(img);
  }
  return locals;
}

function observeImages(images, root) {
  stopImageLoading();
  if (!images.length) return;
  if (typeof IntersectionObserver !== 'function') {
    for (const img of images) loadResultImage(img);
    return;
  }

  let loadedAny = false;
  const load = (img) => { loadedAny = true; return loadResultImage(img); };

  imageObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      imageObserver?.unobserve(entry.target);
      load(entry.target);
    }
  }, { root, rootMargin: '240px' });
  for (const img of images) imageObserver.observe(img);

  // 兜底：观察器若因容器/布局原因不触发，至少保证一次立即加载。
  setTimeout(() => {
    if (loadedAny) return;
    for (const img of images) {
      if (img.isConnected && img.dataset.assetPath && !img.src) load(img);
    }
  }, 800);
}

// ── 任务文案 ────────────────────────────────────────────────────────────────

function elapsedText(job) {
  if (!job?.createdAt) return '';
  const ms = Date.now() - Date.parse(job.createdAt);
  if (!Number.isFinite(ms) || ms < 0) return '';
  const minutes = Math.round(ms / 60000);
  if (minutes < 1) return '刚刚提交';
  if (minutes < 60) return `已等待 ${minutes} 分钟`;
  return `已等待 ${(minutes / 60).toFixed(1)} 小时`;
}

function queueText(job) {
  const q = job?.progress?.queue;
  if (!q) return '';
  const parts = [`排在第 ${q.position} 位`];
  if (q.ahead !== null && q.ahead !== undefined) parts.push(`前方 ${q.ahead} 个任务`);
  return parts.join('，');
}

function pageText(job) {
  const p = job?.progress;
  if (!p?.totalPages) return '';
  return `解析进度 ${p.extractedPages ?? 0}/${p.totalPages} 页`;
}

function jobMetaText(job) {
  const parts = [];
  if (job.modeLabel) parts.push(job.modeLabel);
  parts.push(job.stateLabel || job.state);
  if (IN_PROGRESS.has(job.state)) {
    const elapsed = elapsedText(job); if (elapsed) parts.push(elapsed);
    const queue = queueText(job); if (queue) parts.push(queue);
    const pages = pageText(job); if (pages) parts.push(pages);
  } else if (job.error) {
    parts.push(job.error);
  } else if (job.hasMarkdown) {
    parts.push(job.jsonCount ? `${job.jsonCount} 个 JSON` : '仅 Markdown');
  }
  return parts.join(' · ');
}

// ── 预览 ────────────────────────────────────────────────────────────────

function renderTabs() {
  renderCtrl('tabsSlot', 'Tabs', {
    items: [
      { value: 'markdown', label: 'Markdown' },
      { value: 'json', label: 'JSON' },
      { value: 'translation', label: '译文' },
    ],
    value: activeTab,
    onChange: (value) => { activeTab = value; showPreview(value); },
    ariaLabel: '结果视图',
    variant: 'line',
  });
}

/**
 * 右栏：翻译的目标语言（下次翻译翻成什么）。
 * 与 v1 一致，这里始终可见，不必先有译文才能选。
 */
function renderTargetLanguageSelect() {
  const options = languages.map((lang) => ({ value: lang, label: lang }));
  if (!options.length) return;
  renderCtrl('translateLangSlot', 'Select', {
    options,
    value: targetLanguage,
    onChange: (value) => {
      targetLanguage = value;
      renderTargetLanguageSelect();
      void publishTargetLanguage();
    },
    ariaLabel: '目标语言',
  });
}

/** 把目标语言广播给侧栏（侧栏据此生成译文获取指令）。 */
async function publishTargetLanguage() {
  try { await hana.storage.global.set(STORAGE_TARGET_LANG, targetLanguage || ''); }
  catch { /* 广播失败不影响翻译本身 */ }
}

/**
 * 中栏译文工具条：只在「译文」页签、且确实有译文时出现。
 * 里面的选择器管的是「当前查看哪一份译文」，不是目标语言。
 */
function renderTranslationBar() {
  const options = translations.map((item) => ({ value: item.lang, label: item.lang }));
  renderCtrl('langSlot', 'Select', {
    options,
    value: viewTranslationLang || options[0]?.value || '',
    onChange: (value) => {
      viewTranslationLang = value;
      if (activeTab === 'translation') showPreview('translation');
    },
    ariaLabel: '查看译文',
  });
}

async function showPreview(kind) {
  const el = $('preview');
  stopImageLoading();
  el.replaceChildren();
  renderTabs();

  // 译文工具条只在「译文」页签、且确实有译文时出现。
  const bar = $('translationBar');
  if (bar) bar.hidden = kind !== 'translation' || !translations.length;
  if (kind === 'translation' && translations.length) renderTranslationBar();

  if (kind === 'json') {
    const pre = document.createElement('pre');
    pre.className = 'json-view';
    pre.textContent = preview?.json ?? (preview?.jsonAvailable === false
      ? '该解析方式仅返回 Markdown，没有 JSON 结果（Agent 轻量解析 API 的限制）。'
      : '暂无 JSON 结果');
    el.append(pre);
    return;
  }

  if (kind === 'translation') {
    if (!translations.length) {
      el.append(emptyNote('还没有译文。在右侧选择目标语言与模型后点「开始翻译」。'));
      return;
    }
    const lang = viewTranslationLang || translations[0].lang;
    const key = `${selectedJob?.jobId}|${lang}`;
    try {
      let data = translationCache.get(key);
      if (!data) {
        data = await api(`jobs/${selectedJob.jobId}/translation/${encodeURIComponent(lang)}`);
        translationCache.set(key, data);
      }
      appendRichHtml(el, data.markdownHtml || '');
      const meta = $('translationMeta');
      if (meta) {
        const bits = [];
        if (data.modelLabel) bits.push(data.modelLabel);
        if (data.failedChunks) bits.push(`${data.failedChunks} 个片段保留原文`);
        meta.textContent = bits.join(' · ');
      }
    } catch (error) {
      el.append(emptyNote(error?.message || String(error)));
    }
    return;
  }

  if (preview?.markdownHtml) {
    appendRichHtml(el, preview.markdownHtml);
    return;
  }
  if (preview?.markdown) {
    const pre = document.createElement('pre');
    pre.textContent = preview.markdown;
    el.append(pre);
    return;
  }
  el.append(emptyNote(preview?.state === 'done' ? '该任务没有可预览的解析内容。' : '暂无解析结果'));
}

function emptyNote(text) {
  const p = document.createElement('p');
  p.className = 'preview-empty';
  p.textContent = text;
  return p;
}

/** markdownHtml 由服务端渲染并经过白名单净化（见 lib/markdown-render.v2.js）。 */
function appendRichHtml(container, html) {
  const holder = document.createElement('div');
  holder.innerHTML = html;
  const localImages = detachImageSources(holder);
  container.append(...holder.childNodes);
  observeImages(localImages, container);
}

// ── 任务选择与轮询 ──────────────────────────────────────────────────────────

async function loadJobs() {
  try {
    const data = await api('jobs');
    currentJobs = Array.isArray(data.jobs) ? data.jobs : [];
    await syncSelection();
  } catch (error) {
    showStatus(error?.message || String(error), true);
  }
}

/**
 * 按当前选中的 id 决定显示哪一条。
 *
 * 选中态由侧栏广播（ui.selectedJobId），本页只负责把 id 映射成任务并渲染结果。
 * 同一条通常只刷新状态、不重载预览——否则列表每次变化都会打断正在阅读的内容；
 * 但**状态确实变了**（尤其变成已完成）时必须重取结果，否则会一直显示旧内容。
 */
async function syncSelection() {
  const job = selectedJobId
    ? currentJobs.find((item) => item.jobId === selectedJobId)
    : null;

  if (!job) { clearSelection(); return; }

  if (selectedJob?.jobId === job.jobId) {
    const stateChanged = selectedJob.state !== job.state;
    selectedJob = job;
    updateViewerHead();
    renderActionState();
    startAutoPoll(job);
    if (stateChanged) {
      void loadPreview(job);
      void loadTranslations(job);
    }
    return;
  }

  await selectJob(job);
}

function updateViewerHead() {
  if (!selectedJob) {
    $('fileTitle').textContent = 'MinerU 文档工作台';
    $('fileMeta').textContent = '';
    return;
  }
  $('fileTitle').textContent = `${selectedJob.fileName} · ${selectedJob.stateLabel || selectedJob.state}`;
  $('fileMeta').textContent = jobMetaText(selectedJob);
}

function clearSelection() {
  stopAutoPoll();
  selectedJob = null;
  preview = null;
  translations.length = 0;
  translationCache.clear();
  updateViewerHead();
  renderActionState();
  showPreview('markdown');
}

function selectJob(job) {
  selectedJob = job;
  updateViewerHead();
  preview = null;
  renderActionState();
  activeTab = 'markdown';
  showPreview('markdown');
  void loadPreview(job);
  void loadTranslations(job);
  startAutoPoll(job);
}

/**
 * 订阅侧栏的广播。
 *   ui.selectedJobId 变化 → 换一条显示
 *   ui.jobsRevision 变化 → 列表变了（新建/删除），重拉
 */
function watchSidebar() {
  hana.storage.global.onChanged((keys) => {
    if (!Array.isArray(keys)) return;
    if (keys.includes(STORAGE_SELECTED)) {
      void (async () => {
        const next = await readStored(STORAGE_SELECTED);
        const id = typeof next === 'string' ? next : null;
        if (id === selectedJobId) return;
        selectedJobId = id;
        await loadJobs();   // 需要列表才能把 id 映射成任务对象
      })();
    }
    if (keys.includes(STORAGE_REVISION)) void loadJobs();
  });
}

/** 告诉侧栏列表变了。递增计数而不是时间戳：同一毫秒内的两次改动不能被合并。 */
async function bumpRevision() {
  try {
    const prev = await readStored(STORAGE_REVISION);
    await hana.storage.global.set(STORAGE_REVISION, (typeof prev === 'number' ? prev : 0) + 1);
  } catch { /* 通知失败不影响本地流程 */ }
}

async function loadPreview(job) {
  try {
    preview = await api(`jobs/${job.jobId}`);
    if (selectedJob?.jobId === job.jobId) showPreview(activeTab);
  } catch (error) {
    showStatus(error?.message || String(error), true);
  }
}

function stopAutoPoll() {
  if (autoPollTimer) { clearTimeout(autoPollTimer); autoPollTimer = null; }
}

function startAutoPoll(job) {
  stopAutoPoll();
  if (!job?.batchId || !IN_PROGRESS.has(job.state)) return;
  const jobId = job.jobId;
  autoPollTimer = setTimeout(async () => {
    if (selectedJob?.jobId !== jobId) return;
    try {
      const result = await api(`jobs/${jobId}/refresh`, { method: 'POST' });
      if (selectedJob?.jobId !== jobId) return;
      await loadJobs();
      const next = currentJobs.find((item) => item.jobId === jobId);
      if (next && selectedJob?.jobId === jobId) {
        selectedJob = next;
        updateViewerHead();
        renderActionState();
        startAutoPoll(next);
      }
      if (result.error) showStatus(result.error, true);
      else if (result.state !== 'pending') showStatus(`状态：${result.stateLabel || result.state}`);
    } catch {
      // 暂时性失败：保留手动刷新入口，稍后再试。
      setTimeout(() => { if (selectedJob?.jobId === jobId) startAutoPoll(selectedJob); }, 30000);
    }
  }, 20000);
}

// ── 翻译 ────────────────────────────────────────────────────────────────────

async function loadTranslations(job) {
  translations.length = 0;
  translationCache.clear();
  $('translationMeta').textContent = '';
  if (!job) return;
  try {
    const state = await api(`jobs/${job.jobId}/translate`);
    for (const item of state.translations || []) translations.push(item);
    // 默认查看：优先刚翻完的那个目标语言，否则第一条已有译文。
    viewTranslationLang = translations.some((item) => item.lang === targetLanguage)
      ? targetLanguage
      : (translations[0]?.lang || '');
    if (selectedJob?.jobId === job.jobId && activeTab === 'translation') showPreview('translation');
    if (state.state === 'running') { setTranslateStatus(state); startTranslatePoll(); }
  } catch { /* 无译文时保持空列表 */ }
}

function setTranslateStatus(state) {
  translating = state.state === 'running';
  const el = $('translateStatus');
  if (state.state === 'running') {
    el.textContent = `正在翻译：${state.done || 0}/${state.total || '?'} 片语`;
  } else if (state.state === 'done') {
    el.textContent = `翻译完成（${state.total} 片语）`;
  } else if (state.state === 'done_with_errors') {
    el.textContent = `翻译完成，${(state.failures || []).length} 个片段保留原文`;
  } else if (state.state === 'cancelled') {
    el.textContent = '翻译已取消';
  } else if (state.state === 'failed') {
    el.textContent = `翻译失败：${state.error || '未知错误'}`;
  } else {
    el.textContent = '';
  }
  renderActionState();
}

function stopTranslatePoll() {
  if (translatePollTimer) { clearTimeout(translatePollTimer); translatePollTimer = null; }
}

function startTranslatePoll() {
  stopTranslatePoll();
  const jobId = selectedJob?.jobId;
  if (!jobId) return;
  translatePollTimer = setTimeout(async () => {
    if (selectedJob?.jobId !== jobId) return;
    try {
      const state = await api(`jobs/${jobId}/translate`);
      if (selectedJob?.jobId !== jobId) return;
      setTranslateStatus(state);
      if (state.state === 'running') { startTranslatePoll(); return; }
      translationCache.clear();
      await loadTranslations(selectedJob);
      showPreview('translation');
    } catch (error) {
      $('translateStatus').textContent = error?.message || String(error);
    }
  }, 2500);
}

async function startTranslation() {
  if (!selectedJob) return;
  if (!targetLanguage) { showStatus('请选择目标语言', true); return; }
  const value = modelValue;
  let model = null;
  if (value) { try { model = JSON.parse(value); } catch { model = null; } }
  translating = true;
  renderActionState();
  try {
    await api(`jobs/${selectedJob.jobId}/translate`, jsonInit('POST', { targetLanguage, model }));
    $('translateStatus').textContent = '已开始翻译…';
    startTranslatePoll();
  } catch (error) {
    showStatus(error?.message || String(error), true);
  } finally {
    translating = false;
    renderActionState();
  }
}

async function cancelTranslation() {
  if (!selectedJob) return;
  try {
    await api(`jobs/${selectedJob.jobId}/translate/cancel`, { method: 'POST' });
    $('translateStatus').textContent = '正在取消…';
  } catch (error) {
    showStatus(error?.message || String(error), true);
  }
}

/**
 * 把文本编码成 base64。
 *
 * `resource.saveFile` 只收 contentBase64；`btoa` 遇到非 Latin-1 字符会抛错，
 * 所以先经 TextEncoder 转 UTF-8 字节，再拼成二进制字符串。分块是为了避开
 * `String.fromCharCode(...bigArray)` 的参数个数上限（中文文档很容易超）。
 */
function bytesToBase64(bytes) {
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

function toBase64(text) {
  return bytesToBase64(new TextEncoder().encode(text));
}

/**
 * 标题栏那个另存按钮的实现。
 *
 * 全界面只留这一个导出入口，所以它导出的是**当前正在看的东西**：
 *   译文页签且有译文 → 当前那份译文
 *   其余（Markdown / JSON）→ 结果 Markdown
 * JSON 页签也导出结果 Markdown：同一个任务的 JSON 视图只是另一面，
 * 存成 .md 仍然是份真的 Markdown，不会得到“后缀写 md 但内容是 JSON”的假文件。
 *
 * 内容由后端 `GET /jobs/:id/export` 生成（它才能读磁盘上的图片、
 * 下载外链图、打包 zip），这里只负责把字节交给 saveFile。
 * 两种格式的差别见 lib/export-bundle.v1.js 头部。
 *
 * 为什么是「另存」而不是「复制」：主卡是 **card** 槽位，而
 * `clipboard.writeText` 的宿主白名单是 page/widget/settings/function-panel,
 * 不含 card；`resource.saveFile` 的白名单恰好是 ["card","preview"]。
 * 这一格是宿主按槽位划的，不是我们能选。
 *
 * 想复制指令的活已经移到侧栏（function-panel 允许剪贴板）。
 */
async function saveCurrentView() {
  if (!selectedJob) return;
  const isTranslation = activeTab === 'translation' && translations.length > 0;
  const lang = isTranslation ? (viewTranslationLang || translations[0]?.lang || '') : '';
  if (isTranslation && !lang) { showStatus('先翻译一次，才有译文可导出', true); return; }

  const params = new URLSearchParams({ format: exportFormat });
  if (lang) params.set('translation', lang);

  exporting = true;
  renderActionState();
  // 外链图多的时候要等下载，先给一句状态，否则看着像卡住了。
  showStatus(exportFormat === 'zip' ? '正在打包…' : '正在内联图片…');
  try {
    const response = await hana.api.fetch(`jobs/${selectedJob.jobId}/export?${params}`);
    if (!response.ok) {
      let message = `HTTP ${response.status}`;
      try { message = (await response.json())?.error || message; } catch { /* 非 JSON 错误体 */ }
      throw new Error(message);
    }

    const header = (name) => response.headers.get(name) || '';
    const warned = Number(header('X-Mineru-Export-Warnings') || 0);
    const downloaded = Number(header('X-Mineru-Export-Downloaded') || 0);
    const nameHeader = header('X-Mineru-Export-File-Name');
    let suggestedName;
    try { suggestedName = nameHeader ? decodeURIComponent(nameHeader) : ''; } catch { suggestedName = ''; }
    if (!suggestedName) suggestedName = safeSuggestedName(selectedJob.fileName, exportFormat, lang);

    const mimeType = exportFormat === 'zip' ? 'application/zip' : 'text/markdown';
    const contentBase64 = exportFormat === 'zip'
      ? bytesToBase64(new Uint8Array(await response.arrayBuffer()))
      : toBase64(await response.text());

    const result = await hana.resources.saveFile({ suggestedName, mimeType, contentBase64 });
    if (result?.kind === 'canceled') { clearStatus(); return; }

    const bits = [`已导出 ${suggestedName}`];
    if (downloaded) bits.push(`下载了 ${downloaded} 张外链图`);
    if (warned) bits.push(`${warned} 张图未能一并打包（保持原链接）`);
    showStatus(bits.join('，'));
  } catch (error) {
    showStatus(error?.message || String(error), true);
  } finally {
    exporting = false;
    renderActionState();
  }
}

/** 后端没回文件名时的兵底；后端已做过同样的字符净化。 */
function safeSuggestedName(fileName, format, lang) {
  const base = String(fileName || 'mineru-result')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80) || 'mineru-result';
  const suffix = lang ? `.${lang}` : '';
  return `${base}${suffix}${format === 'zip' ? '.zip' : '.md'}`;
}

// ── 新建解析：点 / 拖 / 贴 ───────────────────────────────────────────────

/**
 * 选中的待解析文件（`selectedSource` 在上面状态区声明）。
 *
 * 三种入口最终都归结到这里：
 *   · 选择器 → 宿主给的 ResourceRef（带真实路径）
 *   · 拖放 / 粘贴 → 字节先传给后端 `/intake`，后端落到 dataDir 并回一个
 *     `{kind:'local-file', path}` 引用
 * 后一种的原因：浏览器沙箱**不把本地路径给页面**，而 `materialize` 那条路
 * 要的就是路径。所以只能把字节送回去，让后端自己落盘。
 */
let selectedName = '';
/** 正在接收拖放/粘贴的上传。 */
let intakeBusy = false;

const DROP_ICON_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"'
  + ' stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">'
  + '<path d="M12 16V4"/><path d="m7 9 5-5 5 5"/>'
  + '<path d="M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3"/></svg>';

function setSelectedSource(ref, name) {
  selectedSource = ref;
  selectedName = name || '';
  renderActionState();
}

function clearSelectedSource() {
  selectedSource = null;
  selectedName = '';
  renderActionState();
  clearStatus();
}

async function pickFile() {
  try {
    const picked = await hana.resources.pick({ mode: 'file' });
    const ref = normalizePicked(picked);
    if (!ref) { showStatus('没有选择文件'); return; }
    setSelectedSource(ref, ref.path?.split(/[\\/]/).pop() || ref.displayName || ref.fileId || '已选择文件');
    clearStatus();
  } catch (error) {
    showStatus(error?.message || String(error), true);
  }
}

/** 兼容 pick 可能返回的几种形状。 */
function normalizePicked(value) {
  if (!value) return null;
  if (value.resource) return value.resource;
  if (value.ref) return value.ref;
  if (Array.isArray(value.resources)) return normalizePicked(value.resources[0]);
  if (value.kind) return value;
  return null;
}

/** 可解析的扩展名——与后端 file-types 保持一致，改一处要改两处。 */
const SUPPORTED_EXTS = ['.pdf', '.png', '.jpg', '.jpeg', '.jp2', '.webp', '.gif', '.bmp',
  '.doc', '.docx', '.ppt', '.pptx', '.xls', '.xlsx'];

function isSupportedName(name) {
  const lower = String(name || '').toLowerCase();
  const dot = lower.lastIndexOf('.');
  return dot > 0 && SUPPORTED_EXTS.includes(lower.slice(dot));
}

function looksLikePath(value) {
  const text = String(value || '').trim();
  if (!text || text.includes('\n')) return false;
  return /^[A-Za-z]:[\\/]/.test(text) || /^\/\//.test(text) || /^\//.test(text);
}

function formatSize(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}

/**
 * 把字节传给后端落盘，换回一个可用的资源引用。
 * 直接发原始字节（不是 base64）：100MB 的文件不会因为编码膨胀成 133MB。
 */
async function intakeFile(file, name) {
  const response = await hana.api.fetch(`intake?name=${encodeURIComponent(name)}`, {
    method: 'POST',
    headers: { 'Content-Type': file?.type || 'application/octet-stream' },
    body: file,
  });
  let body = null;
  try { body = await response.json(); } catch { /* 非 JSON */ }
  if (!response.ok) throw new Error(body?.error || `上传失败（HTTP ${response.status}）`);
  if (!body?.resource?.path) throw new Error('上传后没拿到可用路径');
  return { ref: body.resource, name: body.fileName || name, size: body.size };
}

/** 收下一批文件（拖放进来的 / 粘进来的），一次只接一个。 */
async function acceptFiles(files) {
  const list = Array.from(files || []);
  if (!list.length) return false;
  if (list.length > 1) {
    showStatus(`一次只能解析一个文件（拖进来了 ${list.length} 个）`, true);
    return true;
  }
  const file = list[0];
  let name = file.name || '粘贴的文件';
  // 截图 / 复制粘贴过来的常常叫 image.png 之类，换成带时间戳的名字好辨认。
  if (/^(image|blob|pasted|clipboard)(\.[a-z0-9]+)?$/i.test(name)) name = nameForPastedFile(file);
  if (!isSupportedName(name)) {
    showStatus(`不支持的文件类型：${name}`, true);
    return true;
  }
  intakeBusy = true;
  renderActionState();
  showStatus(`正在接收 ${name}…`);
  try {
    const got = await intakeFile(file, name);
    setSelectedSource(got.ref, got.name);
    const size = formatSize(got.size);
    showStatus(`已就绪：${got.name}${size ? `（${size}）` : ''}`);
  } catch (error) {
    showStatus(error?.message || String(error), true);
  } finally {
    intakeBusy = false;
    renderActionState();
  }
  return true;
}

/**
 * 拖放。
 *
 * 分两种情况：
 *   · 原生拖入（从资源管理器）：`dataTransfer.files` 有 File，能拿到字节；
 *   · 应用内拖入（从 Hana 自己的文件区）：`files` 是空的（拖拽源只能放
 *     字符串），但 `text/plain` 里是真实路径，直接用那个路径当引用。
 */
async function handleDrop(event) {
  const dt = event.dataTransfer;
  if (!dt) return;
  if (dt.files && dt.files.length) { await acceptFiles(dt.files); return; }

  const text = dt.getData('text/plain') || '';
  if (looksLikePath(text)) {
    const cleaned = text.trim().replace(/\\/g, '/');
    const name = cleaned.split('/').pop() || '';
    if (!isSupportedName(name)) {
      showStatus(`不支持的文件类型：${name || cleaned}`, true);
      return;
    }
    // 路径由宿主保管，能不能读由它授权；不行会在这里报错。
    setSelectedSource({ kind: 'local-file', path: text.trim() }, name);
    showStatus(`已就绪：${name}`);
    return;
  }

  showStatus('没识别到文件；可以点上方区域用选择器挑一个', true);
}

/** 粘贴：剪贴板里可能是复制的文件，也可能是一张截图（都是 File）。 */
async function handlePaste(event) {
  const dt = event.clipboardData;
  if (!dt) return;
  const files = Array.from(dt.files || []);
  if (files.length) {
    event.preventDefault();
    await acceptFiles(files);
    return;
  }
  // 有些平台把图放在 items 里而不是 files。
  const fromItems = [];
  for (const item of Array.from(dt.items || [])) {
    if (item.kind === 'file') {
      const file = item.getAsFile();
      if (file) fromItems.push(file);
    }
  }
  if (fromItems.length) {
    event.preventDefault();
    await acceptFiles(fromItems);
  }
}

/** 截图粘贴过来的文件常常叫 image.png，给个带时间戳的中文名好辨认。 */
function nameForPastedFile(file) {
  const ext = (() => {
    const type = String(file?.type || '');
    if (type === 'image/png') return '.png';
    if (type === 'image/jpeg') return '.jpg';
    if (type === 'image/webp') return '.webp';
    if (type === 'image/gif') return '.gif';
    const dot = String(file?.name || '').lastIndexOf('.');
    return dot > 0 ? String(file.name).slice(dot) : '.png';
  })();
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  return `粘贴图片-${stamp}${ext}`;
}

function installDropZone() {
  const zone = $('dropZone');
  if (!zone) return;

  const icon = $('dropIcon');
  if (icon) icon.innerHTML = DROP_ICON_SVG;

  zone.addEventListener('click', (event) => {
    // 里面的官方按钮自己会处理点击，别触发两次选择器。
    if (event.target.closest('.slot')) return;
    void pickFile();
  });
  zone.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      void pickFile();
    }
  });

  // 必须 dragenter/dragover 都 preventDefault，否则浏览器不会触发 drop。
  const stop = (event) => { event.preventDefault(); event.stopPropagation(); };
  zone.addEventListener('dragenter', (event) => { stop(event); zone.classList.add('is-over'); });
  zone.addEventListener('dragover', (event) => {
    stop(event);
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
    zone.classList.add('is-over');
  });
  zone.addEventListener('dragleave', (event) => {
    // 移到子元素上也会触发 dragleave，只有真正离开整块才取消高亮。
    if (zone.contains(event.relatedTarget)) return;
    zone.classList.remove('is-over');
  });
  zone.addEventListener('drop', (event) => {
    stop(event);
    zone.classList.remove('is-over');
    void handleDrop(event);
  });

  // 页面级也拦一下：拖到区域外面松手时，不要让浏览器直接打开那个文件。
  const swallow = (event) => { event.preventDefault(); };
  document.addEventListener('dragover', swallow);
  document.addEventListener('drop', swallow);

  // 粘贴：整个页面都能接（用户不必先点中区域），但输入框里别抢。
  document.addEventListener('paste', (event) => {
    const target = event.target;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;
    void handlePaste(event);
  });
}

async function submitJob() {
  if (!selectedSource || submitting) return;
  submitting = true;
  renderActionState();
  showStatus('正在提交到 MinerU…');
  try {
    const modeId = currentModeId;
    const job = await api('jobs', jsonInit('POST', {
      source: selectedSource,
      fileName: selectedName || 'document',
      isOcr: Boolean(ocrEnabled),
      modelVersion: modeId,
    }));
    const modeLabel = job.modeLabel ? `${job.modeLabel} · ` : '';
    const jsonNote = job.modelVersion === 'agent' ? '（仅 Markdown）' : '';
    showStatus(`已提交（${modeLabel}${job.stateLabel || job.state}）${jsonNote}，稍后查询状态`);
    clearSelectedSource();

    // 新任务立刻设为选中：侧栏会高亮它，主卡好开始看结果。
    selectedJobId = job.jobId;
    await hana.storage.global.set(STORAGE_SELECTED, selectedJobId);
    await bumpRevision();
    await loadJobs();
  } catch (error) {
    showStatus(error?.message || String(error), true);
  } finally {
    submitting = false;
    renderActionState();
  }
}

let currentModeId = 'vlm';
let modelValue = '';
let ocrEnabled = false;

function renderModeSelect() {
  renderCtrl('modeSlot', 'Select', {
    options: parseModes.map((mode) => ({ value: mode.id, label: mode.label })),
    value: currentModeId,
    onChange: (value) => {
      currentModeId = value;
      renderModeHint();
      renderModeSelect();
    },
    ariaLabel: '解析方式',
  });
}

function renderModeHint() {
  const mode = parseModes.find((item) => item.id === currentModeId);
  const hint = $('modeHint');
  if (hint) hint.textContent = mode?.hint || '';
}

/* 官方控件是挂载出来的，不是页面上的原生表单元素：取值一律读这里的状态变量，
   不能按 id 去 DOM 里拿。onChange 里回写变量后再 update 一次，显示才跟着走。 */
function renderOcr() {
  renderCtrl('ocrSlot', 'Checkbox', {
    label: '启用 OCR（仅 PDF 生效）',
    checked: ocrEnabled,
    onChange: (checked) => { ocrEnabled = Boolean(checked); renderOcr(); },
  });
}

function renderTranslateModel() {
  renderCtrl('translateModelSlot', 'Select', {
    options: modelOptions,
    value: modelValue,
    onChange: (value) => { modelValue = value; renderTranslateModel(); },
    ariaLabel: '翻译模型',
  });
}

/** 上传区的状态：拖放高亮、空/已选两种面貌、清除按钮。 */
function renderUploadState() {
  const zone = $('dropZone');
  if (zone) zone.classList.toggle('is-busy', intakeBusy);

  const title = $('dropTitle');
  const hint = $('dropHint');
  if (title) title.textContent = intakeBusy ? '正在接收文件…' : '把文件拖到这里';
  if (hint) {
    hint.textContent = selectedSource
      ? '拖入或粘贴另一个文件可替换'
      : '或点击选择，也可以直接粘贴';
  }

  const row = $('selectionRow');
  const name = $('selection');
  if (row) row.hidden = !selectedSource;
  if (name) name.textContent = selectedName || '已选择文件';

  if (selectedSource) {
    renderCtrl('clearSlot', 'Button', {
      variant: 'ghost', size: 'sm', children: '移除',
      onClick: clearSelectedSource,
      disabled: submitting || intakeBusy,
    });
  } else {
    clearSlot('clearSlot');
  }

  const note = $('uploadNote');
  if (note) {
    note.textContent = intakeBusy
      ? ''
      : `支持 ${describeSupportedTypes()}`;
  }
}

/** 与后端 file-types 保持一致的“支持类型”文案。 */
function describeSupportedTypes() {
  return 'PDF、图片（PNG/JPG/WebP/GIF/BMP/JP2）、Office 文档（Word/PPT/Excel）';
}

/** 按钮的可用状态集中在这里，避免散落在各处漏更新。 */
function renderActionState() {
  const done = selectedJob?.state === 'done';

  renderCtrl('pickSlot', 'Button', {
    variant: 'primary', children: '选择文件', onClick: pickFile,
    disabled: submitting || intakeBusy,
  });
  renderUploadState();
  renderOcr();
  renderCtrl('submitSlot', 'Button', {
    variant: 'primary', children: '开始解析',
    onClick: submitJob,
    disabled: !selectedSource || submitting || intakeBusy,
    loading: submitting,
  });
  // 「查询选中任务」已移到侧栏的行内刷新图标（职责上属于“对某条记录做操作”）。
  // 「复制指令」也移到了侧栏：card 槽位不允许写剪贴板，而侧栏（function-panel）允许。
  // 导出入口收在标题栏右侧：格式下拉 + 另存按钮，全界面只此一处。
  renderCtrl('exportFormatSlot', 'Select', {
    options: [
      { value: 'zip', label: '打包 zip' },
      { value: 'inline', label: '单个 md' },
    ],
    value: exportFormat,
    onChange: (value) => { exportFormat = value; renderActionState(); },
    disabled: !done || exporting,
    ariaLabel: '导出格式',
  });
  renderCtrl('saveSlot', 'Button', {
    variant: 'secondary', size: 'sm', children: '另存',
    onClick: saveCurrentView,
    disabled: !done || exporting,
    loading: exporting,
  });

  renderTargetLanguageSelect();
  renderTranslateModel();
  renderCtrl('translateBtnSlot', 'Button', {
    variant: 'primary', children: '开始翻译',
    onClick: startTranslation,
    disabled: !done || translating,
    loading: translating,
  });
  setSlotHidden('translateCancelSlot', !translating);
  if (translating) {
    renderCtrl('translateCancelSlot', 'Button', {
      variant: 'ghost', size: 'sm', children: '取消翻译', onClick: cancelTranslation,
    });
  } else {
    clearSlot('translateCancelSlot');
  }
}

// ── 初始化 ──────────────────────────────────────────────────────────────────

async function loadOptions() {
  try {
    const options = await api('options');
    parseModes = Array.isArray(options.modes) ? options.modes : [];
    languages = Array.isArray(options.languages) && options.languages.length
      ? options.languages
      : [options.defaultTargetLanguage || '中文'];
    currentModeId = options.current || options.default || parseModes[0]?.id || 'vlm';
    const preferred = options.defaultTargetLanguage || languages[0];
    // 配置里可能存着不在清单里的语言（例如「粤语」），插到列表最前，不丢用户的选择。
    targetLanguage = languages.includes(preferred) ? preferred : preferred;
  } catch (error) {
    // 拿不到就退回内置的三档解析方式，功能仍然可用。
    parseModes = [
      { id: 'vlm', label: 'MinerU VLM', requiresToken: true },
      { id: 'pipeline', label: 'MinerU', requiresToken: true },
      { id: 'agent', label: 'Agent 轻量解析 API（免 Token）', requiresToken: false },
    ];
    languages = ['中文'];
    targetLanguage = '中文';
    showStatus(`读取解析方式失败：${error?.message || error}`, true);
  }
  if (!languages.includes(targetLanguage)) languages = [targetLanguage, ...languages];
  renderModeSelect();
  renderModeHint();
  // 初始化时也广播一次，侧栏一打开就有正确的语言可用。
  void publishTargetLanguage();
  renderActionState();
}

async function loadTranslationModels() {
  try {
    const data = await api('translation-models');
    const models = Array.isArray(data.models) ? data.models : [];
    modelOptions = [
      { value: '', label: '默认（当前 agent 的实用模型）' },
      ...models.map((model) => ({
        value: JSON.stringify({ id: model.id, provider: model.provider, name: model.name }),
        label: model.label || model.id,
      })),
    ];
    const current = data.current?.id;
    if (current) {
      const match = modelOptions.find((option) => {
        try { return JSON.parse(option.value).id === current; } catch { return false; }
      });
      if (match) modelValue = match.value;
    }
    if (!models.length) {
      modelOptions = [{ value: '', label: data.error ? `无法读取模型列表：${data.error}` : '没有已配置的聊天模型' }];
    }
  } catch (error) {
    modelOptions = [{ value: '', label: `无法读取模型列表：${error?.message || error}` }];
  }
  renderActionState();
}

async function main() {
  followHostTheme();

  // 上传区（点 / 拖 / 贴）。先装上，用户的第一个动作就可能发生在这里。
  installDropZone();

  // 先取一次已有选中态（页面重载后要恢复），再订阅后续变化（两个 iframe 不共享 JS）。
  try {
    const stored = await readStored(STORAGE_SELECTED);
    if (typeof stored === 'string') selectedJobId = stored;
  } catch { /* 拿不到就当未选中 */ }
  watchSidebar();

  try {
    await loadOptions();
  } catch (error) {
    showStatus(`初始化失败：${error?.message || error}`, true);
  }
  try {
    await loadTranslationModels();
  } catch { /* 模型列表失败不影响解析功能 */ }
  await loadJobs();
  activeTab = 'markdown';
  showPreview('markdown');
  hana.ready();
}

main();
