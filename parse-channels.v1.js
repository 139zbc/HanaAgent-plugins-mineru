// 解析通道实现：统一「精准解析 API」与「Agent 轻量解析 API」的提交/查询/取回。
//
// 这是共享模块，文件名带版本号是刻意的：Hana 的插件 reload 只对入口文件做 ESM
// 缓存破除，共享模块会沿用进程首次加载的内容（见 docs/hana-source-findings.md）。
// 修改本文件时请新建 parse-channels.v2.js，更新所有导入方，并删除旧文件。

import fs from "node:fs/promises";
import path from "node:path";
import { submitFile } from "./mineru-client.js";
import { CHANNELS, AGENT_LIMITS, modeFor, parseModeLabel } from "./parse-options.v2.js";

export { AGENT_LIMITS } from "./parse-options.v2.js";

const MAX_MARKDOWN_BYTES = 20 * 1024 * 1024;

// Agent 轻量接口的错误码 → 可读说明（文档「Agent 专属错误码」）。
const AGENT_ERROR_CODES = Object.freeze({
  "-30001": "文件大小超出轻量接口限制（10MB），请改用 MinerU VLM / MinerU 精准模式或拆分文件",
  "-30002": "轻量接口不支持该文件类型，请改用精准模式",
  "-30003": "文件页数超出轻量接口限制（20 页），请改用精准模式或指定页码范围",
  "-30004": "请求参数错误",
});

export function agentErrorText(code, fallback) {
  const key = code === undefined || code === null ? "" : String(code);
  return AGENT_ERROR_CODES[key] || (fallback ? String(fallback).slice(0, 300) : "Agent 轻量解析失败");
}

function baseUrlFrom(ctx, options) {
  return String(options.apiBaseUrl || "https://mineru.net").replace(/\/$/, "");
}

async function configValue(ctx, key, fallback) {
  const value = ctx.config?.get ? await ctx.config.get(key) : ctx.config?.[key];
  return value === undefined || value === null || value === "" ? fallback : value;
}

function apiUrl(base, suffix) {
  return `${base}${suffix}`;
}

async function readAgentBytes(filePath) {
  const stat = await fs.stat(filePath);
  if (stat.size > AGENT_LIMITS.maxBytes) {
    throw new Error(`Agent 轻量解析 API 单文件上限 10MB，当前 ${(stat.size / 1048576).toFixed(1)}MB；请改用 MinerU VLM / MinerU 精准模式`);
  }
  return new Uint8Array(await fs.readFile(filePath));
}

function assertAgentResponse(payload, label) {
  if (!payload || payload.code !== 0) {
    throw new Error(`${label} 失败：${payload?.msg || "未知错误"}${payload?.code ? `（code ${payload.code}）` : ""}`);
  }
  return payload.data;
}

// ── Agent 轻量解析 API ────────────────────────────────────────────────────────

/**
 * 申请签名上传地址。该接口**无需 Authorization**（免 Token 是它的设计目的）。
 *
 * 文档要求上传时不要设置 Content-Type；这里把 body 作为 Uint8Array 传递，
 * fetch 规范下不会自动附加 Content-Type，正是需要的形状。
 */
export async function submitAgentFile(ctx, filePath, fileName, options = {}) {
  const base = baseUrlFrom(ctx, options);
  const bytes = await readAgentBytes(filePath);
  const data = {
    file_name: fileName,
    language: options.language || "ch",
    enable_table: options.enableTable ?? true,
    enable_formula: options.enableFormula ?? true,
    is_ocr: options.isOcr ?? false,
  };
  if (options.pageRange) data.page_range = String(options.pageRange);

  const response = await ctx.network.fetch(apiUrl(base, "/api/v1/agent/parse/file"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
    timeoutMs: 60000,
  });
  if (!response.ok) throw new Error(`申请上传地址 HTTP ${response.status}`);
  const uploadData = assertAgentResponse(await response.json(), "申请上传地址");
  const uploadUrl = uploadData.file_url;
  if (!uploadData.task_id || !uploadUrl) throw new Error("Agent 轻量接口未返回 task_id 或 file_url");

  const uploadResponse = await ctx.network.fetch(uploadUrl, {
    method: "PUT",
    body: bytes,
    timeoutMs: 180000,
  });
  if (!uploadResponse.ok) {
    throw new Error(`上传文件 HTTP ${uploadResponse.status}（签名地址已过期或请求头不合规）`);
  }

  return { taskId: String(uploadData.task_id), fileName, bytes: bytes.byteLength };
}

