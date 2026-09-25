import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { renderMarkdown, sanitizeTag, escapeHtml } from "../markdown-render.v2.js";
import {
  contentTypeFor, normalizeResultRef, resolveAssetPath, listResultFiles,
  readResultAsset, createImageResolver,
} from "../result-assets.v1.js";

// ── Markdown 渲染 ─────────────────────────────────────────────────────────────

test("renders headings, emphasis, lists and code", () => {
  const html = renderMarkdown("# Title\n\nSome **bold** and *italic* text.\n\n- one\n- two\n\n1. first\n2. second\n\n```json\n{\"a\":1}\n```");
  assert.match(html, /<h1>Title<\/h1>/);
  assert.match(html, /<strong>bold<\/strong>/);
  assert.match(html, /<em>italic<\/em>/);
  assert.match(html, /<ul><li>one<\/li><li>two<\/li><\/ul>/);
  assert.match(html, /<ol><li>first<\/li><li>second<\/li><\/ol>/);
  assert.match(html, /<pre><code class="language-json">\{&quot;a&quot;:1\}<\/code><\/pre>/);
});

test("does not apply markdown formatting inside code fences", () => {
  const html = renderMarkdown("```\n**not bold** and [not a link](x)\n```");
  assert.match(html, /\*\*not bold\*\*/);
  assert.doesNotMatch(html, /<strong>/);
  assert.doesNotMatch(html, /<a /);
});

test("renders pipe tables", () => {
  const html = renderMarkdown("| a | b |\n| --- | --- |\n| 1 | 2 |");
  assert.match(html, /<table><thead><tr><th>a<\/th><th>b<\/th><\/tr><\/thead>/);
  assert.match(html, /<tbody><tr><td>1<\/td><td>2<\/td><\/tr><\/tbody>/);
});

test("keeps MinerU raw HTML tables from the converted result", () => {
  // 精准通道的 xlsx 结果里带原始 HTML 表格，需要保留结构而不是当成文本。
  const html = renderMarkdown('<table>\n<tr><th><p>需求编码</p></th></tr>\n<tr><td><p>ITXQ2025</p></td></tr>\n</table>');
  assert.match(html, /<table>/);
  assert.match(html, /<th><p>需求编码<\/p><\/th>/);
  assert.match(html, /<td><p>ITXQ2025<\/p><\/td>/);
});

test("resolves images through the resolver and marks unavailable ones", () => {
  const resolve = (src) => (src === "images/ok.png" ? "jobs/abc/asset/images/ok.png" : null);
  const html = renderMarkdown("![shot](images/ok.png)\n\n![gone](images/missing.png)", { resolveImage: resolve });
  assert.match(html, /<img src="jobs\/abc\/asset\/images\/ok\.png" alt="shot"/);
  assert.match(html, /图片不可用：gone/);
  assert.doesNotMatch(html, /src="images\/missing.png"/);
});

test("uses a caller-supplied note so an unavailable image explains why", () => {
  const html = renderMarkdown("![gone](images/x.png)", {
    resolveImage: () => null,
    noteFor: (src, alt) => `（Agent 轻量通道不提供图片：${alt || src}）`,
  });
  assert.match(html, /Agent 轻量通道不提供图片：gone/);
  // 注：默认提示仍可用（不同通道不同文案）
  assert.match(renderMarkdown("![x](images/x.png)", { resolveImage: () => null }), /图片不可用：x/);
});

test("a throwing note callback does not break rendering", () => {
  const html = renderMarkdown("![x](images/x.png)", {
    resolveImage: () => null,
    noteFor: () => { throw new Error("boom"); },
  });
  assert.match(html, /图片不可用：x/);
});

test("drops script, iframe and event-handler attributes from result HTML", () => {
  const html = renderMarkdown('<script>alert(1)</script>\n\n<p onclick="alert(2)">hi</p>\n\n<iframe src="https://evil.test"></iframe>\n<img src="x.png" onerror="alert(3)">');
  assert.doesNotMatch(html, /<script/i);
  assert.doesNotMatch(html, /onclick/i);
  assert.doesNotMatch(html, /<iframe/i);
  assert.doesNotMatch(html, /onerror/i);
  assert.match(html, /<p>hi<\/p>/);
});

test("strips javascript: links but keeps http(s) links", () => {
  const html = renderMarkdown('[bad](javascript:alert(1)) and [good](https://mineru.net/docs)');
  assert.doesNotMatch(html, /javascript:/i);
  assert.match(html, /<a href="https:\/\/mineru\.net\/docs"[^>]*>good<\/a>/);
});

test("escapes angle brackets in plain text", () => {
  const html = renderMarkdown("a < b and c > d");
  assert.match(html, /a &lt; b and c &gt; d/);
});

