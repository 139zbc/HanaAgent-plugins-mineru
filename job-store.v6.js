import fs from "node:fs/promises";
import path from "node:path";

// NOTE: 版本化文件名（v6）是刻意的。Hana 的插件 reload 只对工具入口做 ESM 缓存破除，
// 共享模块会一直沿用进程首次加载的内容（见 docs/hana-source-findings.md）。
// 修改本文件时请改为下一个版本号（job-store.v7.js），并同步所有导入方。

const JOB_ID = /^[a-f0-9-]{36}$/i;
// 结果目录名（= 精准通道的 batch_id 或轻量通道的 task_id）。
// 精准通道是严格 UUID；轻量通道的 task_id 形如 UUID 但最后一段是 13–14 位十六进制
// （实测：11556203-2a18-46cc-9e2a-54843cd14bdc12），所以放宽最后一段长度。
// 仍保留「UUID 形或足够长的安全 token」两道门，短错字（如 not-a-batch）不会通过，
// 因此不会因拼错就去打外部服务。
const UUID_LIKE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12,16}$/i;
const SAFE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9_-]{15,127}$/;

export function isSafeResultId(value) {
  return typeof value === "string"
    && !value.includes("..")
    && (UUID_LIKE.test(value) || SAFE_TOKEN.test(value));
}

const STATE_LABELS = Object.freeze({
  pending: "排队中",
  running: "解析中",
  converting: "格式转换中",
  uploading: "文件上传中",
  "waiting-file": "等待文件上传",
  done: "已完成",
  failed: "解析失败",
  submitting: "提交中",
  interrupted_before_batch_id: "已中断（未取得任务号）",
});

export function jobStateLabel(state) {
  if (!state) return "未知";
  return STATE_LABELS[state] || String(state);
}

export function resultPath(dataDir, batchId, filePath) {
  if (!isSafeResultId(batchId) || typeof filePath !== "string") throw new Error("Invalid result identity");
  const root = path.resolve(dataDir, "recovered", batchId);
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(`${root}${path.sep}`)) throw new Error("Result path outside plugin data");
  return resolved;
}

/**
 * 解析历史记录里保存的结果文件路径。
 *
 * 记录里的路径是写入时的绝对路径；如果插件数据目录发生变化（例如从 dev 数据目录
 * 迁移到正式数据目录），旧路径会落在当前目录之外。此时按同名文件在当前的
 * `recovered/<batchId>/` 下重新定位，而不是直接判为非法——文件本身往往已经迁移过来了。
 *
 * 找不到时返回 null，由调用方决定降级方式（不抛异常）。
 */
export async function resolveStoredResultPath(dataDir, batchId, storedPath) {
  if (!isSafeResultId(batchId) || typeof storedPath !== "string") return null;
  const root = path.resolve(dataDir, "recovered", batchId);
  const resolved = path.resolve(storedPath);
  if (resolved === root || resolved.startsWith(`${root}${path.sep}`)) {
    try { await fs.access(resolved); return resolved; } catch { /* fall through to rebase */ }
  }
  const candidate = path.join(root, path.basename(resolved));
  try { await fs.access(candidate); return candidate; } catch { return null; }
}

