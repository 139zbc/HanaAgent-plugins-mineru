// 导出路由：把一份结果（或译文）导出成可带走的文件。
//
// 为什么打包在后端做而不是页面里：
//   1. 图片在磁盘上，后端读文件比让 iframe 逐张带凭据取回来快得多；
//   2. 外链图的下载在 `ctx.network.fetch` 里，页面拿不到这条通道的授权模型；
//   3. 只有一个请求，页面侧只负责把字节交给 `resource.saveFile`。
//
// 返回的是二进制（zip）或文本（inline），页面侧再 base64 交给 saveFile。

import fs from "node:fs/promises";
import path from "node:path";
import { getJob, isSafeResultId, localResult } from "../job-store.v6.js";
import { buildExport, EXPORT_IMAGE_HOSTS } from "../export-bundle.v1.js";

const FORMATS = new Set(["zip", "inline"]);

/** 文件名里不能出现路径分隔符等字符（saveFile 会拒，解压也会出问题）。 */
function safeBaseName(value, fallback) {
  const name = String(value ?? "")
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
  return name || fallback;
}

export default function registerExportRoutes(app, ctx) {
  /**
   * GET /jobs/:jobId/export?format=zip|inline[&translation=<lang>]
   *
   * `translation` 省略时导出结果本身，给了就导出那一份译文。
   * 两种形态共用同一套图片处理，所以只开一个入口。
   */
  app.get("/jobs/:jobId/export", async (c) => {
    const jobId = c.req.param("jobId");
    if (!isSafeResultId(jobId)) return c.json({ error: "Invalid job ID" }, 400);

    const job = await getJob(ctx.dataDir, jobId);
    if (!job) return c.json({ error: "Job not found" }, 404);

    const format = String(c.req.query("format") || "zip").toLowerCase();
    if (!FORMATS.has(format)) return c.json({ error: "format must be zip or inline" }, 400);

    const lang = String(c.req.query("translation") || "").trim();
    const taskId = job.batchId || jobId;
    let markdown;
    let baseName;

    if (lang) {
      const record = (job.translations || []).find((item) => item.lang === lang);
      if (!record) return c.json({ error: "Translation not found" }, 404);
      const root = path.resolve(ctx.dataDir, "recovered", taskId);
      const target = path.resolve(root, record.file);
      if (!target.startsWith(`${root}${path.sep}`)) return c.json({ error: "Invalid translation path" }, 400);
      try {
        markdown = await fs.readFile(target, "utf8");
      } catch {
        return c.json({ error: "译文文件不存在" }, 404);
      }
      baseName = safeBaseName(job.fileName, jobId) + `.${lang}`;
    } else {
      if (job.state !== "done") return c.json({ error: "Job is not finished" }, 400);
      const local = await localResult(ctx.dataDir, job);
      if (!local?.markdownPath) return c.json({ error: "解析结果尚未就绪" }, 404);
      try {
        markdown = await fs.readFile(local.markdownPath, "utf8");
      } catch {
        return c.json({ error: "结果文件不存在" }, 404);
      }
      baseName = safeBaseName(job.fileName, jobId);
    }

    try {
      const result = await buildExport(ctx, {
        dataDir: ctx.dataDir,
        taskId,
        markdown,
        format,
        baseName,
        hostSuffixes: EXPORT_IMAGE_HOSTS,
      });

      // 警告不放进响应体（zip 是二进制），改用响应头带回去：
      // 页面侧读出来展示，既不破坏字节，也不用为了报一句提示再发一次请求。
      if (result.warnings.length) {
        c.header("X-Mineru-Export-Warnings", String(result.warnings.length));
      }
      c.header("X-Mineru-Export-Images", String(result.stats.images));
      c.header("X-Mineru-Export-Downloaded", String(result.stats.downloadedImages));
      c.header("X-Mineru-Export-File-Name", encodeURIComponent(result.fileName));

      if (result.kind === "inline") {
        c.header("Content-Type", "text/markdown; charset=utf-8");
        return c.body(result.markdown);
      }
      c.header("Content-Type", "application/zip");
      return c.body(result.bytes);
    } catch (error) {
      return c.json({ error: error?.message || String(error) }, 500);
    }
  });
}
