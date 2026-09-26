// 构建可安装的 App 包（GitHub Release 资产）。
//
// v2 不再自己写压缩逻辑：官方打包器 extension-pack.mjs 是打包 App 的唯一正路，
// 它会在打包前跑一遍静态校验，并产出 <id>-<version>.zip 与配套的 entry.json。
//
// 关键前提：应用目录（mineru-document-workbench/）本身就是要发布的东西。
// tests/ docs/ scripts/ reference/ 都在应用目录之外，所以任何打包器都不会误装它们。
//
// 用法: node scripts/build-install-zip.mjs [outDir]
// 需要: HANA_APP_TOOLS_ROOT 指向 Hana Server 安装目录（含 APPS.md 与 scripts/extension-pack.mjs）
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const appDir = path.join(repoRoot, "mineru-document-workbench");
const outDir = path.resolve(process.argv[2] || path.join(repoRoot, "dist"));

const toolsRoot = process.env.HANA_APP_TOOLS_ROOT || process.env.HANA_ROOT;
if (!toolsRoot || !fs.existsSync(path.join(toolsRoot, "scripts", "extension-pack.mjs"))) {
  throw new Error(
    "需要 HANA_APP_TOOLS_ROOT 指向 Hana Server 安装目录（内含 APPS.md 与 scripts/extension-pack.mjs）",
  );
}
if (!fs.existsSync(path.join(appDir, "manifest.json"))) {
  throw new Error(`应用目录不完整，找不到 ${path.join(appDir, "manifest.json")}`);
}

fs.mkdirSync(outDir, { recursive: true });
execFileSync(
  process.execPath,
  [
    path.join(toolsRoot, "scripts", "extension-pack.mjs"),
    "--kind", "app",
    "--dir", appDir,
    "--publisher", process.env.HANA_APP_PUBLISHER || "139zbc",
    "--out", outDir,
  ],
  { stdio: "inherit" },
);
