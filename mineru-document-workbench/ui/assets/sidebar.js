/*
 * 解析历史侧栏（功能面板）
 * ======================
 *
 * 这个页面挂在宿主的功能面板里（manifest 的 functionPanel.route 指向它）。
 * 它和主卡是两个独立 iframe，不共享 JS 对象，所以两者之间的通信走
 * App 存储（hana.storage）——宿主文档点名推荐的做法。
 *
 * 职责约定：侧栏只做「挑选」，主卡只做「查看与操作」。
 *
 *   sidebar → 主卡：写 STORAGE_SELECTED（选中哪条历史）
 *   主卡 → sidebar：写 STORAGE_REVISION（列表变了，需要重拉）
 *
 * 操作设计：
 *   - 每条历史右侧常驻一个垃圾桶图标（不缩、不裁），点它弹确认
 *   - 头部「多选」进入批量模式：勾选多条 → 底部操作条统一删除
 */

import { hana } from './sdk.js';
import { appUi, mountAppUi } from './app-ui.js';

const $ = (id) => document.getElementById(id);

/** 与主卡约定的存储键。 */
const STORAGE_SELECTED = 'ui.selectedJobId';
const STORAGE_REVISION = 'ui.jobsRevision';
// 目标语言由主卡广播过来（侧栏自己读不到主卡的状态）。
const STORAGE_TARGET_LANG = 'ui.targetLanguage';

/**
 * 从 App 存储读一个值，并**拆掉包装**。
 *
 * 实测坑：`hana.storage.global.get(key)` 返回的不是裸值，而是一个包装对象
 * （与宿主 v1 存储版的 `{ key, value }` 同形）。直接 `typeof x === 'string'`
 * 会永远判假。这里三种形状都认：裸值、`{ value }`、以及再包一层的情况。
 */
async function readStored(key) {
  return unwrapStored(await hana.storage.global.get(key));
}

function unwrapStored(raw) {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== 'object') return raw;
  if ('value' in raw) {
    const inner = raw.value;
    if (inner !== null && typeof inner === 'object' && 'value' in inner && !Array.isArray(inner)) {
      return inner.value ?? null;
    }
    return inner ?? null;
  }
  return raw;
}

const IN_PROGRESS = new Set(['pending', 'running', 'converting', 'uploading', 'waiting-file', 'submitting']);

/**
 * 垃圾桶图标。
 *
 * 官方控件包只提供 chevron / check / loading / failure 四个图标，没有垃圾桶；
 * 而 IconButton 要求 children 是一个 React 元素，页面侧又造不出这样的元素
 * （appUi 只认已注册控件、appUiIcon 只有那四个名字）。所以行内按钮自绘。
 * 这是静态字符串，不含任何用户数据，直接 innerHTML 是安全的。
 */
const TRASH_SVG = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none"'
  + ' stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"'
  + ' aria-hidden="true"><path d="M3 6h18"/><path d="M8 6V4h8v2"/>'
  + '<path d="M6 6l1.2 13.2A1 1 0 0 0 8.2 20h7.6a1 1 0 0 0 1-0.8L18 6"/>'
  + '<path d="M10 11v5"/><path d="M14 11v5"/></svg>';

/** 刷新图标（同上的理由，自绘）。 */
const REFRESH_SVG = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none"'
  + ' stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"'
  + ' aria-hidden="true"><path d="M20 11a8 8 0 1 0-2.3 6.3"/>'
  + '<path d="M20 5v6h-6"/></svg>';

let currentJobs = [];
let selectedJobId = null;
let selectMode = false;
const pickedIds = new Set();
let handles = [];
/** jobId → 该行勾选框控件的 handle（更新受控 props 用）。 */
const pickHandles = new Map();

// ── 官方控件挂载 ────────────────────────────────────────────────────────────

const registry = new Map();

function renderCtrl(hostId, control, props) {
  const entry = registry.get(hostId);
  if (entry && entry.control === control) {
    entry.handle.update(props);
    return entry.handle;
  }
  if (entry) {
    try { entry.handle.destroy(); } catch { /* 已销毁 */ }
    registry.delete(hostId);
  }
  const host = $(hostId);
  if (!host) return null;
  host.replaceChildren();
  const el = document.createElement('div');
  el.className = 'ui-slot';
  host.appendChild(el);
  const handle = mountAppUi(el, control, props);
  registry.set(hostId, { control, handle });
  return handle;
}

