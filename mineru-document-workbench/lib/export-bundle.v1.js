// 导出装配：把一份解析结果（或译文）Markdown 变成可带走的文件。
//
// 要解决的问题：结果 Markdown 里的图片是**相对路径**（`images/xxx.jpg`），
// 它只在 `recovered/<taskId>/` 那个目录里才有意义。单独把 .md 存到别处，
// 图片就全裂了。预览能显示是因为走了另一条路（后端改写成 asset URL、
// 前端带凭据 fetch 成 blob），那条路出了应用就断。
//
// 两种导出形态，各自解决不同场合：
//   zip    —— md + 原样图片，目录关系不破坏，md 保持人类可读、体积不变。
//             适合「我要一份完整可打开的文档」。md 里的相对路径一个字都不用改。
//   inline —— 所有图片转成 data: URI 内联进 md，单文件自包含。
//             适合「我就要一个文件，拖到哪儿都能看」。代价是体积约 +33%，
//             且图片一多 md 就不再适合当文本读了。
//
// 外链图（host 在允许列表内）会在导出时**下载下来一并打包**：
// MinerU 有时返回临时签名 URL，那种链接过几天会过期，
// 不落盘的话导出包会随时间自己烂掉。host 不在允许列表的保持原样并记一条警告
// ——不是不想下，是宿主网络层不放行（见清单的 network.allowedHosts）。
//
// 这是共享模块，文件名带版本号是刻意的（见 docs/hana-source-findings.md）。
// 修改本文件时请新建 export-bundle.v2.js，更新所有导入方，并删除旧文件。

import path from "node:path";
import { createHash } from "node:crypto";
import { readResultAsset, listResultFiles, normalizeResultRef, SAFE_IMAGE_EXTS, hostMatchesSuffix } from "./result-assets.v2.js";
import { buildZip } from "./zip-write.v1.js";

/**
 * 导出时可以尝试下载的图片来源主机（后缀匹配）。
 * 必须与清单 network.allowedHosts 保持一致，否则宿主网络层会直接拒绝。
 */
export const EXPORT_IMAGE_HOSTS = Object.freeze(["mineru.net", "openxlab.org.cn", "aliyuncs.com"]);

/** 单次导出的图片总字节上限。留出余量：saveFile 解码后上限 64MiB。 */
export const MAX_EXPORT_IMAGE_BYTES = 48 * 1024 * 1024;

/** 单张外链图的下载超时。 */
const REMOTE_TIMEOUT_MS = 30000;

const TYPE_TO_EXT = Object.freeze({
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/jpg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/bmp": ".bmp",
  "image/svg+xml": ".svg",
  "image/jp2": ".jp2",
  "image/avif": ".avif",
  "image/tiff": ".tiff",
});

/** 外链图统一放这里，与 MinerU 自己的目录习惯一致。 */
const REMOTE_DIR = "images";

/**
 * 主机是否在允许列表内。
 *
 * 直接用 result-assets 里那个共用函数：预览渲染与导出下载判断的是同一件事，
 * 两处各写一遍迟早会漂移——v1 恰好在两处各写了一遍，且都写成了只判
 * `endsWith`（见 result-assets.v2.js 头部）。共用一份就不会再分叉。
 */
export function hostAllowed(host, suffixes = EXPORT_IMAGE_HOSTS) {
  return hostMatchesSuffix(host, suffixes);
}

/**
 * 扫描 Markdown 里的图片引用。
 *
 * 只认 `![alt](...)` 这一种写法（MinerU 输出的就是这种）。
 * 括号里的内容按「尖括号包裹」或「首个空白前是 src」解析，
 * 因此 `![](a.png)`、`![](<a b.png>)`、`![](a.png "标题")` 都能处理。
 * 已知取舍：src 里含未转义的 `)` 且没有用尖括号包裹时会被截断——这种写法
 * 本身就不是合法 Markdown，不值得为它把解析器写复杂。
 */
function scanImageRefs(markdown) {
  const out = [];
  const re = /!\[([^\]]*)\]\(([^)]*)\)/g;
  let match;
  while ((match = re.exec(markdown)) !== null) {
    const inside = String(match[2] ?? "").trim();
    if (!inside) continue;
    let src = inside;
    let title = "";
    if (inside.startsWith("<")) {
      const end = inside.indexOf(">");
      if (end < 0) continue;
      src = inside.slice(1, end).trim();
      title = inside.slice(end + 1).trim();
    } else {
      const split = inside.match(/^(\S+)(?:\s+([\s\S]*))?$/);
      if (!split) continue;
      src = split[1];
      title = (split[2] || "").trim();
    }
    if (!src) continue;
    out.push({ index: match.index, length: match[0].length, alt: match[1], src, title });
  }
  return out;
}

