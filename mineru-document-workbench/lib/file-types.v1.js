// 可解析的文件类型白名单。
//
// 单独成模块的原因：提交（`routes/jobs.js`）与接收上传（`routes/intake.js`）
// 必须用**同一份**名单。分头写迟早漂移——一处加了扩展名、另一处没加，
// 现象是「能选中但提交时说类型不支持」，很难查。
//
// 这是共享模块，文件名带版本号是刻意的（见 docs/hana-source-findings.md）。
// 修改本文件时请新建 file-types.v2.js，更新所有导入方，并删除旧文件。

import path from "node:path";

/** MinerU 能处理的扩展名。 */
export const SUPPORTED_EXTS = Object.freeze([
  ".pdf",
  ".png", ".jpg", ".jpeg", ".jp2", ".webp", ".gif", ".bmp",
  ".doc", ".docx", ".ppt", ".pptx", ".xls", ".xlsx",
]);

const EXT_SET = new Set(SUPPORTED_EXTS);

/** 供界面上传区显示的接受列表（给 input accept / 拖放提示用）。 */
export const ACCEPT_ATTRIBUTE = SUPPORTED_EXTS.join(",");

/** 这个文件名是不是可解析的类型。首尾空白不影响判定。 */
export function isSupportedFile(name) {
  const trimmed = String(name ?? "").trim();
  if (!trimmed) return false;
  return EXT_SET.has(path.extname(trimmed).toLowerCase());
}

/** 给 HTML `accept` 用的简洁描述，用于界面提示文案。 */
export function describeSupportedTypes() {
  return "PDF、图片（PNG/JPG/WebP/GIF/BMP/JP2）、Office 文档（Word/PPT/Excel）";
}