function clearCtrl(hostId) {
  const entry = registry.get(hostId);
  if (entry) {
    try { entry.handle.destroy(); } catch { /* 已销毁 */ }
    registry.delete(hostId);
  }
  const host = $(hostId);
  if (host) host.replaceChildren();
}

// ── 后端调用 ────────────────────────────────────────────────────────────────

async function api(path, init) {
  const response = await hana.api.fetch(path, init);
  let body = null;
  try { body = await response.json(); } catch { /* 空响应或非 JSON */ }
  if (!response.ok) throw new Error(body?.error || body?.message || `HTTP ${response.status}`);
  return body ?? {};
}

// ── 文案 ────────────────────────────────────────────────────────────────────

function formatBytes(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}

function displayName(job) {
  return job.fileName || '未命名文件';
}

function elapsedText(job) {
  if (!job?.createdAt) return '';
  const ms = Date.now() - Date.parse(job.createdAt);
  if (!Number.isFinite(ms) || ms < 0) return '';
  const minutes = Math.round(ms / 60000);
  if (minutes < 1) return '刚刚提交';
  if (minutes < 60) return `已等待 ${minutes} 分钟`;
  return `已等待 ${(minutes / 60).toFixed(1)} 小时`;
}

function jobMetaText(job) {
  const parts = [];
  if (job.modeLabel) parts.push(job.modeLabel);
  parts.push(job.stateLabel || job.state);
  if (IN_PROGRESS.has(job.state)) {
    const elapsed = elapsedText(job); if (elapsed) parts.push(elapsed);
    const p = job.progress;
    if (p?.queue) parts.push(`排在第 ${p.queue.position} 位`);
    if (p?.totalPages) parts.push(`解析进度 ${p.extractedPages ?? 0}/${p.totalPages} 页`);
  } else if (job.error) {
    parts.push(job.error);
  } else if (job.hasMarkdown) {
    parts.push(job.jsonCount ? `${job.jsonCount} 个 JSON` : '仅 Markdown');
  }
  return parts.join(' · ');
}

// ── 列表渲染 ────────────────────────────────────────────────────────────────

/**
 * 构造一行。**这里不挂官方控件**：mountAppUi 要求宿元素已在 data-hana-app-ui
 * 作用域内（它用 closest() 检查祖先），游离节点找不到祖先会直接抛
 * APP_UI_SCOPE_REQUIRED。所以调用方先把行插进 DOM，再用 attachPick 挂勾选框。
 */
function buildRow(job) {
  const row = document.createElement('div');
  row.className = 'row';
  row.dataset.jobId = job.jobId;
  if (job.jobId === selectedJobId) row.classList.add('row-selected');
  if (job.state === 'failed') row.classList.add('row-failed');

  if (selectMode) {
    const pickHost = document.createElement('span');
    pickHost.className = 'row-pick';
    row.appendChild(pickHost);
  }

  const main = document.createElement('button');
  main.type = 'button';
  main.className = 'row-main';
  main.title = displayName(job);
  const name = document.createElement('span');
  name.className = 'row-name';
  name.textContent = displayName(job);
  const meta = document.createElement('span');
  meta.className = 'row-meta';
  meta.textContent = jobMetaText(job);
  main.append(name, meta);
  // 批量模式下点整行 = 勾选/取消，比只能点小方框好按。
  main.onclick = () => {
    if (selectMode) togglePick(job);
    else void select(job);
  };
  row.appendChild(main);

  // 右键菜单：三种入口（重命名 / 刷新 / 删除）聚到一处。
  // 不管什么模式都给：右键是明确的手势，而且这三个动作都是单条操作，与批量不冲突。
  row.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    openRowMenu(job, event.clientX, event.clientY);
  });

  if (!selectMode) {
    // 刷新：查询这一条的远端状态（原来在主卡右栏的“查询选中任务”）。
    // 顺序上排在删除左侧：先中性、后危险。
    const refresh = document.createElement('button');
    refresh.type = 'button';
    refresh.className = 'row-refresh';
    refresh.title = `刷新「${displayName(job)}」的状态`;
    refresh.setAttribute('aria-label', refresh.title);
    refresh.innerHTML = REFRESH_SVG;
    refresh.onclick = (event) => {
      event.stopPropagation();
      void refreshOne(job, refresh);
    };
    row.appendChild(refresh);

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'row-del';
    del.title = `删除「${displayName(job)}」`;
    del.setAttribute('aria-label', del.title);
    del.innerHTML = TRASH_SVG;
    del.onclick = (event) => {
      event.stopPropagation();
      void askDelete([job]);
    };
    row.appendChild(del);
  }

  return row;
}