/** 查询 Agent 轻量任务状态。 */
export async function getAgentResult(ctx, taskId, options = {}) {
  const base = baseUrlFrom(ctx, options);
  const response = await ctx.network.fetch(apiUrl(base, `/api/v1/agent/parse/${encodeURIComponent(taskId)}`), {
    method: "GET",
    timeoutMs: 60000,
  });
  if (!response.ok) throw new Error(`查询任务 HTTP ${response.status}`);
  return assertAgentResponse(await response.json(), "查询任务");
}

/** 归一化 Agent 状态，供上层复用同一套 UI/历史逻辑。 */
export function agentState(item) {
  const payload = item?.data ?? item ?? {};
  const state = typeof payload.state === "string" ? payload.state : "unknown";
  return {
    state,
    markdownUrl: typeof payload.markdown_url === "string" ? payload.markdown_url : null,
    errCode: payload.err_code ?? null,
    errMsg: payload.err_msg ?? "",
    raw: payload,
  };
}

/** 下载 Agent 结果的 Markdown 并落盘为 full.md。 */
export async function downloadAgentMarkdown(ctx, markdownUrl, outputDir) {
  if (typeof markdownUrl !== "string" || !markdownUrl) throw new Error("任务未返回 Markdown 链接");
  const response = await ctx.network.fetch(markdownUrl, { method: "GET", timeoutMs: 180000 });
  if (!response.ok) throw new Error(`下载 Markdown HTTP ${response.status}`);
  const declared = Number(response.headers.get("content-length"));
  if (declared > MAX_MARKDOWN_BYTES) throw new Error("Markdown 结果超出 20MB 上限");
  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > MAX_MARKDOWN_BYTES) throw new Error("Markdown 结果超出 20MB 上限");
  await fs.mkdir(outputDir, { recursive: true });
  const markdownPath = path.join(outputDir, "full.md");
  await fs.writeFile(markdownPath, text, "utf8");
  return { markdownPath, jsonPaths: [], zipPath: null };
}

// ── 统一入口 ─────────────────────────────────────────────────────────────────

/**
 * 按模式提交，返回统一结构。
 * 精度通道需要 Token；轻量通道不需要，因此 Token 缺失时只有轻量通道可用。
 */
export async function submitByMode(ctx, { filePath, fileName, modeId, isOcr = false, apiToken = null, options = {} }) {
  const mode = modeFor(modeId);
  if (mode.channel === CHANNELS.AGENT) {
    const submitted = await submitAgentFile(ctx, filePath, fileName, { ...options, isOcr });
    return {
      batchId: submitted.taskId,
      channel: CHANNELS.AGENT,
      modeId: mode.id,
      modeLabel: parseModeLabel(mode.id),
      bytes: submitted.bytes,
      jsonAvailable: false,
    };
  }
  const token = apiToken || await configValue(ctx, "apiToken");
  if (!token) throw new Error("MinerU API token is not configured（可改用「Agent 轻量解析 API」模式，无需 Token）");
  const submitted = await submitFile(ctx, filePath, fileName, {
    ...options,
    apiToken: token,
    isOcr,
    modelVersion: mode.modelVersion,
  });
  return {
    batchId: submitted.batchId,
    channel: CHANNELS.PRECISION,
    modeId: mode.id,
    modeLabel: parseModeLabel(mode.id),
    bytes: submitted.bytes,
    jsonAvailable: true,
  };
}

/**
 * 按通道查询一次状态。
 * 返回 { state, done, failed, error, progress, result }；
 * 当 done 且精度通道时，result 为可直接交给 downloadResult 的条目。
 */
export async function queryByChannel(ctx, { channel, taskId, apiToken = null }) {
  if (channel === CHANNELS.AGENT) {
    const payload = agentState(await getAgentResult(ctx, taskId));
    if (payload.state === "failed") {
      return { state: "failed", failed: true, error: agentErrorText(payload.errCode, payload.errMsg) };
    }
    if (payload.state === "done") {
      return { state: "done", done: true, markdownUrl: payload.markdownUrl };
    }
    return { state: payload.state };
  }
  const token = apiToken || await configValue(ctx, "apiToken");
  if (!token) throw new Error("MinerU API token is not configured");
  const snapshot = await (await import("./mineru-client.js")).getBatchResult(ctx, taskId, { apiToken: token });
  const items = Array.isArray(snapshot) ? snapshot : snapshot?.extract_result ?? snapshot?.results ?? [snapshot];
  if (!Array.isArray(items) || !items.length) throw new Error("MinerU returned no file results");
  const failed = items.find((item) => item.state === "failed");
  if (failed) return { state: "failed", failed: true, error: String(failed.err_msg || "MinerU parsing failed").slice(0, 300) };
  const completed = items.find((item) => item.state === "done" && item.full_zip_url);
  if (completed) return { state: "done", done: true, result: completed };
  return { state: items[0].state || "pending", item: items[0] };
}
