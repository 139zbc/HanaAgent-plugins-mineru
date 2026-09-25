import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { listJobs, previewJob, normalizeProgress, pruneJobs, jobStateLabel } from "../job-store.v6.js";
import { downloadResult } from "../mineru-client.js";
import { PARSE_MODES, CHANNELS, DEFAULT_PARSE_MODE, normalizeParseMode, modeFor, parseModeLabel, resolveConfiguredMode, modeRequiresToken, modeProvidesJson } from "../parse-options.v2.js";
import { submitByMode, queryByChannel, downloadAgentMarkdown } from "../parse-channels.v1.js";
import { renderMarkdown } from "../markdown-render.v2.js";
import { listResultFiles, createImageResolver, readResultAsset } from "../result-assets.v1.js";
import { deleteJob, describeDeletion } from "../job-actions.v2.js";
import { DEFAULT_TARGET_LANGUAGE } from "../translate.v3.js";

const extensions = new Set([".pdf", ".png", ".jpg", ".jpeg", ".jp2", ".webp", ".gif", ".bmp", ".doc", ".docx", ".ppt", ".pptx", ".xls", ".xlsx"]);
const validId = (value) => /^[a-f0-9-]{36}$/i.test(value || "");

// 允许在预览中直接展示的图片主机（与 manifest 的 network.allowedHosts 保持一致）。
const IMAGE_HOST_SUFFIXES = ["openxlab.org.cn", "aliyuncs.com"];

async function readJob(ctx, jobId) {
  const file = path.join(ctx.dataDir, "jobs", jobId, "metadata.json");
  try { return { job: JSON.parse(await fs.readFile(file, "utf8")), file }; } catch { return null; }
}

