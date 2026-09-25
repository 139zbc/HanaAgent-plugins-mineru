import fs from "node:fs/promises";
import path from "node:path";
import { chunkMarkdown, reassemble, translateText, listChatModels, ensureModelAgent, readModelAgent, normalizeTargetLanguage, translationMaxTokens, MODEL_AGENT_ID } from "../translate.v3.js";
import { getJob, isSafeResultId, localResult, updateJob } from "../job-store.v6.js";
import { renderMarkdown } from "../markdown-render.v2.js";
import { listResultFiles, createImageResolver } from "../result-assets.v1.js";

const CHUNK_CHARS = 1800;
const CONCURRENCY = 2;
const MAX_PARALLEL_RUNS = 2;

// 进行中的翻译：jobId -> 状态。进程级内存态，插件 reload 后清空（可接受：翻译是即时任务）。
const runs = new Map();

function slugify(value) {
  const text = String(value ?? "").trim();
  const slug = text.replace(/[^\w\u4e00-\u9fa5-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32);
  return slug || "translated";
}

function runState(jobId) {
  return runs.get(jobId) || null;
}

async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

async function runTranslation(ctx, { jobId, taskId, targetLanguage, model, sourcePath }) {
  const run = runs.get(jobId);
  try {
    const markdown = await fs.readFile(sourcePath, "utf8");
    const pieces = chunkMarkdown(markdown, CHUNK_CHARS);
    const textPositions = pieces.map((piece, index) => ({ piece, index })).filter((item) => item.piece.kind === "text");
    if (!textPositions.length) throw new Error("该文档没有可翻译的正文（可能全是代码块）");

    run.total = textPositions.length;
    run.state = "running";

    const agentId = await ensureModelAgent(ctx, model);
    run.agentId = agentId;

    const translated = new Map();
    const failures = [];
    await mapWithConcurrency(textPositions, CONCURRENCY, async ({ piece, index }) => {
      if (run.cancelled) return;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const maxTokens = translationMaxTokens(piece.content.length, attempt);
          const text = await translateText(ctx, { text: piece.content, targetLanguage, agentId, maxTokens });
          translated.set(index, text);
          run.done += 1;
          run.current = index;
          return;
        } catch (error) {
          if (attempt === 1) {
            failures.push({ index, error: error?.message || String(error) });
            // 保留原文，保证整体文档仍可用
            translated.set(index, piece.content);
            run.done += 1;
          } else {
            await new Promise((resolve) => setTimeout(resolve, 800));
          }
        }
      }
    });

    if (run.cancelled) { run.state = "cancelled"; return; }

    const output = reassemble(pieces.map((piece, index) => (
      translated.has(index) ? { ...piece, content: translated.get(index) } : piece
    )));

    const outputDir = path.join(ctx.dataDir, "recovered", taskId);
    await fs.mkdir(outputDir, { recursive: true });
    const fileName = `translated.${slugify(targetLanguage)}.md`;
    const outputPath = path.join(outputDir, fileName);
    await fs.writeFile(outputPath, output, "utf8");

    const record = {
      lang: targetLanguage,
      file: fileName,
      modelId: model?.id || null,
      modelProvider: model?.provider || null,
      modelLabel: agentId ? `${model?.name || model?.id}（插件私有模型配置）` : "Hana 实用模型",
      failedChunks: failures.length,
      createdAt: new Date().toISOString(),
    };
    const job = await getJob(ctx.dataDir, jobId);
    const translations = (job?.translations || []).filter((item) => item.lang !== targetLanguage);
    translations.push(record);
    await updateJob(ctx.dataDir, jobId, { translations });

    run.state = failures.length ? "done_with_errors" : "done";
    run.outputPath = outputPath;
    run.fileName = fileName;
    run.failures = failures;
    run.finishedAt = new Date().toISOString();
  } catch (error) {
    run.state = "failed";
    run.error = error?.message || String(error);
    run.finishedAt = new Date().toISOString();
  }
}

