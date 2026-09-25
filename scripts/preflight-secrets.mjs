// 发布前敏感信息体检：扫描待发布目录，任何一条命中都会让脚本以非零退出。
// 用法: node scripts/preflight-secrets.mjs [targetDir]
import fs from "node:fs";
import path from "node:path";

const target = path.resolve(process.argv[2] || ".");
const SKIP_DIRS = new Set([".git", "node_modules"]);

// 1) 硬编码密钥与凭据
const SECRET_PATTERNS = [
  { name: "MinerU token", re: /sk-[A-Za-z0-9]{20,}/ },
  { name: "Bearer + 长串", re: /Bearer\s+[A-Za-z0-9._-]{20,}/ },
  { name: "疑似 API key 赋值", re: /(api[_-]?key|apikey|secret|password|passwd)\s*[:=]\s*["'][^"']{16,}["']/i },
  { name: "私钥块", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: "JWT", re: /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/ },
];

// 2) 本机与个人痕迹（发布会带上你的用户名和目录结构）
const LOCAL_PATTERNS = [
  { name: "Windows 绝对路径", re: /[A-Za-z]:\\{1,2}Users\\{1,2}[^\\\s"']+/ },
  { name: "POSIX home 绝对路径", re: /\/Users\/[A-Za-z0-9._-]+\// },
  { name: "邮箱", re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/ },
  { name: "中国大陆手机号", re: /(?<![\d.])1[3-9]\d{9}(?![\d.])/ },
];

// 3) 不该出现在公开仓库里的运行时文件
const FORBIDDEN_FILES = [
  /(^|[/\\])config\.json$/,
  /(^|[/\\])jobs[/\\]/,
  /(^|[/\\])recovered[/\\]/,
  /(^|[/\\])test-fixtures[/\\]/,
  /(^|[/\\])dist[/\\]/,
  /\.zip$/,
  /\.xlsx?$/,
  /\.pdf$/,
];

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

const TEXT_EXT = /\.(js|mjs|cjs|json|md|css|html|txt|yml|yaml|ps1|sh|ts|tsx|svg)$/i;
const files = walk(target);
const findings = [];

for (const file of files) {
  const rel = path.relative(target, file);
  for (const rule of FORBIDDEN_FILES) {
    if (rule.test(rel)) findings.push({ kind: "不该发布", file: rel, detail: rule.source });
  }
  if (!TEXT_EXT.test(file)) continue;
  let text;
  try { text = fs.readFileSync(file, "utf8"); } catch { continue; }
  const lines = text.split(/\r?\n/);
  for (const group of [SECRET_PATTERNS, LOCAL_PATTERNS]) {
    for (const rule of group) {
      lines.forEach((line, index) => {
        const match = rule.re.exec(line);
        if (match) findings.push({ kind: rule.name, file: rel, line: index + 1, detail: match[0].slice(0, 80) });
      });
    }
  }
}

console.log(`扫描目录: ${target}`);
console.log(`文件数: ${files.length}`);
console.log("");
if (!findings.length) {
  console.log("未发现敏感信息或不该发布的文件。");
} else {
  console.log(`发现 ${findings.length} 处需要确认：`);
  for (const f of findings) {
    const where = f.line ? `${f.file}:${f.line}` : f.file;
    console.log(`  [${f.kind}] ${where}${f.detail ? `  ->  ${f.detail}` : ""}`);
  }
  process.exitCode = 1;
}