/**
 * 查询一条任务的远端状态。
 *
 * 这是原来主卡右栏「查询选中任务」的搬移：职责上它属于「对某条记录做操作」，
 * 所以放在侧栏行内而不是主卡。刷新完要通知主卡，因为选中任务的状态可能变了。
 */
async function refreshOne(job, button) {
  if (button) { button.disabled = true; button.classList.add('busy'); }
  try {
    const result = await api(`jobs/${job.jobId}/refresh`, { method: 'POST' });
    const bits = [result.error ? '刷新失败' : `状态：${result.stateLabel || result.state}`];
    if (result.progress?.totalPages) {
      bits.push(`解析进度 ${result.progress.extractedPages ?? 0}/${result.progress.totalPages} 页`);
    }
    if (result.progress?.queue) bits.push(`排在第 ${result.progress.queue.position} 位`);
    notify(`${displayName(job)} · ${bits.join(' · ')}`, result.error ? 'error' : 'success');
  } catch (error) {
    notify(`${displayName(job)} · 刷新失败：${error?.message || String(error)}`, 'error');
  } finally {
    if (button) { button.disabled = false; button.classList.remove('busy'); }
    await loadJobs();
    // 状态可能变了，主卡需要重新取一次结果。
    await bumpRevision();
  }
}

function render() {
  for (const handle of handles) { try { handle.destroy(); } catch { /* 已销毁 */ } }
  handles = [];
  pickHandles.clear();
  const host = $('jobs');
  host.replaceChildren();

  if (!currentJobs.length) {
    const el = document.createElement('div');
    host.appendChild(el);
    handles.push(mountAppUi(el, 'EmptyState', {
      title: '还没有解析记录',
      description: '在主窗口选择文件开始解析，结果会出现在这里。',
    }));
  } else {
    for (const job of currentJobs) {
      const row = buildRow(job);
      // 先插入 DOM，再挂官方控件（挂载要求宿元素已在作用域内）。
      host.appendChild(row);
      if (selectMode) attachPick(row, job);
    }
  }

  renderHeader();
  renderBatchBar();
  renderSelectedActions();
}

/**
 * 选中项操作区：生成「引用 / 翻译」指令写进剪贴板。
 *
 * 位置在侧栏而不是主卡的硬原因：`clipboard.writeText` 的宿主白名单是
 * page / widget / settings / **function-panel**，而应用卡是 **card** 槽位。
 * 主卡里点复制会被拒（"not allowed in card slots"）。
 */
function renderSelectedActions() {
  const host = $('selectedActions');
  if (!host) return;
  // 多选模式下这一块是干扰：那时人在挑“一批”，不是“一条”。
  const job = selectMode ? null : currentJobs.find((item) => item.jobId === selectedJobId);
  if (!job) { host.hidden = true; clearCtrl('copyRefSlot'); clearCtrl('copyTranslateSlot'); return; }

  host.hidden = false;
  const name = $('selectedName');
  if (name) name.textContent = displayName(job);

  renderCtrl('copyRefSlot', 'Button', {
    variant: 'secondary', size: 'sm', children: '复制引用',
    title: '复制一段指令，粘到对话里让模型引用这份解析结果',
    onClick: () => { void copyRefInstruction(job); },
  });
  renderCtrl('copyTranslateSlot', 'Button', {
    variant: 'secondary', size: 'sm', children: '复制译文',
    title: '复制一段指令，粘到对话里让模型翻译这份结果并交付译文文件',
    onClick: () => { void copyTranslateInstruction(job); },
  });
}

/** 侧栏读不到主卡的 JS 变量，目标语言由主卡经 App 存储广播过来。 */
async function currentTargetLanguage() {
  try {
    const lang = await readStored(STORAGE_TARGET_LANG);
    if (typeof lang === 'string' && lang.trim()) return lang.trim();
  } catch { /* 读不到就用兵底值 */ }
  return '中文';
}