export default function registerTranslateRoutes(app, ctx) {
  // 可选翻译模型：来自 Hana 已配置的聊天模型；current 来自插件私有 agent（上次实际使用的）
  app.get("/translation-models", async (c) => {
    let models = [];
    let error = null;
    let current = null;
    try { models = await listChatModels(ctx); }
    catch (err) { error = err?.message || String(err); }
    try { current = await readModelAgent(ctx); }
    catch { current = null; }
    return c.json({
      models: models.map((model) => ({ ...model, label: model.provider ? `${model.name}（${model.provider}）` : model.name })),
      current,
      agentId: MODEL_AGENT_ID,
      error,
    });
  });

  app.post("/jobs/:jobId/translate", async (c) => {
    const jobId = c.req.param("jobId");
    if (!isSafeResultId(jobId)) return c.json({ error: "Invalid job ID" }, 400);
    const body = await c.req.json().catch(() => ({}));
    const requested = typeof body?.targetLanguage === "string" ? body.targetLanguage.trim() : "";
    if (!requested) return c.json({ error: "请填写目标语言" }, 400);
    // 归一化语言名："English" 和 "英语" 要是同一份译文，不能各存一份
    const targetLanguage = normalizeTargetLanguage(requested) || requested;
    if (runs.get(jobId)?.state === "running") return c.json({ error: "该文档已有翻译在进行中" }, 409);
    const active = [...runs.values()].filter((run) => run.state === "running").length;
    if (active >= MAX_PARALLEL_RUNS) return c.json({ error: `同时最多翻译 ${MAX_PARALLEL_RUNS} 个文档，请稍后再试` }, 429);

    const job = await getJob(ctx.dataDir, jobId);
    if (!job) return c.json({ error: "Job not found" }, 404);
    if (job.state !== "done") {
      return c.json({ error: "该任务尚未解析完成，无法翻译" }, 409);
    }
    // 路径可能因数据目录迁移而失效，统一通过 localResult 重定位。
    const local = await localResult(ctx.dataDir, job);
    if (!local?.markdownPath) return c.json({ error: "解析结果文件已不在插件数据目录中（可能已被清理）" }, 409);

    const model = body?.model && typeof body.model === "object"
      ? { id: body.model.id || null, provider: body.model.provider || null, name: body.model.name || null }
      : null;

    // 记住目标语言。
    // 翻译模型不再写配置：它只存于插件页面的选择与私有 agent（真正生效的地方）。
    try {
      await ctx.config.set("translationTargetLanguage", targetLanguage);
    } catch (error) {
      ctx.log?.warn?.(`translation target language not persisted: ${error?.message || error}`);
    }

    runs.set(jobId, {
      state: "running", total: 0, done: 0, current: null, cancelled: false,
      targetLanguage, model, startedAt: new Date().toISOString(), failures: [],
    });

    // 后台执行，立即返回；页面用 GET 查询进度
    void runTranslation(ctx, { jobId, taskId: job.batchId || jobId, targetLanguage, model, sourcePath: local.markdownPath });

    return c.json({ jobId, state: "running", targetLanguage, model }, 202);
  });

  app.get("/jobs/:jobId/translate", async (c) => {
    const jobId = c.req.param("jobId");
    const run = runState(jobId);
    const job = await getJob(ctx.dataDir, jobId);
    const translations = job?.translations || [];
    // 已完成的译文列表必须一并返回：页面靠它填充语言下拉框。
    if (run) return c.json({ ...run, translations });
    return c.json({ state: "idle", translations });
  });

  app.post("/jobs/:jobId/translate/cancel", async (c) => {
    const run = runState(c.req.param("jobId"));
    if (!run || run.state !== "running") return c.json({ error: "没有进行中的翻译" }, 409);
    run.cancelled = true;
    return c.json({ ok: true, cancelled: true });
  });

  // 译文内容（含渲染后的 HTML，供页面展示）
  app.get("/jobs/:jobId/translation/:lang", async (c) => {
    const jobId = c.req.param("jobId");
    const lang = c.req.param("lang");
    if (!isSafeResultId(jobId)) return c.json({ error: "Invalid job ID" }, 400);
    const job = await getJob(ctx.dataDir, jobId);
    if (!job) return c.json({ error: "Job not found" }, 404);
    const record = (job.translations || []).find((item) => item.lang === lang);
    if (!record) return c.json({ error: "Translation not found" }, 404);

    const taskId = job.batchId || jobId;
    const root = path.resolve(ctx.dataDir, "recovered", taskId);
    const target = path.resolve(root, record.file);
    if (!target.startsWith(`${root}${path.sep}`)) return c.json({ error: "Invalid translation path" }, 400);

    let markdown;
    try { markdown = await fs.readFile(target, "utf8"); }
    catch { return c.json({ error: "译文文件不存在" }, 404); }

    const available = await listResultFiles(ctx.dataDir, taskId);
    const resolveImage = createImageResolver({
      dataDir: ctx.dataDir,
      taskId,
      available,
      assetUrlFor: (rel) => `jobs/${encodeURIComponent(jobId)}/asset/${rel.split("/").map(encodeURIComponent).join("/")}`,
      allowedHostSuffixes: ["openxlab.org.cn", "aliyuncs.com"],
    });
    return c.json({
      lang: record.lang,
      modelLabel: record.modelLabel || null,
      failedChunks: record.failedChunks || 0,
      markdown,
      markdownHtml: renderMarkdown(markdown, { resolveImage }),
    });
  });

  // 译文下载
  app.get("/jobs/:jobId/translation/:lang/download", async (c) => {
    const jobId = c.req.param("jobId");
    const lang = c.req.param("lang");
    if (!isSafeResultId(jobId)) return c.json({ error: "Invalid job ID" }, 400);
    const job = await getJob(ctx.dataDir, jobId);
    const record = (job?.translations || []).find((item) => item.lang === lang);
    if (!record) return c.json({ error: "Translation not found" }, 404);
    const taskId = job.batchId || jobId;
    const root = path.resolve(ctx.dataDir, "recovered", taskId);
    const target = path.resolve(root, record.file);
    if (!target.startsWith(`${root}${path.sep}`)) return c.json({ error: "Invalid translation path" }, 400);
    try {
      const markdown = await fs.readFile(target, "utf8");
      c.header("Content-Type", "text/markdown; charset=utf-8");
      c.header("Content-Disposition", `attachment; filename="${record.file}"`);
      return c.body(markdown);
    } catch { return c.json({ error: "译文文件不存在" }, 404); }
  });
}