export async function findJobByBatch(dataDir, batchId) {
  if (!isSafeResultId(batchId)) throw new Error("Invalid batchId");
  const root = path.join(dataDir, "jobs");
  const entries = await fs.readdir(root, { withFileTypes: true }).catch((error) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  for (const entry of entries) {
    if (!entry.isDirectory() || !JOB_ID.test(entry.name)) continue;
    const job = await getJob(dataDir, entry.name);
    if (job?.batchId === batchId) return { jobId: entry.name, job };
  }
  return null;
}

export async function updateJob(dataDir, jobId, patch) {
  if (!JOB_ID.test(jobId || "")) throw new Error("Invalid jobId");
  const previous = await getJob(dataDir, jobId);
  if (!previous) throw new Error("Job not found");
  const file = path.join(dataDir, "jobs", jobId, "metadata.json");
  const next = { ...previous, ...patch, updatedAt: new Date().toISOString() };
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    await fs.writeFile(temporary, JSON.stringify(next, null, 2), { flag: "wx" });
    await fs.rename(temporary, file);
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
  return next;
}

export async function localResult(dataDir, job) {
  if (job?.state !== "done" || !job.batchId || !job.markdownPath) return null;
  const markdownPath = await resolveStoredResultPath(dataDir, job.batchId, job.markdownPath);
  if (!markdownPath) return null;
  const jsonPaths = [];
  for (const file of job.jsonPaths || []) {
    const resolved = await resolveStoredResultPath(dataDir, job.batchId, file);
    if (resolved) jsonPaths.push(resolved);
  }
  const zipPath = job.zipPath ? await resolveStoredResultPath(dataDir, job.batchId, job.zipPath) : null;
  return { markdownPath, jsonPaths, zipPath };
}

/**
 * Normalize MinerU 的 extract_progress（running 状态下返回 extracted_pages /
 * total_pages / start_time）。函数可重复调用：已归一化的对象再传进来不会丢字段。
 */
export function normalizeProgress(progress, source = null) {
  const queue = normalizeQueue(source) || normalizeQueue(progress);
  if (!progress || typeof progress !== "object") return queue ? { extractedPages: null, totalPages: null, startTime: null, queue } : null;
  const extracted = toFiniteNumber(progress.extracted_pages ?? progress.extractedPages);
  const total = toFiniteNumber(progress.total_pages ?? progress.totalPages);
  const startTime = firstString(progress.start_time, progress.startTime);
  if (extracted === null && total === null && !queue && !startTime) return null;
  return { extractedPages: extracted, totalPages: total, startTime, queue };
}

/**
 * 从 MinerU 返回项中读取排队信息（如果它提供）。
 *
 * 现状：MinerU 公开 API（2026-09 实测）只返回 state / err_msg，网页控制台显示的
 * “当前排在第 N 位” 并未出现在公开接口里。这里做防御性兼容读取：一旦上游补上
 * 这些字段，界面无需改动就会显示队位；取不到时返回 null。
 */
export function normalizeQueue(source) {
  if (!source || typeof source !== "object") return null;
  const position = toFiniteNumber(
    source.queue_position ?? source.queuePosition ?? source.queue_idx
    ?? source.queueIndex ?? source.position ?? source.rank,
  );
  if (position === null) return null;
  return {
    position,
    ahead: toFiniteNumber(source.waiting_ahead ?? source.waitingAhead ?? source.tasks_ahead),
    total: toFiniteNumber(source.queue_total ?? source.queueTotal ?? source.queueLength),
  };
}

function toFiniteNumber(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function firstString(...values) {
  return values.find((value) => typeof value === "string" && value) || null;
}

/**
 * 清理旧任务及其结果。默认 dryRun = true，只报告将被删除的记录；
 * 且只处理已完成/失败的终态任务，不会删除 pending / running 等未完成任务。
 */
export async function pruneJobs(dataDir, { keep = 50, dryRun = true } = {}) {
  const keepCount = Number.isFinite(Number(keep)) ? Math.max(0, Math.floor(Number(keep))) : 50;
  const root = path.join(dataDir, "jobs");
  const entries = await fs.readdir(root, { withFileTypes: true }).catch((error) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  const records = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !JOB_ID.test(entry.name)) continue;
    const job = await getJob(dataDir, entry.name);
    records.push({ jobId: entry.name, job });
  }
  records.sort((a, b) => String(b.job?.createdAt || "").localeCompare(String(a.job?.createdAt || "")));
  const removed = [];
  for (const record of records.slice(keepCount)) {
    const state = record.job?.state;
    if (state !== "done" && state !== "failed") continue;
    removed.push({ jobId: record.jobId, batchId: record.job?.batchId || null, state });
    if (dryRun) continue;
    await fs.rm(path.join(root, record.jobId), { recursive: true, force: true });
    if (record.job?.batchId) {
      await fs.rm(path.join(dataDir, "recovered", record.job.batchId), { recursive: true, force: true });
    }
  }
  return removed;
}

function toRecord(jobId, job) {
  const rawState = job.state === "submitting" && !job.batchId ? "interrupted_before_batch_id" : (job.state || "unknown");
  return {
    jobId,
    batchId: job.batchId || null,
    fileName: job.fileName || "未命名文件",
    state: rawState,
    stateLabel: jobStateLabel(rawState),
    channel: job.channel || "precision",
    modelVersion: job.modelVersion || null,
    createdAt: job.createdAt || null,
    updatedAt: job.updatedAt || null,
    hasMarkdown: Boolean(job.markdownPath),
    jsonCount: job.jsonPaths?.length || 0,
    error: rawState === "failed" ? String(job.error || "解析失败").slice(0, 300) : null,
    progress: normalizeProgress(job.progress),
  };
}

export async function listJobs(dataDir) {
  const root = path.join(dataDir, "jobs");
  const entries = await fs.readdir(root, { withFileTypes: true }).catch((error) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  const jobs = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const job = await getJob(dataDir, entry.name);
    if (!job) continue;
    jobs.push(toRecord(entry.name, job));
  }
  jobs.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  return jobs.slice(0, 100);
}

export async function getJob(dataDir, jobId) {
  if (!JOB_ID.test(jobId || "")) return null;
  const file = path.join(dataDir, "jobs", jobId, "metadata.json");
  try { return JSON.parse(await fs.readFile(file, "utf8")); } catch { return null; }
}

export async function previewJob(dataDir, jobId) {
  const job = await getJob(dataDir, jobId);
  if (!job) return null;
  const record = toRecord(jobId, job);
  let markdown = null;
  let json = null;
  if (job.state === "done" && typeof job.markdownPath === "string") {
    const markdownPath = await resolveStoredResultPath(dataDir, job.batchId, job.markdownPath);
    if (markdownPath) markdown = (await fs.readFile(markdownPath, "utf8")).slice(0, 300000);
    const preferred = (job.jsonPaths || []).find((file) => file.endsWith("_content_list.json")) || job.jsonPaths?.[0];
    if (preferred) {
      const jsonPath = await resolveStoredResultPath(dataDir, job.batchId, preferred);
      if (jsonPath) json = (await fs.readFile(jsonPath, "utf8")).slice(0, 300000);
    }
  }
  return { ...record, markdown, json };
}
