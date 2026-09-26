// 生产边界冒烟：把交付包解压到一个全新的临时目录（模拟 {HANA_HOME}/apps/<id>：
// 在仓库之外、没有 node_modules、没有任何工作区符号链接），然后逐个 import
// 每一个服务端入口。这能抓到"只在仓库里成立"的导入假设。
//
// 用法: node scripts/production-smoke.mjs <app-<id>-<version>.zip>
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const zipPath = process.argv[2];
if (!zipPath || !fs.existsSync(zipPath)) {
  console.error("用法: node scripts/production-smoke.mjs <package.zip>");
  process.exit(2);
}

// 用系统能力解压，避免引入任何依赖。
const root = await fsp.mkdtemp(path.join(os.tmpdir(), "mineru-prod-"));
execFileSync("powershell", [
  "-NoProfile",
  "-Command",
  `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${root}' -Force`,
], { stdio: "inherit" });
console.log(`extracted to ${root}`);
console.log(`node_modules present: ${fs.existsSync(path.join(root, "node_modules"))}`);
console.log(`package.json present: ${fs.existsSync(path.join(root, "package.json"))}`);

const failures = [];
async function importEntry(rel) {
  try {
    const mod = await import(pathToFileURL(path.join(root, rel)).href);
    return mod;
  } catch (error) {
    failures.push(`${rel}: ${error?.message || error}`);
    return null;
  }
}

// 1) 入口：v2 app 的 entry 由 manifest 指定
const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
if (manifest.manifestVersion !== 2) failures.push(`manifestVersion must be 2, got ${manifest.manifestVersion}`);
if (path.basename(root) && typeof manifest.entry !== "string") failures.push("manifest.entry must be a string");
const entry = await importEntry(manifest.entry || "index.js");
if (entry && typeof entry.default !== "object") failures.push("entry must default-export defineApp(...) 的返回值");

// 2) 身份图标必须随包携带
if (typeof manifest.icon !== "string" || !fs.existsSync(path.join(root, manifest.icon))) {
  failures.push(`manifest.icon 指向的文件不在包里：${manifest.icon}`);
}

// 3) 工具：必须暴露 name / description / parameters / execute
const toolDir = path.join(root, "lib", "tools");
for (const file of fs.readdirSync(toolDir).filter((f) => f.endsWith(".js"))) {
  const mod = await importEntry(path.join("lib", "tools", file));
  if (!mod) continue;
  for (const field of ["name", "description", "parameters"]) {
    if (mod[field] === undefined) failures.push(`lib/tools/${file}: missing export ${field}`);
  }
  if (typeof mod.execute !== "function") failures.push(`lib/tools/${file}: missing execute`);
  if (!/^[a-z][a-z0-9_-]*$/.test(String(mod.name))) {
    failures.push(`lib/tools/${file}: 工具名 ${mod.name} 不满足模型循环的正则 ^[a-z][a-z0-9_-]*$`);
  }
}

// 4) 路由：必须是 (app, ctx) 工厂函数或具名 register
const routeDir = path.join(root, "lib", "routes");
for (const file of fs.readdirSync(routeDir).filter((f) => f.endsWith(".js"))) {
  const mod = await importEntry(path.join("lib", "routes", file));
  if (!mod) continue;
  const ok = typeof mod.default === "function" || typeof mod.register === "function";
  if (!ok) failures.push(`lib/routes/${file}: 既不是 (app, ctx) 工厂函数也不是具名 register`);
}

// 5) 能力声明：迁移后应该是 v2 的能力词，不再是 v1 的 trust: full-access
if (manifest.trust !== undefined) failures.push("v2 清单不应再有 trust 字段");
for (const capability of ["app/tools.expose-to-model", "app/session.stage-file", "app/models.infer"]) {
  if (!manifest.capabilities?.includes(capability)) failures.push(`manifest.capabilities 缺少 ${capability}`);
}

// 6) 仓库材料绝不能进交付包
for (const leaked of ["tests", "docs", "scripts", "reference"]) {
  if (fs.existsSync(path.join(root, leaked))) failures.push(`交付包里出现了仓库材料目录：${leaked}/`);
}
if (fs.existsSync(path.join(root, ".git"))) failures.push("交付包里出现了 .git/");

// 7) 包里不能有凭据
// 注意：不能用 `text.includes("sk-")` 这种子串判断——打包进去的 SDK 里满是
// `--chat-task-block-width`、`--desk-...` 这类 CSS 变量名。只有"看起来真是一把钥匙"
// 的形状才算命中。
const CREDENTIAL_PATTERNS = [
  { name: "MinerU / OpenAI 风格 token", re: /sk-[A-Za-z0-9_-]{24,}/ },
  { name: "Bearer + 长串", re: /Bearer\s+[A-Za-z0-9._-]{24,}/ },
  { name: "私钥块", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: "赋值式密钥", re: /(api[_-]?key|apikey|secret|password|token)\s*[:=]\s*["'][A-Za-z0-9._-]{24,}["']/i },
];
const text = fs.readdirSync(root, { recursive: true })
  .filter((f) => typeof f === "string" && !fs.statSync(path.join(root, f)).isDirectory())
  .filter((f) => !/\.(png|jpe?g|webp|gif|zip|woff2?)$/i.test(f))
  .map((f) => fs.readFileSync(path.join(root, f), "utf8"))
  .join("\n");
for (const rule of CREDENTIAL_PATTERNS) {
  const match = rule.re.exec(text);
  if (match) failures.push(`包里出现了疑似凭据（${rule.name}）：${match[0].slice(0, 60)}`);
}

// 8) 卡片页面引用的包内静态资源必须真的在包里
// 这类错误静态校验器看得见 HTML，但看不见 panel.js 里的模块 import；
// 真出了问题只会表现为页面白屏。
const html = fs.readFileSync(path.join(root, "ui", "panel.html"), "utf8");
const pageAssets = new Set();
for (const m of html.matchAll(/(?:href|src)="\.\/([^"]+)"/g)) pageAssets.add(`ui/${m[1]}`);
for (const m of html.matchAll(/src="\.\/([^"]+)"/g)) pageAssets.add(`ui/${m[1]}`);
const panelJs = fs.readFileSync(path.join(root, "ui", "assets", "panel.js"), "utf8");
for (const m of panelJs.matchAll(/from\s+'\.\/([^']+)'/g)) pageAssets.add(`ui/assets/${m[1]}`);
for (const rel of pageAssets) {
  if (!fs.existsSync(path.join(root, rel))) failures.push(`页面引用了不存在的资源：${rel}`);
}
if (![...pageAssets].some((rel) => rel.endsWith("app-ui.js"))) {
  failures.push("卡片没有引用官方控件包 app-ui.js");
}
if (![...pageAssets].some((rel) => rel.endsWith("app-ui.css"))) {
  failures.push("卡片没有引用官方控件样式 app-ui.css");
}

await fsp.rm(root, { recursive: true, force: true });

if (failures.length) {
  console.error("\n冒烟失败：");
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log("\n生产边界冒烟通过：入口、工具、路由、能力声明与包内容都符合 v2 约定。");