/**
 * 复制「引用解析结果」的指令。
 *
 * 注意这是一个**给模型看的**指令，不是文档内容本身：
 * 卡片自己没法把字节递进会话（见 MIGRATION.md 第五节），
 * 所以由人贴一句、模型据此调 reference_result 工具来完成。
 */
async function copyRefInstruction(job) {
  const text = `请调用 mineru-document-workbench_reference_result，jobId=${job.jobId}`
    + `，分析「${displayName(job)}」的解析结果。`;
  await writeClipboard(text, '引用指令已复制，粘到对话里即可');
}

/** 复制「获取译文」的指令。 */
async function copyTranslateInstruction(job) {
  const lang = await currentTargetLanguage();
  const text = `请用 MinerU 文档解析应用把已解析任务「${displayName(job)}」`
    + `（jobId: ${job.jobId}）的解析结果翻译为${lang}，并把译文 Markdown 作为附件交付给我。`;
  await writeClipboard(text, `译文获取指令已复制（${lang}）`);
}

async function writeClipboard(text, okMessage) {
  try {
    const result = await hana.clipboard.writeText({ text });
    if (result?.written === false) throw new Error('剪贴板未写入');
    notify(okMessage, 'success');
  } catch (error) {
    notify(error?.message || String(error), 'error');
  }
}

/** 在已入 DOM 的行上挂一个官方 Checkbox。 */
function attachPick(row, job) {
  const pickHost = row.querySelector('.row-pick');
  if (!pickHost) return;
  const handle = mountAppUi(pickHost, 'Checkbox', pickProps(job));
  pickHandles.set(job.jobId, handle);
  handles.push(handle);
}

function pickProps(job) {
  return {
    checked: pickedIds.has(job.jobId),
    'aria-label': `选择 ${displayName(job)}`,
    onChange: (checked) => {
      if (checked) pickedIds.add(job.jobId); else pickedIds.delete(job.jobId);
      syncPick(job);
    },
  };
}

/**
 * 切换一行的勾选态。
 *
 * 两件事是刻意这么写的：
 *  1. **不整表重渲染**。每次勾选都重建所有行会把控件换掉，连续勾选时第二次点击
 *     会打在旧节点上（实测：连点两个只中一个）。只更新这一行与底部操作条。
 *  2. **要把新状态回写给控件**。官方 Checkbox 是受控组件：只改自己的状态、
 *     不更新 props，React 会把 DOM 的勾选态复位——表现出来就是“行高亮了、
 *     勾选框却是空的”。
 */
function togglePick(job) {
  if (pickedIds.has(job.jobId)) pickedIds.delete(job.jobId); else pickedIds.add(job.jobId);
  syncPick(job);
}

function syncPick(job) {
  const row = document.querySelector(`.row[data-job-id="${job.jobId}"]`);
  if (row) row.classList.toggle('row-picked', pickedIds.has(job.jobId));
  const handle = pickHandles.get(job.jobId);
  if (handle) {
    try { handle.update(pickProps(job)); } catch { /* 该控件已被替换 */ }
  }
  renderBatchBar();
}

function renderHeader() {
  renderCtrl('selectModeSlot', 'Button', {
    variant: 'ghost',
    size: 'sm',
    children: selectMode ? '取消' : '多选',
    disabled: !currentJobs.length && !selectMode,
    onClick: () => {
      selectMode = !selectMode;
      if (!selectMode) pickedIds.clear();
      render();
    },
  });
  renderCtrl('reloadSlot', 'Button', {
    variant: 'ghost', size: 'sm', children: '刷新', onClick: loadJobs,
  });
}

function renderBatchBar() {
  const bar = $('batchBar');
  if (bar) bar.hidden = !selectMode;
  if (!selectMode) { clearCtrl('batchAllSlot'); clearCtrl('batchDeleteSlot'); return; }

  const total = currentJobs.length;
  const picked = pickedIds.size;
  $('batchText').textContent = picked ? `已选 ${picked} / ${total} 项` : `共 ${total} 项`;

  renderCtrl('batchAllSlot', 'Button', {
    variant: 'ghost',
    size: 'sm',
    children: picked === total && total > 0 ? '取消全选' : '全选',
    disabled: !total,
    onClick: () => {
      if (picked === total) pickedIds.clear();
      else for (const job of currentJobs) pickedIds.add(job.jobId);
      render();
    },
  });

  renderCtrl('batchDeleteSlot', 'Button', {
    variant: 'danger',
    size: 'sm',
    children: picked ? `删除 ${picked} 项` : '删除选中',
    disabled: !picked,
    onClick: () => {
      const jobs = currentJobs.filter((job) => pickedIds.has(job.jobId));
      if (jobs.length) void askDelete(jobs);
    },
  });
}

