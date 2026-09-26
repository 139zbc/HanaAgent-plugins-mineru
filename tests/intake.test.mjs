import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isSupportedFile, SUPPORTED_EXTS } from "../mineru-document-workbench/lib/file-types.v1.js";
import registerIntakeRoutes, { MAX_INTAKE_BYTES } from "../mineru-document-workbench/lib/routes/intake.js";

/**
 * 最小路由替身：只记下注册的处理器，调用时喂一个假的 Request。
 *
 * 不引 h3 / 宿主运行时：这里要验的是**我们的处理逻辑**（校验、落盘、回包），
 * 不是框架怎么解析请求。
 */
function makeApp() {
  const routes = new Map();
  return {
    routes,
    post(route, handler) { routes.set(route, handler); },
    get(route, handler) { routes.set(route, handler); },
  };
}

function makeContext(dir) {
  const calls = [];
  return {
    ctx: {
      dataDir: dir,
      logger: { debug() {}, info() {}, warn() {}, error() {} },
    },
    calls,
  };
}

/** 造一个 c 对象，形状按 h3 的约定（只实现被测代码用到的部分）。 */
function makeRequest({ query = {}, headers = {}, bytes = Buffer.alloc(0) }) {
  const jsonCalls = [];
  const headerCalls = [];
  let status = 200;
  const response = {
    statusCode: status,
    body: null,
    json(payload) { jsonCalls.push(payload); this.body = payload; return this; },
  };
  return {
    c: {
      req: {
        query(name) { return query[name]; },
        header(name) { headerCalls.push(name); return headers[String(name).toLowerCase()]; },
        async arrayBuffer() { return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength); },
      },
      json(payload, code) { response.statusCode = code ?? 200; return response.json(payload); },
    },
    response,
    jsonCalls,
  };
}

async function tmpDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "mineru-intake-"));
}

// ── 文件类型白名单 ──────────────────────────────────────────────────────

test("the supported-type whitelist is shared and case-insensitive", () => {
  for (const name of ["a.pdf", "b.PNG", "c.docx", "d.XLSX", "e.webp", "f.jp2"]) {
    assert.ok(isSupportedFile(name), `${name} 应被接受`);
  }
  for (const name of ["a.txt", "b.exe", "c", "d.", "", "e.md"]) {
    assert.equal(isSupportedFile(name), false, `${name} 应被拒绝`);
  }
  // 前后有空格不该影响判定（上传时名字来自查询参数）。
  assert.ok(isSupportedFile("  spaced.pdf  "), "首尾空白应被容忍");
});

test("the intake route and the submit route read the same extension list", async () => {
  // 以前白名单在 jobs.js 里写死一份；现在两处共用 file-types，不能再分叉。
  const appDir = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..", "mineru-document-workbench");
  const jobs = await fs.readFile(path.join(appDir, "lib", "routes", "jobs.js"), "utf8");
  const intake = await fs.readFile(path.join(appDir, "lib", "routes", "intake.js"), "utf8");
  assert.match(jobs, /from "\.\.\/file-types\.v1\.js"/, "提交侧应导入共享白名单");
  assert.match(intake, /from "\.\.\/file-types\.v1\.js"/, "接收侧应导入共享白名单");
  assert.equal(
    /const extensions = new Set\(/.test(jobs),
    false,
    "提交侧不应再自己维护一份扩展名列表",
  );
});

// ── 接收上传 ────────────────────────────────────────────────────────────

test("intake writes the bytes and returns a usable local-file reference", async () => {
  const dir = await tmpDir();
  const app = makeApp();
  const { ctx } = makeContext(dir);
  registerIntakeRoutes(app, ctx);

  const handler = app.routes.get("/intake");
  const pdf = Buffer.from("%PDF-1.4 fake bytes");
  const { c, response } = makeRequest({ query: { name: "季度总结.pdf" }, bytes: pdf });

  await handler(c);

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.fileName, "季度总结.pdf");
  assert.equal(response.body.size, pdf.length);
  assert.equal(response.body.resource.kind, "local-file");

  // 关键：路径必须落在 dataDir 之内——只有这样 materialize 才不会再去复制一次，
  // 也才在子进程的读取许可根里。
  const written = response.body.resource.path;
  const rel = path.relative(dir, written);
  assert.ok(rel && !rel.startsWith("..") && !path.isAbsolute(rel), `落点应在 dataDir 内：${written}`);
  assert.ok(written.startsWith(path.join(dir, "intake")), "应落在 intake 子目录");
  const round = await fs.readFile(written);
  assert.ok(round.equals(pdf), "落盘字节应与上传字节逐字节一致");
});