export default function registerJobRoutes(app, ctx) {
  // 供页面初始化：可选解析方式与当前模式（与插件设置里的 modelVersion 同一份存储）。
  app.get("/options", async (c) => {
    const stored = await ctx.config.get("modelVersion");
    const token = await ctx.config.get("apiToken");
    const targetLanguage = await ctx.config.get("translationTargetLanguage");
    return c.json({
      modes: PARSE_MODES,
      current: resolveConfiguredMode(stored),
      default: DEFAULT_PARSE_MODE,
      configured: typeof token === "string" && token.length > 0,
      channels: CHANNELS,
      defaultTargetLanguage: typeof targetLanguage === "string" && targetLanguage.trim() ? targetLanguage : DEFAULT_TARGET_LANGUAGE,
    });
  });

  app.get("/jobs", async (c) => {
    const jobs = await listJobs(ctx.dataDir);
    const enriched = jobs.map((job) => ({
      ...job,
      modeLabel: parseModeLabel(job.modelVersion) || parseModeLabel(job.channel === CHANNELS.AGENT ? "agent" : null),
    }));
    return c.json({ jobs: enriched });
  });

  app.get("/jobs/:jobId", async (c) => {
    const jobId = c.req.param("jobId");
    const found = await readJob(ctx, jobId);
    if (!found) return c.json({ error: "Job not found" }, 404);
    const record = await previewJob(ctx.dataDir, jobId);
    if (!record) return c.json({ error: "Job not found" }, 404);
    const mode = modeFor(found.job.modelVersion || (found.job.channel === CHANNELS.AGENT ? "agent" : null));
    const jsonAvailable = modeProvidesJson(mode.id);

    // 把 Markdown 渲染为 HTML，并把图片引用指向本插件的结果图片路由。
    let markdownHtml = null;
    if (typeof record.markdown === "string" && record.markdown) {
      const taskId = found.job.batchId || jobId;
      const available = await listResultFiles(ctx.dataDir, taskId);
      const resolveImage = createImageResolver({
        dataDir: ctx.dataDir,
        taskId,
        available,
        assetUrlFor: (rel) => `jobs/${encodeURIComponent(jobId)}/asset/${rel.split("/").map(encodeURIComponent).join("/")}`,
        allowedHostSuffixes: IMAGE_HOST_SUFFIXES,
      });
      markdownHtml = renderMarkdown(record.markdown, {
        resolveImage,
        // 轻量通道只回 Markdown，不提供图片；把原因说清楚，避免看起来像文件丢失。
        noteFor: found.job.channel === CHANNELS.AGENT
          ? (src, alt) => `（Agent 轻量通道只返回 Markdown，不提供图片文件：${alt || src}）`
          : (src, alt) => `（图片文件缺失：${alt || src}）`,
      });
    }

    return c.json({
      ...record,
      markdownHtml,
      modelVersion: found.job.modelVersion || null,
      channel: found.job.channel || CHANNELS.PRECISION,
      modeLabel: parseModeLabel(mode.id),
      jsonAvailable,
    });
  });

  // 结果图片。只能读取该任务结果目录下的图片文件，路径越界返回 404。
  app.get("/jobs/:jobId/asset/*", async (c) => {
    const jobId = c.req.param("jobId");
    if (!validId(jobId)) return c.json({ error: "Invalid job ID" }, 400);
    const found = await readJob(ctx, jobId);
    if (!found) return c.json({ error: "Job not found" }, 404);
    const taskId = found.job.batchId || jobId;

    // 从完整路径里取通配部分，避免依赖框架的通配参数命名。
    const rawPath = new URL(c.req.url).pathname;
    const marker = `/jobs/${jobId}/asset/`;
    const at = rawPath.indexOf(marker);
    const rel = at >= 0 ? rawPath.slice(at + marker.length) : "";
    if (!rel) return c.json({ error: "Missing asset path" }, 400);

    const asset = await readResultAsset(ctx.dataDir, taskId, rel);
    if (!asset) return c.json({ error: "Asset not found" }, 404);

    c.header("Content-Type", asset.contentType);
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Cross-Origin-Resource-Policy", "same-origin");
    c.header("Cache-Control", "private, max-age=600");
    // SVG 作为图片展示可以，但直接打开时不应具备脚本能力。
    if (asset.isSvg) c.header("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; sandbox");
    return c.body(asset.bytes);
  });

  // 清理旧任务。默认 dryRun=true，只报告将被删除的记录；
  // 只有显式传 { dryRun: false } 才会真正删除，且不会动未完成的任务。
  app.post("/jobs/prune", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const dryRun = body?.dryRun !== false;
    const removed = await pruneJobs(ctx.dataDir, { keep: body?.keep ?? 50, dryRun });
    return c.json({ dryRun, removed });
  });

  // 删除单条记录（含其结果文件）。DELETE 前先 GET 可以拿到“将要删除什么”的预览，
  // 供界面做二次确认（iframe 的 sandbox 不含 allow-modals，系统 confirm 不可用）。
  app.get("/jobs/:jobId/deletion-preview", async (c) => {
    const preview = await describeDeletion(ctx.dataDir, c.req.param("jobId"));
    return preview ? c.json(preview) : c.json({ error: "Job not found" }, 404);
  });

  app.delete("/jobs/:jobId", async (c) => {
    const jobId = c.req.param("jobId");
    const body = await c.req.json().catch(() => ({}));
    const force = body?.force === true;
    const result = await deleteJob(ctx.dataDir, jobId, { allowActive: force });
    if (result.ok) return c.json(result);
    if (result.reason === "invalid_id") return c.json({ error: "Invalid job ID" }, 400);
    if (result.reason === "not_found") return c.json({ error: "Job not found" }, 404);
    if (result.reason === "active") {
      return c.json({
        error: "该任务仍在进行中。删除后会丢失记录，且无法再查询进度。",
        reason: "active",
        state: result.state || null,
        stateLabel: jobStateLabel(result.state),
        requiresForce: true,
      }, 409);
    }
    return c.json({ error: "Delete failed" }, 500);
  });

  app.post("/jobs", async (c) => {
    try {
      const input = await c.req.json();
      if (!input?.source || typeof input.source !== "object") return c.json({ error: "Select a file first" }, 400);

      // 先验证模式，再读文件和 Token：非法入参快速失败，且不会触碰外部服务。
      const requestedRaw = input.modelVersion ?? input.mode;
      const hasRequested = requestedRaw !== undefined && requestedRaw !== null && requestedRaw !== "";
      const requested = hasRequested ? normalizeParseMode(requestedRaw) : null;
      if (hasRequested && !requested) return c.json({ error: `Unsupported parse mode: ${String(requestedRaw)}` }, 400);
      const mode = modeFor(requested || resolveConfiguredMode(await ctx.config.get("modelVersion")));

      const materialized = await ctx.resources.materialize(input.source);
      if (typeof materialized?.filePath !== "string") return c.json({ error: "Could not access selected file" }, 400);
      const fileName = String(input.fileName || path.basename(materialized.filePath));
      if (!extensions.has(path.extname(fileName).toLowerCase())) return c.json({ error: "Unsupported file type" }, 400);

      // 精准通道需要 Token；轻量通道不需要（这正是它的用途）。
      const apiToken = await ctx.config.get("apiToken");
      if (modeRequiresToken(mode.id) && (typeof apiToken !== "string" || !apiToken)) {
        return c.json({ error: "Configure MinerU API token first, or switch to 「Agent 轻量解析 API」 which needs no token" }, 400);
      }

      const submitted = await submitByMode(ctx, {
        filePath: materialized.filePath,
        fileName,
        modeId: mode.id,
        isOcr: Boolean(input.isOcr),
        apiToken: typeof apiToken === "string" ? apiToken : null,
      });

      // 记住用户这次的选择，下次打开页面默认选中同一方式。
      if (requested) { try { await ctx.config.set("modelVersion", requested); } catch { /* 配置写入失败不应中断解析 */ } }

      const jobId = crypto.randomUUID();
      const dir = path.join(ctx.dataDir, "jobs", jobId);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, "metadata.json"), JSON.stringify({
        jobId,
        batchId: submitted.batchId,
        fileName,
        source: input.source,
        state: "pending",
        channel: submitted.channel,
        modelVersion: submitted.channel === CHANNELS.AGENT ? null : submitted.modeId,
        modeId: submitted.modeId,
        isOcr: Boolean(input.isOcr),
        createdAt: new Date().toISOString(),
      }, null, 2));

      return c.json({
        jobId,
        batchId: submitted.batchId,
        state: "pending",
        stateLabel: jobStateLabel("pending"),
        channel: submitted.channel,
        modelVersion: submitted.modeId,
        modeLabel: submitted.modeLabel,
      }, 201);
    } catch (error) { return c.json({ error: error.message || "Submission failed" }, 400); }
  });

  app.post("/jobs/:jobId/refresh", async (c) => {
    const jobId = c.req.param("jobId");
    if (!validId(jobId)) return c.json({ error: "Invalid job ID" }, 400);
    const found = await readJob(ctx, jobId);
    if (!found) return c.json({ error: "Job not found" }, 404);
    const { job, file } = found;
    if (!job.batchId) return c.json({ error: "Job has no task ID" }, 409);
    if (job.state === "done") {
      return c.json({ jobId, state: "done", stateLabel: jobStateLabel("done"), error: null, progress: null });
    }
    const channel = job.channel || CHANNELS.PRECISION;
    try {
      const apiToken = await ctx.config.get("apiToken");
      if (channel !== CHANNELS.AGENT && (typeof apiToken !== "string" || !apiToken)) {
        return c.json({ error: "Configure MinerU API token first" }, 400);
      }
      const snapshot = await queryByChannel(ctx, {
        channel,
        taskId: job.batchId,
        apiToken: typeof apiToken === "string" ? apiToken : null,
      });

      if (snapshot.failed) {
        job.state = "failed"; job.error = snapshot.error; job.progress = null;
      } else if (snapshot.done) {
        const outputDir = path.join(ctx.dataDir, "recovered", job.batchId);
        const extracted = channel === CHANNELS.AGENT
          ? await downloadAgentMarkdown(ctx, snapshot.markdownUrl, outputDir)
          : await downloadResult(ctx, snapshot.result, outputDir);
        Object.assign(job, {
          state: "done",
          progress: null,
          error: null,
          markdownPath: extracted.markdownPath,
          jsonPaths: extracted.jsonPaths,
          zipPath: extracted.zipPath || null,
        });
      } else {
        job.state = snapshot.state || "pending";
        job.progress = snapshot.item ? normalizeProgress(snapshot.item.extract_progress, snapshot.item) : null;
      }
      job.updatedAt = new Date().toISOString();
      await fs.writeFile(file, JSON.stringify(job, null, 2));
      return c.json({
        jobId,
        state: job.state,
        stateLabel: jobStateLabel(job.state),
        error: job.error || null,
        progress: job.progress || null,
      });
    } catch (error) { return c.json({ error: error.message || "Refresh failed" }, 502); }
  });
}
