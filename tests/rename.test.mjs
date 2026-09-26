import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import registerJobRoutes from "../mineru-document-workbench/lib/routes/jobs.js";

/*
 * 最小路由替身：只记下注册的处理器，调用时喂一个假的 c。
 * 与 intake.test.mjs 同一套做法 —— 验的是我们的处理逻辑，不是框架怎么解析请求。
 */
function makeApp() {
  const routes = new Map();
  return {
    routes,
    get(route, handler) { routes.set(`GET ${route}`, handler); },
    post(route, handler) { routes.set(`POST ${route}`, handler); },
    delete(route, handler) { routes.set(`DELETE ${route}`, handler); },
  };
}

/** 一个只够跑通 rename 的 ctx。 */
function makeCtx(dataDir) {
  return {
    dataDir,
    config: { async get() { return null; }, async set() {} },
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    resources: { materialize: async () => ({ filePath: null }) },
    network: { fetch: async () => { throw new Error("不该联网"); } },
  };
}

function makeRequest(body) {
  let status = 200;
  const response = { statusCode: status, body: null };
  return {
    c: {
      req: {
        param: (name) => name === "jobId" ? JOB_ID : undefined,
        json: async () => body,
      },
      json(payload, code) { response.statusCode = code ?? 200; response.body = payload; return response; },
    },
    response,
  };
}

const JOB_ID = "9e8e4938-3f27-4ef2-89d7-27f8ab627aa1";
const OTHER_ID = "aa11bb22-cc33-dd44-ee55-ff6677889900";

/** 造一个 jobs/<id>/metadata.json。 */
async function makeJobDir(fileName = "原名.pdf", id = JOB_ID) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "mineru-rename-"));
  const dir = path.join(dataDir, "jobs", id);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "metadata.json"), JSON.stringify({
    jobId: id, batchId: "b-1", fileName, state: "done",
    createdAt: "2026-09-26T00:00:00Z",
  }), "utf8");
  return { dataDir, dir };
}

async function readStored(dataDir, id = JOB_ID) {
  const raw = await fs.readFile(path.join(dataDir, "jobs", id, "metadata.json"), "utf8");
  return JSON.parse(raw);
}

test("rename changes only the display name and reports the cleaned value", async () => {
  const { dataDir } = await makeJobDir();
  const app = makeApp();
  registerJobRoutes(app, makeCtx(dataDir));
  const handler = app.routes.get("POST /jobs/:jobId/rename");
  assert.ok(handler, "应注册 rename 路由");

  const { c, response } = makeRequest({ fileName: "季度总结.pdf" });
  await handler(c);

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.ok, true);
  assert.equal(response.body.fileName, "季度总结.pdf");

  const stored = await readStored(dataDir);
  assert.equal(stored.fileName, "季度总结.pdf");
  // 改名不该动别的东西：批次、状态、创建时间都得原样。
  assert.equal(stored.batchId, "b-1");
  assert.equal(stored.state, "done");
  assert.equal(stored.createdAt, "2026-09-26T00:00:00Z");
});

test("rename strips path separators so the name cannot escape into a path", async () => {
  // 名字会进入导出文件名与 HTTP 头，那两处对分隔符敏感。
  const { dataDir } = await makeJobDir();
  const app = makeApp();
  registerJobRoutes(app, makeCtx(dataDir));
  const handler = app.routes.get("POST /jobs/:jobId/rename");

  const cases = [
    ["../evil/name.pdf", ".._evil_name.pdf"],
    ["a\\b.pdf", "a_b.pdf"],
    // 全是分隔符：清洗后剩下的下划线虽奇怪，但无害（不越权、不非法）。
    ["///", "___"],
  ];
  for (const [input, expected] of cases) {
    const { c, response } = makeRequest({ fileName: input });
    await handler(c);
    assert.equal(response.statusCode, 200, `「${input}」应被接受但清洗`);
    assert.equal(response.body.fileName, expected);
    assert.equal(response.body.fileName.includes("/"), false, "不得留下 /");
    assert.equal(response.body.fileName.includes("\\"), false, "不得留下 \\\\");
  }
});

