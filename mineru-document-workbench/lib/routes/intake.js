// 接收浏览器侧送来的文件字节。
//
// 为什么需要这个路由：拖放与粘贴拿到的 `File` 只有字节、**没有本地路径**
// （浏览器沙箱不给路径，`materialize` 那条路要的是路径）。所以由页面把字节
// POST 过来，后端落到自己的 dataDir 里，此后就和「用户用选择器挑的文件」走
// 同一条解析链路了。
//
// 落点选 `dataDir/intake/` 而不是 `dataDir/uploads/`：
//   - `uploads/` 是 v2-ctx 的暂存区，带 30 分钟 TTL 清扫，专供 materialize 转存；
//   - intake 是我们自己接的入口，语义不同，分开放免得两边互相清。
//
// 注意：写在 dataDir 里的路径会被 materialize 直接采用（不再复制一次），
// 因为 dataDir 是子进程唯一可读写的许可根。

import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { isSupportedFile, SUPPORTED_EXTS } from "../file-types.v1.js";

const INTAKE_DIRNAME = "intake";

/** 单次上传的体积上限。 */
export const MAX_INTAKE_BYTES = 100 * 1024 * 1024;

/** 文件名清洗：只留字母数字、点、短横、下划线与中文，并限长。 */
function safeBaseName(name) {
  const cleaned = String(name || "file").replace(/[^\w.\-\u4e00-\u9fff]+/g, "_").slice(-80);
  return cleaned || "file";
}

export default function registerIntakeRoutes(app, ctx) {
  /**
   * POST /intake?name=<文件名>
   *
   * 请求体就是文件的原始字节（不是 base64）：这样 100MB 的文件传过来还是
   * 100MB，不会因为编码膨胀成 133MB。文件名走查询参数，因为 body 要留给字节。
   */
  app.post("/intake", async (c) => {
    const rawName = c.req.query("name");
    if (typeof rawName !== "string" || !rawName.trim()) {
      return c.json({ error: "缺少文件名" }, 400);
    }
    // 只取 basename：请求里的名字是外部输入，不能带路径。
    const fileName = path.basename(rawName.trim().replace(/\\/g, "/"));
    if (!isSupportedFile(fileName)) {
      return c.json({
        error: `不支持的文件类型：${path.extname(fileName) || "(无扩展名)"}。可解析 ${SUPPORTED_EXTS.join(" / ")}`,
      }, 400);
    }

    const declared = Number(c.req.header("content-length"));
    if (Number.isFinite(declared) && declared > MAX_INTAKE_BYTES) {
      return c.json({ error: `文件超过 ${Math.round(MAX_INTAKE_BYTES / 1048576)}MB 上限` }, 413);
    }

    let bytes;
    try {
      bytes = Buffer.from(await c.req.arrayBuffer());
    } catch (error) {
      return c.json({ error: `读取上传内容失败：${error?.message || error}` }, 400);
    }
    if (!bytes.length) return c.json({ error: "上传内容为空" }, 400);
    if (bytes.length > MAX_INTAKE_BYTES) {
      return c.json({ error: `文件超过 ${Math.round(MAX_INTAKE_BYTES / 1048576)}MB 上限` }, 413);
    }

    const dir = path.join(ctx.dataDir, INTAKE_DIRNAME);
    try {
      await fs.mkdir(dir, { recursive: true });
    } catch (error) {
      return c.json({ error: `无法创建接收目录：${error?.message || error}` }, 500);
    }

    // 用内容哈希命名：同一个文件重复拖进来会落到同一个路径，不会堆一堆副本。
    const hash = createHash("sha256").update(bytes).digest("hex").slice(0, 12);
    const target = path.join(dir, `${hash}-${safeBaseName(fileName)}`);
    try {
      await fs.writeFile(target, bytes);
    } catch (error) {
      return c.json({ error: `保存文件失败：${error?.message || error}` }, 500);
    }

    return c.json({
      resource: { kind: "local-file", path: target },
      fileName,
      size: bytes.length,
    });
  });
}
