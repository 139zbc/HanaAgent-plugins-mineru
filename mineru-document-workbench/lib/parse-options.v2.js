// 解析方式（MinerU 通道 + 模型）定义。
//
// 这是共享模块，文件名带版本号是刻意的：Hana 的插件 reload 只对入口文件做 ESM
// 缓存破除，共享模块会沿用进程首次加载的内容（见 docs/hana-source-findings.md）。
// 修改本文件时请新建 parse-options.v3.js，更新所有导入方，并删除旧文件。

export const CHANNELS = Object.freeze({
  /** 精准解析 API：需要 Token，支持多格式、批量、ZIP（含 Markdown + JSON）。 */
  PRECISION: "precision",
  /** Agent 轻量解析 API：免 Token，单文件 ≤10MB / ≤20 页，仅返回 Markdown。 */
  AGENT: "agent",
});

export const AGENT_LIMITS = Object.freeze({
  maxBytes: 10 * 1024 * 1024,
  maxPages: 20,
  json: false,
  requiresToken: false,
});

export const PARSE_MODES = Object.freeze([
  Object.freeze({
    id: "vlm",
    label: "MinerU VLM",
    short: "VLM",
    channel: CHANNELS.PRECISION,
    modelVersion: "vlm",
    requiresToken: true,
    hint: "视觉大模型，官方推荐；复杂版式、公式与图表效果更好。需要 API Token。",
  }),
  Object.freeze({
    id: "pipeline",
    label: "MinerU",
    short: "MinerU",
    channel: CHANNELS.PRECISION,
    modelVersion: "pipeline",
    requiresToken: true,
    hint: "传统管线模型（pipeline），速度更快、输出更稳定。需要 API Token。",
  }),
  Object.freeze({
    id: "agent",
    label: "Agent 轻量解析 API（免 Token）",
    short: "Agent",
    channel: CHANNELS.AGENT,
    modelVersion: null,
    requiresToken: false,
    limits: AGENT_LIMITS,
    hint: "无需 API Token，未配置或 Key 不可用时可用。限制：单文件 ≤10MB、≤20 页，仅返回 Markdown（没有 JSON）。",
  }),
]);

export const DEFAULT_PARSE_MODE = "vlm";
export const AGENT_MODE_ID = "agent";

const MODES_BY_ID = new Map(PARSE_MODES.map((mode) => [mode.id, mode]));

// 兼容别名，统一归一到上面三个 id。
const ALIASES = Object.freeze({
  mineru: "pipeline",
  default: "pipeline",
  traditional: "pipeline",
  "mineru-pipeline": "pipeline",
  vision: "vlm",
  "vlm-engine": "vlm",
  "mineru-vlm": "vlm",
  // Agent 轻量通道的常见写法
  agent: "agent",
  "agent-api": "agent",
  "agent-light": "agent",
  lightweight: "agent",
  lite: "agent",
  nokey: "agent",
  "no-key": "agent",
  "no-token": "agent",
  "without-token": "agent",
});

const ALIAS_KEYS = new Map(Object.entries(ALIASES).map(([key, value]) => [key.toLowerCase(), value]));

/** 归一化用户输入；无法识别时返回 null（调用方应据此拒绝请求）。 */
export function normalizeParseMode(value) {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return null;
  if (MODES_BY_ID.has(normalized)) return normalized;
  return ALIAS_KEYS.get(normalized) || null;
}

/** 读取配置中的模式，非法或缺失时回退到默认值。 */
export function resolveConfiguredMode(value) {
  return normalizeParseMode(value) || DEFAULT_PARSE_MODE;
}

/** 按 id 取模式定义。 */
export function modeById(id) {
  const normalized = normalizeParseMode(id);
  return normalized ? MODES_BY_ID.get(normalized) : null;
}

/** 取模式定义，永不返回 null（回退默认模式）。 */
export function modeFor(value) {
  return modeById(value) || MODES_BY_ID.get(DEFAULT_PARSE_MODE);
}

export function parseModeLabel(id) {
  const mode = modeById(id);
  return mode ? mode.short : null;
}

/** 该模式是否需要 API Token。 */
export function modeRequiresToken(id) {
  const mode = modeById(id);
  return mode ? mode.requiresToken !== false : true;
}

/** 该模式是否只产出 Markdown（无 JSON）。 */
export function modeProvidesJson(id) {
  const mode = modeById(id);
  return !(mode?.limits && mode.limits.json === false);
}