test("rename strips control characters", async () => {
  const { dataDir } = await makeJobDir();
  const app = makeApp();
  registerJobRoutes(app, makeCtx(dataDir));
  const handler = app.routes.get("POST /jobs/:jobId/rename");

  const { c, response } = makeRequest({ fileName: "a\u0000b\u001fc.pdf" });
  await handler(c);
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.fileName, "abc.pdf");
});

test("rename refuses an empty or whitespace-only name", async () => {
  const { dataDir } = await makeJobDir();
  const app = makeApp();
  registerJobRoutes(app, makeCtx(dataDir));
  const handler = app.routes.get("POST /jobs/:jobId/rename");

  // 只剩空白（或清洗后成空）的应当拒。
  // 注意 "///" 不在这个列表里：它会被替换成 "___"，是个合法（虽然奇怪）的名字，
  // 真正的保证是「没有分隔符活下来」，那是下一个用例的事。
  for (const bad of ["", "   ", "\u0000", "\u0000\u001f", "  \u0000  "]) {
    const { c, response } = makeRequest({ fileName: bad });
    await handler(c);
    assert.equal(response.statusCode, 400, `「${JSON.stringify(bad)}」应被拒`);
    assert.match(response.body.error, /不能为空/);
  }
  // 被拒时不得落盘。
  assert.equal((await readStored(dataDir)).fileName, "原名.pdf");
});

test("rename refuses an absurdly long name", async () => {
  const { dataDir } = await makeJobDir();
  const app = makeApp();
  registerJobRoutes(app, makeCtx(dataDir));
  const handler = app.routes.get("POST /jobs/:jobId/rename");

  const { c, response } = makeRequest({ fileName: "长".repeat(201) });
  await handler(c);
  assert.equal(response.statusCode, 400);
  assert.match(response.body.error, /过长/);

  const { c: c2, response: r2 } = makeRequest({ fileName: "长".repeat(200) });
  await handler(c2);
  assert.equal(r2.statusCode, 200, "刚好 200 字应放行");
});

test("rename refuses a missing or non-string fileName", async () => {
  const { dataDir } = await makeJobDir();
  const app = makeApp();
  registerJobRoutes(app, makeCtx(dataDir));
  const handler = app.routes.get("POST /jobs/:jobId/rename");

  for (const body of [{}, { fileName: 123 }, { fileName: null }, { fileName: { a: 1 } }]) {
    const { c, response } = makeRequest(body);
    await handler(c);
    assert.equal(response.statusCode, 400, `${JSON.stringify(body)} 应被拒`);
  }
});

test("renaming a job that does not exist is a 404, not a silent success", async () => {
  const { dataDir } = await makeJobDir();
  const app = makeApp();
  registerJobRoutes(app, makeCtx(dataDir));
  // 换一个合法但不存在 的 id。
  const handler = app.routes.get("POST /jobs/:jobId/rename");
  const { c, response } = makeRequest({ fileName: "x.pdf" });
  // 覆写 param 返回 OTHER_ID
  c.req.param = (name) => name === "jobId" ? OTHER_ID : undefined;
  await handler(c);
  assert.equal(response.statusCode, 404);
  assert.match(response.body.error, /not found/i);
});

test("rename rejects an id that is not a plausible job id", async () => {
  const { dataDir } = await makeJobDir();
  const app = makeApp();
  registerJobRoutes(app, makeCtx(dataDir));
  const handler = app.routes.get("POST /jobs/:jobId/rename");
  const { c, response } = makeRequest({ fileName: "x.pdf" });
  c.req.param = () => "../../etc/passwd";
  await handler(c);
  assert.equal(response.statusCode, 400);
  assert.match(response.body.error, /Invalid job ID/);
});

test("rename writes atomically and leaves no temp file behind", async () => {
  const { dataDir, dir } = await makeJobDir();
  const app = makeApp();
  registerJobRoutes(app, makeCtx(dataDir));
  const handler = app.routes.get("POST /jobs/:jobId/rename");

  const { c } = makeRequest({ fileName: "新名.pdf" });
  await handler(c);

  const files = await fs.readdir(dir);
  assert.deepEqual(files, ["metadata.json"], `目录里只应有 metadata.json，实际 ${files.join(", ")}`);
  assert.equal((await readStored(dataDir)).fileName, "新名.pdf");
});