/**
 * 提示一律走宿主吐司，不再用页脚里的状态行。
 *
 * 为什么换：状态行是页脚的一部分，它一出现页脚就长高、一空就缩回去，
 * 布局跟着跳；而吐司浮在上层、不参与布局，几秒后自己消失。
 *
 * `toast.show` 在 function-panel 槽位是允许的，且 `requiresGrant: false`
 * （实测宿主能力表），所以不需要新增任何能力声明。
 * 宿主默认时长是 5000ms，这里统一传 3000。
 */
const TOAST_MS = 3000;

function notify(message, type = 'info') {
  // 吐司是转瞬即逝的界面反馈：显示失败不应该反过来影响操作本身。
  // 所以吞掉异常，只记一条 console 便于排查。
  hana.toast.show({ message, type, duration: TOAST_MS }).catch((error) => {
    console.warn('[mineru] toast 未显示：', error?.message || error, message);
  });
}

// ── 确认浮层 ────────────────────────────────────────────────────────────────

let pendingConfirm = null;

function openConfirm(text, confirmLabel, onConfirm) {
  const modal = $('modal');
  if (!modal) return;
  $('modalText').textContent = text;
  modal.hidden = false;
  pendingConfirm = onConfirm;

  renderCtrl('modalActions', 'Inline', {
    gap: 'sm',
    children: [
      appUi('Button', {
        variant: 'secondary', size: 'sm', children: '取消',
        onClick: closeConfirm,
      }),
      appUi('Button', {
        variant: 'danger', size: 'sm', children: confirmLabel,
        onClick: () => {
          const run = pendingConfirm;
          closeConfirm();
          if (run) void run();
        },
      }),
    ],
  });
}

function closeConfirm() {
  pendingConfirm = null;
  const modal = $('modal');
  if (modal) modal.hidden = true;
  clearCtrl('modalActions');
  clearCtrl('modalField');
  const field = $('modalField');
  if (field) field.hidden = true;
}

// ── 行右键菜单 ──────────────────────────────────────────────────────────────

/** 当前右键的是哪一条（菜单项被点时要用）。 */
let rowMenuJob = null;
/** 菜单控件的句柄，关时销毁。 */
let rowMenuHandle = null;

/**
 * 在某条记录上右键时弹出的菜单。
 *
 * 用官方 `ContextMenu` 控件，实测过两件事（都写在 MIGRATION.md）：
 *   · 它包在一个 `position: fixed` 层里，挂载点本身不占布局，
 *     所以不会把列表/页脚挤动；
 *   · 它自带边界调整——把 (180,290) 这种靠边坐标贴到视口内，
 *     对只有 190px 宽的侧栏 iframe 很关键。
 * 因此不需要自己夹取坐标。
 *
 * 菜单项与行内图标重叠（刷新/删除各有一个入口）：行内图标负责“看得见”，
 * 右键负责“一处分全”，而且重命名只有这里有。
 */
function openRowMenu(job, x, y) {
  const host = $('rowMenuMount');
  if (!host) return;
  closeRowMenu();
  rowMenuJob = job;

  // ContextMenu 的定位每次都要重建：走 renderCtrl 的话同类型会走 update，
  // 而 update 不会重新定位（试出来的）。
  const el = document.createElement('div');
  host.appendChild(el);
  try {
    const handle = mountAppUi(el, 'ContextMenu', {
      items: [
        { id: 'rename', label: '重命名', action: () => { void askRename(job); } },
        { id: 'refresh', label: '刷新状态', action: () => { void refreshOne(job, null); } },
        { id: 'delete', label: '删除记录', danger: true, action: () => { void askDelete([job]); } },
      ],
      position: { x, y },
      onClose: () => { closeRowMenu(); },
    });
    rowMenuHandle = handle;
  } catch (error) {
    // 菜单装不出来不该让行右键彻底失效：报一句比静默好。
    el.remove();
    notify(`无法打开菜单：${error?.message || error}`, 'error');
  }
}

