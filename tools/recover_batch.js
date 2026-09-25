import fs from "node:fs/promises";
import path from "node:path";
import { downloadResult } from "../mineru-client.js";
import { findJobByBatch, isSafeResultId, jobStateLabel, localResult, normalizeProgress, normalizeQueue, updateJob } from "../job-store.v6.js";
import { CHANNELS, parseModeLabel } from "../parse-options.v2.js";
import { queryByChannel, downloadAgentMarkdown } from "../parse-channels.v1.js";

export const name = "recover_batch";
export const description = "Recover a MinerU task (precision batch id or lightweight agent task id). Completed results are served from plugin storage without calling MinerU again.";
export const parameters = {
  type: "object",
  properties: {
    batchId: { type: "string", description: "精准通道的 batch_id，或轻量通道的 task_id" },
  },
  required: ["batchId"],
};
export const sessionPermission = {
  kind: "external_side_effect",
  describeSideEffect: () => ({
    kind: "external_network_upload",
    summary: "Read saved MinerU results or query an existing task and stage its result files.",
    ruleId: "mineru-recover-batch",
  }),
};

async function deliver(ctx, taskId, result) {
  const staged = [];
  for (const filePath of [result.markdownPath, ...result.jsonPaths]) {
    const item = ctx.stageFile({
      sessionId: ctx.sessionId,
      sessionRef: ctx.sessionRef,
      sessionPath: ctx.sessionPath,
      filePath,
      label: path.basename(filePath),
    });
    staged.push(item.mediaItem);
  }
  const size = (await fs.stat(result.markdownPath)).size;
  const jsonNote = result.jsonPaths.length ? `${result.jsonPaths.length} JSON file(s)` : "Markdown only";
  return {
    content: [{ type: "text", text: `Recovered MinerU task ${taskId}: Markdown ${size} bytes, ${jsonNote}.` }],
    details: { media: { items: staged } },
  };
}

export async function execute(input, ctx) {
  const taskId = input?.batchId;
  if (typeof taskId !== "string" || !isSafeResultId(taskId)) {
    throw new Error("Invalid batchId");
  }
  if (!ctx.sessionId || !ctx.stageFile) throw new Error("Current session is required for file delivery");

  const found = await findJobByBatch(ctx.dataDir, taskId);
  const saved = found ? await localResult(ctx.dataDir, found.job) : null;
  if (saved) return deliver(ctx, taskId, saved);

  // 通道决定查询方式：本地任务记录里存了 channel；查不到时按精准通道处理。
  const channel = found?.job?.channel || CHANNELS.PRECISION;
  const modeLabel = parseModeLabel(found?.job?.modeId || found?.job?.modelVersion) || (channel === CHANNELS.AGENT ? "Agent" : "MinerU");
  const apiToken = await ctx.config.get("apiToken");
  if (channel !== CHANNELS.AGENT && (typeof apiToken !== "string" || !apiToken)) {
    throw new Error("MinerU token missing from plugin configuration");
  }

  const snapshot = await queryByChannel(ctx, {
    channel,
    taskId,
    apiToken: typeof apiToken === "string" ? apiToken : null,
  });

  if (snapshot.failed) {
    const message = String(snapshot.error || "MinerU parsing failed").slice(0, 300);
    if (found) await updateJob(ctx.dataDir, found.jobId, { state: "failed", error: message });
    throw new Error(message);
  }

  if (!snapshot.done) {
    const progress = snapshot.item ? normalizeProgress(snapshot.item.extract_progress, snapshot.item) : null;
    if (found) await updateJob(ctx.dataDir, found.jobId, { state: snapshot.state || "pending", progress });
    const label = jobStateLabel(snapshot.state);
    const createdAt = found?.job?.createdAt;
    const minutes = createdAt ? Math.max(0, Math.round((Date.now() - Date.parse(createdAt)) / 60000)) : null;
    const queue = normalizeQueue(snapshot.item) || progress?.queue || null;
    const parts = [`${modeLabel} 任务 ${taskId} 仍在${label}`];
    if (minutes !== null) parts.push(`已等待约 ${minutes} 分钟`);
    if (progress?.totalPages) parts.push(`解析进度 ${progress.extractedPages ?? 0}/${progress.totalPages} 页`);
    if (queue) parts.push(`当前排在第 ${queue.position} 位`);
    return `${parts.join("，")}。稍后再调用 recover_batch 查询。`;
  }

  const outputDir = path.join(ctx.dataDir, "recovered", taskId);
  const extracted = channel === CHANNELS.AGENT
    ? await downloadAgentMarkdown(ctx, snapshot.markdownUrl, outputDir)
    : await downloadResult(ctx, snapshot.result, outputDir);

  if (found) await updateJob(ctx.dataDir, found.jobId, {
    state: "done",
    error: null,
    progress: null,
    markdownPath: extracted.markdownPath,
    jsonPaths: extracted.jsonPaths,
    zipPath: extracted.zipPath || null,
  });
  return deliver(ctx, taskId, extracted);
}
