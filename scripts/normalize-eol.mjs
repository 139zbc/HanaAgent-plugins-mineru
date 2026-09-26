// 把指定目录下的文本文件从 CRLF 规范成 LF（只处理文本，跳过明确的二进制）。
//
// 用途：mineru-v2 不是 git 仓库，拿不到 .gitattributes 的自动规范化，
// 而发布树已经是 LF。两边不一致会让「哪个是权威副本」变得含糊，
// 也会让重新打包的字节对不上。
//
// 用法: node scripts/_normalize-eol.mjs <dir> [--dry]

import fs from "node:fs";
import path from "node:path";

const BINARY = new Set([
  ".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".jp2", ".ico",
  ".zip", ".woff", ".woff2", ".ttf",
]);

const root = path.resolve(process.argv[2] || ".");
const dry = process.argv.includes("--dry");

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === ".git" || entry.name === "node_modules" || entry.name === "dist") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.isFile() && !BINARY.has(path.extname(entry.name).toLowerCase())) out.push(full);
  }
  return out;
}

let changed = 0;
for (const file of walk(root)) {
  const buf = fs.readFileSync(file);
  // 只在确实含 CRLF 时才动，避免无谓改写。
  let hasCrlf = false;
  for (let i = 0; i < buf.length - 1; i += 1) {
    if (buf[i] === 13 && buf[i + 1] === 10) { hasCrlf = true; break; }
  }
  if (!hasCrlf) continue;
  const next = Buffer.from(buf.toString("utf8").replace(/\r\n/g, "\n"), "utf8");
  changed += 1;
  if (dry) {
    console.log(`would fix: ${path.relative(root, file)}`);
  } else {
    fs.writeFileSync(file, next);
    console.log(`fixed: ${path.relative(root, file)}`);
  }
}
console.log(`\n${dry ? "需要修正" : "已修正"} ${changed} 个文件（根：${root}）`);