function closeRowMenu() {
  rowMenuJob = null;
  const host = $('rowMenuMount');
  if (!host) return;
  if (rowMenuHandle) {
    try { rowMenuHandle.destroy(); } catch { /* 已销毁 */ }
    rowMenuHandle = null;
  }
  host.replaceChildren();
}

// ── 重命名 ──────────────────────────────────────────────────────────────────

/** 重命名输入框的受控值（官方控件是受控的，必须回写后再 update）。 */
let renameDraft = '';

function askRename(job) {
  const current = displayName(job);
  openPrompt({
    text: `重命名「${current}」`,
    value: current,
    confirmLabel: '保存',
    onConfirm: async (next) => {
      const name = String(next || '').trim();
      if (!name) { notify('名称不能为空', 'error'); return; }
      // 名字没变就什么都不做：不必白跑一趟后端，也无需提示。
      if (name === current) return;
      try {
        const result = await api(`jobs/${job.jobId}/rename`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ fileName: name }),
        });
        // 列表要重拉（新名字）；侧栏与主卡都据此更新。
        await loadJobs();
        await bumpRevision();
        notify(`已重命名为「${result.fileName || name}」`, 'success');
      } catch (error) {
        notify(error?.message || String(error), 'error');
      }
    },
  });
}

/**
 * 带一个输入框的确认浮层。
 *
 * 复用已有的页内确认框（iframe 无 allow-modals，window.prompt 不可用），
 * 只是多挂一个官方 TextInput。输入时更新 renameDraft 再重渲染，
 * 而 renderCtrl 对同类型控件走 update，所以焦点不会丢。
 */
function openPrompt({ text, value, confirmLabel, onConfirm }) {
  const modal = $('modal');
  if (!modal) return;
  $('modalText').textContent = text;
  renameDraft = value;
  modal.hidden = false;

  const field = $('modalField');
  if (field) field.hidden = false;
  wirePromptInput();

  pendingConfirm = () => onConfirm(renameDraft);
  renderCtrl('modalActions', 'Inline', {
    gap: 'sm',
    children: [
      appUi('Button', { variant: 'secondary', size: 'sm', children: '取消', onClick: closeConfirm }),
      appUi('Button', { variant: 'primary', size: 'sm', children: confirmLabel, onClick: submitPrompt }),
    ],
  });
  // 聚焦并全选，方便直接改。
  const input = $('modalField')?.querySelector('input');
  if (input) { input.focus(); input.select(); }
}

/**
 * 挂（或重挂）输入控件，让受控值与 renameDraft 始终一致。
 *
 * 每次输入都重挂一次：renderCtrl 对同类型控件走 `update`，
 * 所以重挂不会丢焦点；而重挂是必要的，因为 onChange 是闭包，
 * 只 update 不重挂就会一直引用到最初那份值。
 */
function wirePromptInput() {
  return renderCtrl('modalField', 'TextInput', {
    value: renameDraft,
    'aria-label': '新名称',
    onChange: (event) => {
      renameDraft = event.target.value;
      wirePromptInput();
    },
    onKeyDown: (event) => {
      if (event.key === 'Enter') { event.preventDefault(); submitPrompt(); }
    },
  });
}

function submitPrompt() {
  const run = pendingConfirm;
  closeConfirm();
  if (run) void run();
}

// ── 删除 ────────────────────────────────────────────────────────────────────

/**
 * 弹出确认。单条会先问一次删除预览（带上结果文件体积）；批量只报条数。
 */
async function askDelete(jobs) {
  if (!jobs.length) return;

  if (jobs.length === 1) {
    const job = jobs[0];
    const inProgress = IN_PROGRESS.has(job.state);
    let detail = '将一并删除记录与该任务的解析结果文件。';
    try {
      const info = await api(`jobs/${job.jobId}/deletion-preview`);
      if (info?.hasResults) detail = `将一并删除记录与解析结果文件（约 ${formatBytes(info.totalBytes)}）。`;
    } catch { /* 预览失败不阻止删除，用默认说明 */ }
    const warn = inProgress
      ? '该任务仍在进行中，删除后无法再查询进度；远程任务不会被中止。'
      : '';
    openConfirm(`删除「${displayName(job)}」？${warn}${detail}`, '删除', () => deleteJobs([job]));
    return;
  }

  const count = jobs.length;
  const running = jobs.filter((job) => IN_PROGRESS.has(job.state)).length;
  const warn = running ? `其中 ${running} 项仍在进行中，删除后无法再查询进度；远程任务不会被中止。` : '';
  openConfirm(`删除选中的 ${count} 项？${warn}将一并删除这些记录及其解析结果文件。`, `删除 ${count} 项`, () => deleteJobs(jobs));
}

