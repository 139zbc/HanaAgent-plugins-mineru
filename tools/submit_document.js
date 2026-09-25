import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { PARSE_MODES, CHANNELS, normalizeParseMode, modeFor, parseModeLabel, resolveConfiguredMode, modeRequiresToken, modeProvidesJson } from "../parse-options.v2.js";
import { submitByMode } from "../parse-channels.v1.js";

export const name = "submit_document";
export const description = "Upload one selected document to MinerU and return a task ID immediately. Use recover_batch later to obtain the result without uploading again. Supports a no-token lightweight mode (agent).";
export const parameters = {
  type: "object",
  properties: {
    source: { type: "object", description: "Hana ResourceRef for the selected document" },
    fileName: { type: "string" },
    modelVersion: {
      type: "string",
      enum: PARSE_MODES.map((mode) => mode.id),
      description: "解析方式：vlm（MinerU VLM）、pipeline（MinerU 传统管线）、agent（Agent 轻量解析 API，免 Token，≤10MB/≤20 页，仅 Markdown）。省略时使用插件配置。",
    },
    isOcr: { type: "boolean" },
  },
  required: ["source"],
};
export const sessionPermission = {
  kind: "external_side_effect",
  describeSideEffect: () => ({
    kind: "external_network_upload",
    summary: "Upload a selected document to MinerU and create a parsing task.",
    ruleId: "mineru-submit-document",
  }),
};
const SUPPORTED = new Set([".pdf", ".png", ".jpg", ".jpeg", ".jp2", ".webp", ".gif", ".bmp", ".doc", ".docx", ".ppt", ".pptx", ".xls", ".xlsx"]);

export async function execute(input = {}, ctx) {
  if (!input.source || typeof input.source !== "object") throw new Error("source ResourceRef is required");

  // 模式先归一化：非法值直接报错，不触碰文件与外部服务。
  const hasRequested = input.modelVersion !== undefined && input.modelVersion !== null && input.modelVersion !== "";
  const requested = hasRequested ? normalizeParseMode(input.modelVersion) : null;
  if (hasRequested && !requested) {
    throw new Error(`Unsupported parse mode: ${String(input.modelVersion)}；可选值为 ${PARSE_MODES.map((mode) => mode.id).join(" / ")}`);
  }
  const mode = modeFor(requested || resolveConfiguredMode(await ctx.config.get("modelVersion")));

  const materialized = await ctx.resources.materialize(input.source);
  const filePath = materialized?.filePath;
  if (typeof filePath !== "string") throw new Error("Resource materialize did not return filePath");
  const fileName = String(input.fileName || path.basename(filePath));
  if (!SUPPORTED.has(path.extname(fileName).toLowerCase())) throw new Error("Unsupported MinerU file type");

  // 只有需要 Token 的通道才要求配置；轻量通道正是为「无 Key」准备的。
  const apiToken = await ctx.config.get("apiToken");
  if (modeRequiresToken(mode.id) && (typeof apiToken !== "string" || !apiToken)) {
    throw new Error("MinerU API token is not configured；可改用 modelVersion=\"agent\"（Agent 轻量解析 API，免 Token）");
  }

  const jobId = crypto.randomUUID();
  const dir = path.join(ctx.dataDir, "jobs", jobId);
  await fs.mkdir(dir, { recursive: true });

  const submitted = await submitByMode(ctx, {
    filePath,
    fileName,
    modeId: mode.id,
    isOcr: Boolean(input.isOcr),
    apiToken: typeof apiToken === "string" ? apiToken : null,
  });

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

  const jsonNote = modeProvidesJson(mode.id) ? "" : "（该模式仅返回 Markdown）";
  return `MinerU task submitted: ${fileName}; mode=${parseModeLabel(mode.id) || mode.id}; taskId=${submitted.batchId}${jsonNote}. Query/recover later; the file will not be uploaded again.`;
}