test("intake names the file by content hash so repeat drops reuse one path", async () => {
  const dir = await tmpDir();
  const app = makeApp();
  registerIntakeRoutes(app, { dataDir: dir, logger: {} });
  const handler = app.routes.get("/intake");
  const bytes = Buffer.from("same content");

  const first = makeRequest({ query: { name: "a.pdf" }, bytes });
  await handler(first.c);
  const second = makeRequest({ query: { name: "a.pdf" }, bytes });
  await handler(second.c);

  assert.equal(
    first.response.body.resource.path,
    second.response.body.resource.path,
    "同样的字节应该落到同一个路径，不能堆副本",
  );
  const files = await fs.readdir(path.join(dir, "intake"));
  assert.equal(files.length, 1);
});

test("intake refuses unsupported types without writing anything", async () => {
  const dir = await tmpDir();
  const app = makeApp();
  registerIntakeRoutes(app, { dataDir: dir, logger: {} });
  const handler = app.routes.get("/intake");

  const { c, response } = makeRequest({ query: { name: "payload.exe" }, bytes: Buffer.from("MZ") });
  await handler(c);

  assert.equal(response.statusCode, 400);
  assert.match(response.body.error, /不支持的文件类型/);
  const wrote = await fs.stat(path.join(dir, "intake")).catch(() => null);
  assert.equal(wrote, null, "被拒的类型不该创建目录或落盘");
});

test("intake refuses a name that tries to escape the intake directory", async () => {
  const dir = await tmpDir();
  const app = makeApp();
  registerIntakeRoutes(app, { dataDir: dir, logger: {} });
  const handler = app.routes.get("/intake");

  const { c, response } = makeRequest({
    query: { name: "../../../evil.pdf" },
    bytes: Buffer.from("%PDF"),
  });
  await handler(c);

  // 请求里的名字是外部输入：只取 basename，不能借它写到 dataDir 之外。
  assert.equal(response.statusCode, 200);
  const written = response.body.resource.path;
  const rel = path.relative(dir, written);
  assert.ok(rel && !rel.startsWith(".."), `不得越出 dataDir：${written}`);
  assert.equal(path.basename(written).includes(".."), false);
});

test("intake rejects an empty body and a missing name", async () => {
  const dir = await tmpDir();
  const app = makeApp();
  registerIntakeRoutes(app, { dataDir: dir, logger: {} });
  const handler = app.routes.get("/intake");

  const noName = makeRequest({ query: {}, bytes: Buffer.from("%PDF") });
  await handler(noName.c);
  assert.equal(noName.response.statusCode, 400);
  assert.match(noName.response.body.error, /文件名/);

  const empty = makeRequest({ query: { name: "a.pdf" }, bytes: Buffer.alloc(0) });
  await handler(empty.c);
  assert.equal(empty.response.statusCode, 400);
  assert.match(empty.response.body.error, /为空/);
});

test("intake rejects a declared size over the ceiling before reading", async () => {
  const dir = await tmpDir();
  const app = makeApp();
  registerIntakeRoutes(app, { dataDir: dir, logger: {} });
  const handler = app.routes.get("/intake");

  const { c, response } = makeRequest({
    query: { name: "big.pdf" },
    headers: { "content-length": String(MAX_INTAKE_BYTES + 1) },
    bytes: Buffer.from("%PDF"),
  });
  await handler(c);

  assert.equal(response.statusCode, 413);
  assert.match(response.body.error, /上限/);
});

test("the intake ceiling stays below what the delivery path can carry", () => {
  // saveFile 的硬上限是 64MiB（解码后），intake 是另一个方向，但都该有边界。
  assert.ok(MAX_INTAKE_BYTES > 0);
  assert.ok(MAX_INTAKE_BYTES <= 512 * 1024 * 1024, "上限不该大到失去意义");
});

test("the whitelist covers what the UI promises", () => {
  // 界面文案说支持这些，后端就真的得认这些。
  for (const ext of [".pdf", ".png", ".jpg", ".webp", ".docx", ".pptx", ".xlsx"]) {
    assert.ok(SUPPORTED_EXTS.includes(ext), `${ext} 应在白名单里`);
  }
});
