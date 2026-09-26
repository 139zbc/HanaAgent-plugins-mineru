import fs from "node:fs/promises";
import path from "node:path";
import { getJob, localResult, updateJob } from "../job-store.v6.js";
import { chunkMarkdown, reassemble, translateText, ensureModelAgent, readModelAgent, translationMaxTokens } from "../translate.v3.js";

export const name = "translate_result";
export const description = "Translate a finished MinerU parsing result into a target language using a chosen Hana provider model. Returns the translated Markdown.";
export const parameters = {
  type: "object",
  properties: {
    jobId: { type: "string", description: "已完成解析任务的 jobId" },
    targetLanguage: { type: "string", description: "目标语言，例如 中文 / English / 日本語" },
    model: {
      type: "object",
      description: "可选的翻译模型（Hana 供应商模型）。省略时使用插件已配置的翻译模型。",
      properties: { id: { type: "string" }, provider: { type: "string" } },
    },
  },
  required: ["jobId", "targetLanguage"],
};
export const sessionPermission = {
  kind: "plugin_output",
  describeSideEffect: () => ({
    kind: "session_file_output",
    summary: "Translate an existing parsing result with a Hana model and deliver the translated Markdown.",
    ruleId: "mineru-translate-result",
  }),
};

const ALLOWED_EXT = /\.(md|markdown)$/i;

export async function execute(input = {}, ctx) {
  const jobId = input.jobId;
  if (typeof jobId !== "string" || !/^[a-f0-9-]{36}$/i.test(jobId)) throw new Error("Invalid jobId");
  const targetLanguage = typeof input.targetLanguage === "string" ? input.targetLanguage.trim() : "";
  if (!targetLanguage) throw new Error("targetLanguage is required");

  const job = await getJob(ctx.dataDir, jobId);
  if (!job) throw new Error("Job not found");
  if (job.state !== "done") throw new Error("该任务尚未解析完成，无法翻译");
  // 路径可能因数据目录迁移而失效，统一通过 localResult 重定位。
  const local = await localResult(ctx.dataDir, job);
  if (!local?.markdownPath) throw new Error("解析结果文件已不在插件数据目录中（可能已被清理）");

  // 解析模型：调用方显式指定 > 插件页面上次选定的（存在插件私有 agent 里）> 会话默认模型
  let model = input.model && typeof input.model === "object"
    ? { id: input.model.id || null, provider: input.model.provider || null, name: null }
    : null;
  if (!model?.id) {
    const remembered = await readModelAgent(ctx);
    if (remembered?.id) model = { id: remembered.id, provider: remembered.provider || null, name: null };
  }

  const markdown = await fs.readFile(local.markdownPath, "utf8");
  const pieces = chunkMarkdown(markdown, 1800);
  const textPieces = pieces.filter((piece) => piece.kind === "text");
  if (!textPieces.length) throw new Error("该文档没有可翻译的正文（可能全是代码块）");

  const agentId = await ensureModelAgent(ctx, model);
  const translated = new Map();
  let failed = 0;
  for (let index = 0; index < pieces.length; index++) {
    const piece = pieces[index];
    if (piece.kind !== "text") continue;
    let done = false;
    for (let attempt = 0; attempt < 2 && !done; attempt++) {
      try {
        const maxTokens = translationMaxTokens(piece.content.length, attempt);
        translated.set(index, await translateText(ctx, { text: piece.content, targetLanguage, agentId, maxTokens }));
        done = true;
      } catch (error) {
        if (attempt === 1) {
          failed += 1;
          translated.set(index, piece.content);
        }
      }
    }
  }

  const output = reassemble(pieces.map((piece, index) => (
    translated.has(index) ? { ...piece, content: translated.get(index) } : piece
  )));

  const taskId = job.batchId || jobId;
  const outputDir = path.join(ctx.dataDir, "recovered", taskId);
  await fs.mkdir(outputDir, { recursive: true });
  const slug = targetLanguage.replace(/[^\w\u4e00-\u9fa5-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32) || "translated";
  const file = `translated.${slug}.md`;
  const outputPath = path.join(outputDir, file);
  await fs.writeFile(outputPath, output, "utf8");

  try {
    const record = {
      lang: targetLanguage,
      file,
      modelId: model?.id || null,
      modelProvider: model?.provider || null,
      modelLabel: agentId ? `${model?.id}（插件私有模型配置）` : "Hana 实用模型",
      failedChunks: failed,
      createdAt: new Date().toISOString(),
    };
    const translations = (job.translations || []).filter((item) => item.lang !== targetLanguage);
    translations.push(record);
    await updateJob(ctx.dataDir, jobId, { translations });
  } catch { /* 记录写入失败不影响交付 */ }

  const staged = ctx.stageFile
    ? [(await ctx.stageFile({ filePath: outputPath, label: file })).mediaItem]
    : [];
  const note = failed ? `（${failed} 个片段翻译失败，已保留原文）` : "";
  return {
    content: [{ type: "text", text: `已将 ${job.fileName || "文档"} 翻译为 ${targetLanguage}${note}，译文已作为附件交付（${output.length} 字符）。` }],
    ...(staged.length ? { details: { media: { items: staged } } } : {}),
  };
}