async function deleteJobs(jobs) {
  let ok = 0;
  const failed = [];
  for (const job of jobs) {
    try {
      await api(`jobs/${job.jobId}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        // 进行中的任务需要 force，否则服务端会返回 409。
        body: JSON.stringify({ force: IN_PROGRESS.has(job.state) }),
      });
      ok += 1;
      pickedIds.delete(job.jobId);
    } catch (error) {
      failed.push(`${displayName(job)}：${error?.message || error}`);
    }
  }

  // 失败要报：不报的话用户会以为都删干净了。
  // 全部成功不报：行已经从列表里消失，删除本身就是反馈。
  if (failed.length) {
    notify(`已删除 ${ok} 项，${failed.length} 项失败：${failed[0]}`, 'error');
  }

  if (selectedJobId && jobs.some((job) => job.jobId === selectedJobId)) {
    selectedJobId = null;
    await hana.storage.global.set(STORAGE_SELECTED, null);
  }
  if (!currentJobs.length) selectMode = false;

  await loadJobs();
  await bumpRevision();
}

// ── 选中与同步 ──────────────────────────────────────────────────────────────

async function select(job) {
  if (selectMode) return;
  selectedJobId = job.jobId;
  render();
  // 主卡在监听这个键：它负责把结果加载出来。
  await hana.storage.global.set(STORAGE_SELECTED, job.jobId);
  // 选中不提示：选中项操作区已经在显示文件名了，再弹一个吐司是重复信息。
}

async function loadJobs() {
  try {
    const data = await api('jobs');
    currentJobs = Array.isArray(data.jobs) ? data.jobs : [];

    const alive = new Set(currentJobs.map((job) => job.jobId));
    for (const id of [...pickedIds]) if (!alive.has(id)) pickedIds.delete(id);

    if (selectedJobId && !alive.has(selectedJobId)) {
      selectedJobId = null;
      await hana.storage.global.set(STORAGE_SELECTED, null);
    } else {
      const fromStore = await readStored(STORAGE_SELECTED);
      if (typeof fromStore === 'string') selectedJobId = fromStore;
    }

    render();
  } catch (error) {
    notify(error?.message || String(error), 'error');
  }
}

/** 告诉其它页面（主卡）列表变了。用递增计数，避免同一毫秒内的两次改动被当成一次。 */
async function bumpRevision() {
  try {
    const prev = await readStored(STORAGE_REVISION);
    await hana.storage.global.set(STORAGE_REVISION, (typeof prev === 'number' ? prev : 0) + 1);
  } catch { /* 通知失败不影响本地刷新 */ }
}

// ── 初始化 ──────────────────────────────────────────────────────────────────

async function main() {
  const stored = await readStored(STORAGE_SELECTED);
  if (typeof stored === 'string') selectedJobId = stored;

  // 点浮层背景或按 Esc 关闭（页内浮层自己处理，没有原生模态可依靠）。
  $('modal')?.addEventListener('click', (event) => {
    if (event.target === $('modal') || event.target.classList.contains('modal-backdrop')) closeConfirm();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !$('modal')?.hidden) closeConfirm();
  });

  await loadJobs();

  // 主卡新建或删除任务后会改这个键，这里跟着重拉。
  hana.storage.global.onChanged((keys) => {
    if (!Array.isArray(keys)) return;
    if (keys.includes(STORAGE_REVISION)) void loadJobs();
    if (keys.includes(STORAGE_SELECTED)) {
      void (async () => {
        const next = await readStored(STORAGE_SELECTED);
        const id = typeof next === 'string' ? next : null;
        if (id !== selectedJobId) { selectedJobId = id; render(); }
      })();
    }
  });

  hana.ready();
}

main();