test("sanitizeTag enforces the attribute whitelist", () => {
  assert.equal(sanitizeTag('<td colspan="2" style="color:red">'), '<td colspan="2">');
  assert.equal(sanitizeTag('<a href="javascript:x">'), '<a>');
  assert.equal(sanitizeTag('<div class="x">'), "<div>");
  assert.equal(sanitizeTag('<unknown>'), "");
  assert.equal(escapeHtml('<img src=x onerror=y>'), '&lt;img src=x onerror=y&gt;');
});

// ── 结果文件定位与安全边界 ────────────────────────────────────────────────────

const TASK_ID = "cd4bfbdb-5108-4cdd-a6d2-87421664af3412";

async function makeResultDir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mineru-assets-"));
  const root = path.join(dir, "recovered", TASK_ID);
  await fs.mkdir(path.join(root, "images"), { recursive: true });
  await fs.writeFile(path.join(root, "full.md"), "# Result");
  await fs.writeFile(path.join(root, "images", "a.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  await fs.writeFile(path.join(root, "images", "b.jpg"), Buffer.from([0xff, 0xd8, 0xff]));
  await fs.writeFile(path.join(root, "secret.txt"), "not an image");
  return dir;
}

test("normalizes markdown result references", () => {
  assert.equal(normalizeResultRef("./images/a.png"), "images/a.png");
  assert.equal(normalizeResultRef("images\\a.png"), "images/a.png");
  assert.equal(normalizeResultRef("/images/a.png"), "images/a.png");
  assert.equal(normalizeResultRef("images/%E4%B8%AD.png"), "images/中.png");
  assert.equal(normalizeResultRef("  "), null);
  assert.equal(normalizeResultRef(null), null);
});

test("confines asset resolution to the task result directory", async () => {
  const dir = await makeResultDir();
  assert.ok(resolveAssetPath(dir, TASK_ID, "images/a.png"));

  // 越界必须被拒绝
  for (const evil of ["../../../../etc/passwd", "images/../../full.md", "..\\..\\secret.txt", "images/\0a.png"]) {
    assert.equal(resolveAssetPath(dir, TASK_ID, evil), null, `expected rejection for ${evil}`);
  }

  // 形状不合法的任务 ID 直接拒绝
  assert.throws(() => resolveAssetPath(dir, "../escape", "images/a.png"), /Invalid result identity/);

  // 即使任务 ID 合法但未知，解析结果也必须仍在 recovered/ 之内（限制范围而非必须拒绝）
  const unknown = resolveAssetPath(dir, "unknown-task-id-1234567890", "images/a.png");
  const recoveredRoot = path.resolve(dir, "recovered");
  assert.ok(unknown === null || unknown.startsWith(`${recoveredRoot}${path.sep}`),
    `resolved path escaped recovered/: ${unknown}`);
});

test("lists only files with readable extensions", async () => {
  const dir = await makeResultDir();
  const files = await listResultFiles(dir, TASK_ID);
  assert.ok(files.has("images/a.png"));
  assert.ok(files.has("images/b.jpg"));
  assert.ok(files.has("full.md"));
  assert.equal(files.has("secret.txt"), false);
  assert.equal(contentTypeFor("x.png"), "image/png");
  assert.equal(contentTypeFor("x.exe"), null);
});

test("reads images and refuses non-image or out-of-scope paths", async () => {
  const dir = await makeResultDir();
  const ok = await readResultAsset(dir, TASK_ID, "images/a.png");
  assert.equal(ok.contentType, "image/png");
  assert.equal(ok.bytes.length, 4);
  assert.equal(ok.isSvg, false);

  assert.equal(await readResultAsset(dir, TASK_ID, "secret.txt"), null);
  assert.equal(await readResultAsset(dir, TASK_ID, "../../full.md"), null);
  assert.equal(await readResultAsset(dir, TASK_ID, "images/gone.png"), null);
});

test("image resolver accepts only local results or allowlisted hosts", async () => {
  const dir = await makeResultDir();
  const available = await listResultFiles(dir, TASK_ID);
  const resolve = createImageResolver({
    dataDir: dir,
    taskId: TASK_ID,
    available,
    assetUrlFor: (rel) => `jobs/${TASK_ID}/asset/${rel}`,
    allowedHostSuffixes: ["openxlab.org.cn", "aliyuncs.com"],
  });

  assert.equal(resolve("images/a.png"), `jobs/${TASK_ID}/asset/images/a.png`);
  // 本地不存在的相对引用 / 非白名单主机 / 非 http 协议都要拒绝
  assert.equal(resolve("images/missing.png"), null);
  assert.equal(resolve("https://evil.test/a.png"), null);
  assert.equal(resolve("https://cdn-mineru.openxlab.org.cn/pdf/x/images/a.png"),
    "https://cdn-mineru.openxlab.org.cn/pdf/x/images/a.png");
  assert.equal(resolve("file:///etc/passwd"), null);
  assert.equal(resolve(""), null);
});