function extForContentType(contentType) {
  const type = String(contentType ?? "").split(";")[0].trim().toLowerCase();
  return TYPE_TO_EXT[type] || null;
}

function extForRemote(src, contentType) {
  const byType = extForContentType(contentType);
  if (byType) return byType;
  try {
    const ext = path.extname(new URL(src).pathname).toLowerCase();
    if (SAFE_IMAGE_EXTS.has(ext)) return ext;
  } catch { /* URL 解析失败就退回通用后缀 */ }
  return ".img";
}

/**
 * 给下载来的图片起个可读且唯一的名字：`<原标题>-<URL 短哈希>.<ext>`。
 *
 * 为什么带哈希：不同 URL 的 basename 经常相同（`image.png`、UUID 片段），
 * 用哈希保证稳定且不撞；写成 `remote-1.png` 则丢失了来源线索。
 */
function remoteEntryName(src, contentType) {
  let stem = "";
  try {
    stem = decodeURIComponent(new URL(src).pathname.split("/").pop() || "");
  } catch { stem = ""; }
  stem = stem.replace(/\.[^.]+$/, "");
  stem = stem.replace(/[^\w\u4e00-\u9fa5-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40);
  if (!stem) stem = "image";
  const hash = createHash("sha256").update(src).digest("hex").slice(0, 8);
  return `${stem}-${hash}${extForRemote(src, contentType)}`;
}

async function downloadImage(ctx, src) {
  const response = await ctx.network.fetch(src, { method: "GET", timeoutMs: REMOTE_TIMEOUT_MS });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (!bytes.length) throw new Error("空响应");
  return { bytes, contentType: response.headers.get("content-type") || "" };
}

/**
 * 把 Markdown 里的图片解析成「能带走」的形式。
 *
 * @returns {{ images: Array, warnings: string[] }}
 *   images[].kind  'local'  → path 是结果目录内的相对路径，需原样复制
 *                  'remote' → 需要以 name 落到 images/ 下并改写引用
 *                  'skip'   → 拿不到字节，保持原引用并记警告
 */
async function collectImages(ctx, { dataDir, taskId, markdown, hostSuffixes }) {
  const refs = scanImageRefs(markdown);
  const available = await listResultFiles(dataDir, taskId);
  const images = [];
  const warnings = [];
  const usedNames = new Set(available);
  const cache = new Map();

  for (const ref of refs) {
    if (/^https?:\/\//i.test(ref.src)) {
      let host = "";
      try { host = new URL(ref.src).hostname; } catch {
        warnings.push(`图片地址无法解析：${ref.src}`);
        images.push({ ...ref, kind: "skip" });
        continue;
      }
      if (!hostAllowed(host, hostSuffixes)) {
        warnings.push(`图片主机 ${host} 不在允许列表内，未下载（保持原链接）：${ref.src}`);
        images.push({ ...ref, kind: "skip" });
        continue;
      }
      try {
        let got = cache.get(ref.src);
        if (!got) {
          const { bytes, contentType } = await downloadImage(ctx, ref.src);
          let name = remoteEntryName(ref.src, contentType);
          // 与已有文件（结果原图）或前一张下载图重名时加序号。
          if (usedNames.has(`${REMOTE_DIR}/${name}`)) {
            const dot = name.lastIndexOf(".");
            const stem = dot > 0 ? name.slice(0, dot) : name;
            const ext = dot > 0 ? name.slice(dot) : "";
            let n = 2;
            while (usedNames.has(`${REMOTE_DIR}/${stem}-${n}${ext}`)) n += 1;
            name = `${stem}-${n}${ext}`;
          }
          usedNames.add(`${REMOTE_DIR}/${name}`);
          got = { bytes, name, contentType: contentType || "" };
          cache.set(ref.src, got);
        }
        images.push({ ...ref, kind: "remote", name: got.name, bytes: got.bytes, contentType: got.contentType });
      } catch (error) {
        warnings.push(`外链图下载失败（保持原链接）：${ref.src} — ${error?.message || error}`);
        images.push({ ...ref, kind: "skip" });
      }
      continue;
    }

    const rel = normalizeResultRef(ref.src);
    if (!rel || !available.has(rel)) {
      images.push({ ...ref, kind: "skip" });
      continue;
    }
    const asset = await readResultAsset(dataDir, taskId, rel);
    if (!asset) {
      warnings.push(`结果目录内读不到图片：${rel}`);
      images.push({ ...ref, kind: "skip" });
      continue;
    }
    images.push({ ...ref, kind: "local", path: rel, bytes: asset.bytes, contentType: asset.contentType });
  }

  return { images, warnings };
}

/**
 * 按「从后往前」替换，这样前面的 offset 不受影响。
 */
function applyReplacements(markdown, replacements) {
  let out = markdown;
  for (const item of [...replacements].sort((a, b) => b.index - a.index)) {
    out = out.slice(0, item.index) + item.text + out.slice(item.index + item.length);
  }
  return out;
}

function buildImageMarkdown({ alt, src, title }) {
  return `![${alt}](${src}${title ? ` ${title}` : ""})`;
}

/**
 * 生成导出内容。
 *
 * @param {object} ctx         应用上下文（需要 ctx.network.fetch 下载外链图）
 * @param {object} options
 * @param {string} options.dataDir
 * @param {string} options.taskId        结果目录名
 * @param {string} options.markdown      原始 Markdown
 * @param {'zip'|'inline'} options.format
 * @param {string} [options.baseName]    打包/下载时的基础名（不含扩展名）
 * @param {string[]} [options.hostSuffixes]
 * @returns {{ kind:'zip', bytes:Buffer, fileName:string, warnings:string[], stats:object }
 *         | { kind:'inline', markdown:string, fileName:string, warnings:string[], stats:object }}
 */
export async function buildExport(ctx, options) {
  const {
    dataDir,
    taskId,
    markdown,
    format = "zip",
    baseName = "mineru-result",
    hostSuffixes = EXPORT_IMAGE_HOSTS,
  } = options;

  const { images, warnings } = await collectImages(ctx, { dataDir, taskId, markdown, hostSuffixes });

  const usable = images.filter((item) => item.kind !== "skip");
  const local = usable.filter((item) => item.kind === "local");
  const remote = usable.filter((item) => item.kind === "remote");
  const totalBytes = usable.reduce((sum, item) => sum + (item.bytes?.length || 0), 0);

  if (totalBytes > MAX_EXPORT_IMAGE_BYTES) {
    throw new Error(`导出图片总量约 ${Math.round(totalBytes / 1024 / 1024)}MB，超过 ${Math.round(MAX_EXPORT_IMAGE_BYTES / 1024 / 1024)}MB 上限`);
  }

  const stats = {
    images: usable.length,
    localImages: local.length,
    downloadedImages: remote.length,
    skippedImages: images.length - usable.length,
    imageBytes: totalBytes,
  };

  if (format === "inline") {
    // 内联：把每个能拿到字节的引用换成 data URI。
    const replacements = usable.map((item) => {
      const mime = item.contentType || "application/octet-stream";
      const dataUri = `data:${mime};base64,${item.bytes.toString("base64")}`;
      return {
        index: item.index,
        length: item.length,
        text: buildImageMarkdown({ alt: item.alt, src: dataUri, title: item.title }),
      };
    });
    const inlined = applyReplacements(markdown, replacements);
    const bytes = Buffer.from(inlined, "utf8");
    if (bytes.length > MAX_EXPORT_IMAGE_BYTES) {
      throw new Error(`内联后约 ${Math.round(bytes.length / 1024 / 1024)}MB，超过 ${Math.round(MAX_EXPORT_IMAGE_BYTES / 1024 / 1024)}MB 上限；请改用打包 zip`);
    }
    return {
      kind: "inline",
      markdown: inlined,
      fileName: `${baseName}.md`,
      warnings,
      stats: { ...stats, exportBytes: bytes.length },
    };
  }

  // 打包：本地图按原相对路径复制（md 一个字都不用改），外链图落到 images/ 并改写引用。
  const entries = [{ name: `${baseName}.md`, bytes: Buffer.from(markdown, "utf8") }];
  for (const item of local) entries.push({ name: item.path, bytes: item.bytes });

  const rewrites = [];
  for (const item of remote) {
    const target = `${REMOTE_DIR}/${item.name}`;
    entries.push({ name: target, bytes: item.bytes });
    rewrites.push({
      index: item.index,
      length: item.length,
      text: buildImageMarkdown({ alt: item.alt, src: target, title: item.title }),
    });
  }
  if (rewrites.length) {
    // 改写后的 md 才是包内那一份。
    entries[0] = { name: `${baseName}.md`, bytes: Buffer.from(applyReplacements(markdown, rewrites), "utf8") };
  }

  const { bytes, skipped } = buildZip(entries, { date: new Date() });
  if (skipped.length) warnings.push(`打包时跳过了非法或重复的文件名：${skipped.join("、")}`);

  return {
    kind: "zip",
    bytes,
    fileName: `${baseName}.zip`,
    warnings,
    stats: { ...stats, exportBytes: bytes.length, entries: entries.length },
  };
}
