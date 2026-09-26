// 解析结果文件（图片等）的读取与定位。
//
// 安全边界：只能读取 `recovered/<taskId>/` 之下、且扩展名在白名单内的文件。
// 结果目录名来自用户可控的 batchId/taskId，相对路径来自解析结果内容，两者都当外部输入。
//
// v1 → v2 改了什么：修掉 `createImageResolver` 的允许主机后缀判定。
// v1 写的是 `host === suffix || host.endsWith(suffix)`，只判 endsWith 会让
// `notmineru.net`、`evil-aliyuncs.com` 这类构造域名通过校验（它们确实以允许的
// 后缀结尾），于是未经允许的主机上的图片也能被渲染。
// v2 把它抽成一个共用函数，并加上点前缀再比：`h === s || h.endsWith('.' + s)`。
//
// 这是共享模块，文件名带版本号是刻意的（见 docs/hana-source-findings.md）。
// 修改本文件时请新建 result-assets.v3.js，更新所有导入方，并删除旧文件。

import fs from "node:fs/promises";
import path from "node:path";
import { isSafeResultId } from "./job-store.v6.js";

const CONTENT_TYPES = Object.freeze({
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".jp2": "image/jp2",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
});

// 可作为图片内联展示的扩展名。SVG 也在内，但直接打开时可能执行脚本，
// 因此读取结果会带上严格响应头（见 readResultAsset）。
export const SAFE_IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".jp2", ".svg"]);

export function contentTypeFor(relPath) {
  return CONTENT_TYPES[path.extname(String(relPath)).toLowerCase()] || null;
}

/** 归一化 Markdown 里的相对引用（去 ./、统一分隔符、必要时解码）。 */
export function normalizeResultRef(value) {
  let ref = String(value ?? "").trim().replace(/\\/g, "/");
  if (!ref) return null;
  if (/%[0-9a-f]{2}/i.test(ref)) { try { ref = decodeURIComponent(ref); } catch { /* 保留原值 */ } }
  ref = ref.replace(/^\.\//, "").replace(/^\/+/, "");
  return ref || null;
}

/** 结果目录。 */
export function resultRoot(dataDir, taskId) {
  if (!isSafeResultId(taskId)) throw new Error("Invalid result identity");
  return path.resolve(dataDir, "recovered", taskId);
}

/**
 * 把相对引用解析为一个位于结果目录内的绝对路径；越界返回 null。
 * 允许读取尚不存在的路径判断（exists 由调用方决定）。
 */
export function resolveAssetPath(dataDir, taskId, relRef) {
  const ref = normalizeResultRef(relRef);
  if (!ref) return null;
  if (ref.includes("\0")) return null;
  const root = resultRoot(dataDir, taskId);
  const target = path.resolve(root, ref);
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) return null;
  return target;
}

/** 列出结果目录下所有可读取的相对路径（posix 形式），用于判断图片是否存在。 */
export async function listResultFiles(dataDir, taskId) {
  const root = resultRoot(dataDir, taskId);
  const out = new Set();
  async function walk(dir, prefix) {
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(path.join(dir, entry.name), rel);
      else if (entry.isFile() && contentTypeFor(rel)) out.add(rel);
    }
  }
  await walk(root, "");
  return out;
}

/**
 * 读取一个结果图片。返回 { bytes, contentType, isSvg }。
 * 扩展名不在图片白名单、路径越界、文件不存在时返回 null。
 */
export async function readResultAsset(dataDir, taskId, relRef) {
  const ext = path.extname(String(relRef ?? "")).toLowerCase();
  if (!SAFE_IMAGE_EXTS.has(ext)) return null;
  const contentType = contentTypeFor(relRef);
  if (!contentType) return null;
  const target = resolveAssetPath(dataDir, taskId, relRef);
  if (!target) return null;
  try {
    const bytes = await fs.readFile(target);
    return { bytes, contentType, isSvg: ext === ".svg" };
  } catch { return null; }
}

/**
 * 主机是否命中允许的后缀列表。
 *
 * 必须同时判「完全相等」与「以 `.后缀` 结尾」。只判 endsWith 会把
 * `notmineru.net`、`evil-aliyuncs.com` 这种构造域名放进来——
 * 它们确实以允许的后缀结尾，但不是那些域名的子域。
 *
 * 导出侧的下载判定也复用这一个函数，避免两处实现漂移。
 */
export function hostMatchesSuffix(host, suffixes = []) {
  const h = String(host ?? "").toLowerCase();
  if (!h) return false;
  return (Array.isArray(suffixes) ? suffixes : []).some((suffix) => {
    const s = String(suffix ?? "").toLowerCase();
    if (!s) return false;
    return h === s || h.endsWith(`.${s}`);
  });
}

/**
 * 构造 Markdown 图片解析器：只接受结果目录内的相对引用，或允许主机上的绝对 URL。
 * `available` 由 listResultFiles 提供，用来避免渲染坏图。
 */
export function createImageResolver({ dataDir, taskId, available, assetUrlFor, allowedHostSuffixes = [] }) {
  return (src) => {
    const raw = String(src ?? "").trim();
    if (!raw) return null;
    if (/^https?:\/\//i.test(raw)) {
      let host;
      try { host = new URL(raw).hostname.toLowerCase(); } catch { return null; }
      return hostMatchesSuffix(host, allowedHostSuffixes) ? raw : null;
    }
    const ref = normalizeResultRef(raw);
    if (!ref || !available?.has(ref)) return null;
    return assetUrlFor(ref);
  };
}
