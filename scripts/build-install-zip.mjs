// 构建可直接安装的插件包（GitHub Release 资产）。
//
// 与仓库的区别：只打包运行时文件，manifest.json 位于 zip 根目录。
// 排除 tests/ docs/ scripts/ LICENSE .gitignore —— 它们属于仓库，不属于安装包。
//
// 用法: node scripts/build-install-zip.mjs [outputDir]
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const root = process.cwd();
const outDir = path.resolve(process.argv[2] || root);

const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
const EXCLUDED_TOP_LEVEL = new Set(["tests", "docs", "scripts"]);
const EXCLUDED_FILES = new Set(["LICENSE", ".gitignore"]);

function collect(dir, prefix = "") {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (!prefix && EXCLUDED_TOP_LEVEL.has(entry.name)) continue;
    if (!prefix && EXCLUDED_FILES.has(entry.name)) continue;
    if (entry.name === ".git") continue;
    if (entry.isDirectory()) out.push(...collect(path.join(dir, entry.name), rel));
    else out.push(rel);
  }
  return out;
}

const files = collect(root).sort();
if (!files.includes("manifest.json")) {
  throw new Error("manifest.json must sit at the zip root; refusing to build");
}

const staging = fs.mkdtempSync(path.join(process.env.TEMP || "/tmp", "mineru-install-build-"));
try {
  for (const rel of files) {
    const target = path.join(staging, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(root, rel), target);
  }
  const zipName = `${manifest.id}-${manifest.version}.zip`;
  const zipPath = path.join(outDir, zipName);
  fs.rmSync(zipPath, { force: true });
  // PowerShell 的 Compress-Archive 在各平台上都有；这里用系统 tar 兜底不必要，
  // 因为本项目只支持在 Windows/macOS/Linux 上用 node 运行，压缩交给 PowerShell 即可。
  execFileSync("powershell", [
    "-NoProfile",
    "-Command",
    `Compress-Archive -Path '${path.join(staging, "*")}' -DestinationPath '${zipPath}' -Force`,
  ], { stdio: "inherit" });
  const bytes = fs.readFileSync(zipPath);
  const { createHash } = await import("node:crypto");
  console.log(`\n包名: ${zipName}`);
  console.log(`文件数: ${files.length}`);
  console.log(`大小: ${bytes.length} 字节`);
  console.log(`sha256: ${createHash("sha256").update(bytes).digest("hex")}`);
  console.log(`路径: ${zipPath}`);
} finally {
  fs.rmSync(staging, { recursive: true, force: true });
}
