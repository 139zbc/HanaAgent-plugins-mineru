// 单条任务记录的操作（目前是删除）。
//
// 单独成文件的原因有两点：
//  1) 记录删除是破坏性操作，值得独立测试；
//  2) 新文件名不触发宿主的共享模块缓存问题（见 docs/hana-source-findings.md）。
//     修改本文件时请新建 job-actions.v3.js，更新所有导入方，并删除旧文件。

import fs from "node:fs/promises";
import path from "node:path";
import { isSafeResultId, getJob } from "./job-store.v6.js";

const IN_PROGRESS_STATES = new Set([
  "pending", "running", "converting", "uploading", "waiting-file", "submitting",
]);

/**
 * 归一化任务状态。
 *
 * `submitting` 且没有 batchId 的记录是「提交中途被打断」的残留：它永远不会再推进，
 * 也不可能有结果。listJobs 已把它显示为 `interrupted_before_batch_id`；
 * 这里做同样处理，避免删除时把它误判成进行中任务而要求强制删除。
 */
export function effectiveState(job) {
  const state = job?.state || "unknown";
  if (state === "submitting" && !job?.batchId) return "interrupted_before_batch_id";
  return state;
}

export function isInProgressState(state) {
  return IN_PROGRESS_STATES.has(state);
}

export function isInProgressJob(job) {
  return isInProgressState(effectiveState(job));
}

/** 目录是否位于 dataDir/recovered 之下（防越界删除）。 */
function recoveredDirFor(dataDir, taskId) {
  if (!isSafeResultId(taskId)) return null;
  const root = path.resolve(dataDir, "recovered");
  const target = path.resolve(root, taskId);
  if (target === root || !target.startsWith(`${root}${path.sep}`)) return null;
  return target;
}

function jobDirFor(dataDir, jobId) {
  if (!isSafeResultId(jobId)) return null;
  const root = path.resolve(dataDir, "jobs");
  const target = path.resolve(root, jobId);
  if (target === root || !target.startsWith(`${root}${path.sep}`)) return null;
  return target;
}

async function dirSize(dir) {
  let total = 0;
  let entries;
  try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return 0; }
  for (const entry of entries) {
    const child = path.join(dir, entry.name);
    if (entry.isDirectory()) total += await dirSize(child);
    else if (entry.isFile()) {
      try { total += (await fs.stat(child)).size; } catch { /* 忽略统计失败 */ }
    }
  }
  return total;
}

/**
 * 预览删除会做什么（不修改任何东西），供确认界面使用。
 * 返回 null 表示任务不存在。
 */
export async function describeDeletion(dataDir, jobId) {
  if (!isSafeResultId(jobId)) return null;
  const job = await getJob(dataDir, jobId);
  if (!job) return null;
  const jobDir = jobDirFor(dataDir, jobId);
  const resultDir = job.batchId ? recoveredDirFor(dataDir, job.batchId) : null;
  const [jobBytes, resultBytes] = await Promise.all([
    jobDir ? dirSize(jobDir) : 0,
    resultDir ? dirSize(resultDir) : 0,
  ]);
  return {
    jobId,
    fileName: job.fileName || "未命名文件",
    state: effectiveState(job),
    inProgress: isInProgressJob(job),
    jobBytes,
    resultBytes,
    totalBytes: jobBytes + resultBytes,
    hasResults: Boolean(resultDir && resultBytes > 0),
  };
}

/**
 * 删除一条任务记录，并连带删除该任务的结果文件。
 *
 * 只删记录会留下无法再访问的孤儿结果文件，所以两者一起清。
 * 进行中的任务默认拒绝删除；调用方需显式传 allowActive（界面应先警告：
 * 远程任务仍在跑，删除后无法再查询）。
 *
 * 返回 { ok, jobId, fileName, jobBytes, resultBytes } 或 { ok:false, reason }。
 * reason: "invalid_id" | "not_found" | "active"
 */
export async function deleteJob(dataDir, jobId, { allowActive = false } = {}) {
  if (!isSafeResultId(jobId)) return { ok: false, reason: "invalid_id" };
  const job = await getJob(dataDir, jobId);
  if (!job) return { ok: false, reason: "not_found" };
  if (isInProgressJob(job) && !allowActive) {
    return { ok: false, reason: "active", state: effectiveState(job) };
  }

  const jobDir = jobDirFor(dataDir, jobId);
  if (!jobDir) return { ok: false, reason: "invalid_id" };
  const resultDir = job.batchId ? recoveredDirFor(dataDir, job.batchId) : null;

  const [jobBytes, resultBytes] = await Promise.all([
    dirSize(jobDir),
    resultDir ? dirSize(resultDir) : 0,
  ]);

  // 先删结果再删记录：即使中途失败，也不会留下"记录已删、结果成孤儿"的状态。
  if (resultDir) await fs.rm(resultDir, { recursive: true, force: true });
  await fs.rm(jobDir, { recursive: true, force: true });

  return { ok: true, jobId, fileName: job.fileName || null, jobBytes, resultBytes };
}
