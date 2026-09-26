import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createLegacyCtx } from "../mineru-document-workbench/v2-ctx.js";

/*
 * 回归：v2 的 `materialize` 返回的是**用户的原始文件路径**，而 app 子进程开着
 * Node Permission Model —— 读取许可根只有 dataDir。业务代码直接 `fs.readFile`
 * 那个路径会被拒绝：
 *   Access to this API has been restricted. Use --allow-fs-read to manage permissions.
 *
 * 适配层必须先把外部文件复制进 dataDir，再把可读的路径交出去。
 */

async function makeFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mineru-ctx-"));
  const dataDir = path.join(root, "app-data");
  const userDir = path.join(root, "user-files");
  await fs.mkdir(dataDir, { recursive: true });
  await fs.mkdir(userDir, { recursive: true });

  const sourcePath = path.join(userDir, "报告 v1.pdf");
  const bytes = Buffer.from("PDF-ish payload");
  await fs.writeFile(sourcePath, bytes);

  const calls = { materialize: 0, copy: [] };

  const sdk = {
    dataDir,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    storage: {
      global: {
        async get() { return null; },
        async set() {},
      },
    },
    bus: {
      handle() { return () => {}; },
      hasHandler() { return false; },
      async request() { return null; },
    },
    models: { async list() { return { models: [] }; } },
    config: { async get() { return null; }, async set() {} },
    network: { async fetch() { return new Response(""); } },
    resources: {
      // 宿主行为：直接把用户的路径原样返回（不复制）
      async materialize() {
        calls.materialize += 1;
        return { resourceKey: `local_fs:${sourcePath}`, filePath: sourcePath, version: { size: bytes.length } };
      },
      // 宿主行为：真正的复制
      async copy(from, to) {
        calls.copy.push({ from, to });
        await fs.mkdir(path.dirname(to.path), { recursive: true });
        await fs.copyFile(sourcePath, to.path);
        return { changeType: "created", resource: { kind: "local-file", path: to.path, filePath: to.path } };
      },
    },
  };

  return { root, dataDir, userDir, sourcePath, bytes, calls, sdk };
}

function insideDataDir(dataDir, filePath) {
  const rel = path.relative(dataDir, filePath);
  return Boolean(rel) && !rel.startsWith("..") && !path.isAbsolute(rel);
}

test("materialize stages an external file into dataDir so plain fs can read it", async () => {
  const fx = await makeFixture();
  try {
    const ctx = createLegacyCtx(fx.sdk, { appId: "mineru-document-workbench" });
    const out = await ctx.resources.materialize({ kind: "local-file", path: fx.sourcePath });

    assert.equal(fx.calls.materialize, 1, "应当先问宿主要文件");
    assert.equal(fx.calls.copy.length, 1, "外部文件必须复制一次进 dataDir");
    assert.ok(
      insideDataDir(fx.dataDir, out.filePath),
      `交给业务代码的路径必须在 dataDir 内，实际是 ${out.filePath}`,
    );

    // 关键：这个路径要能被裸 fs 读到，内容与源文件一致
    const staged = await fs.readFile(out.filePath);
    assert.deepEqual(staged, fx.bytes, "暂存文件内容必须与源文件一致");

    // 文件名保留原始 basename（带清洗），便于排查；带哈希前缀避免不同目录同名互踩
    const stagedName = path.basename(out.filePath);
    assert.ok(stagedName.includes("报告"), `暂存文件名应保留原名，实际 ${stagedName}`);
    assert.ok(stagedName.endsWith(".pdf"), `应保留扩展名，实际 ${stagedName}`);
  } finally {
    await fs.rm(fx.root, { recursive: true, force: true });
  }
});

test("materialize leaves an already-readable dataDir path untouched", async () => {
  const fx = await makeFixture();
  try {
    const inner = path.join(fx.dataDir, "already-here.bin");
    await fs.writeFile(inner, fx.bytes);
    fx.sdk.resources.materialize = async () => ({ filePath: inner });

    const ctx = createLegacyCtx(fx.sdk, { appId: "mineru-document-workbench" });
    const out = await ctx.resources.materialize({ kind: "local-file", path: inner });

    assert.equal(out.filePath, inner, "dataDir 内的路径不应被再复制一份");
    assert.equal(fx.calls.copy.length, 0, "同目录文件不需要复制");
  } finally {
    await fs.rm(fx.root, { recursive: true, force: true });
  }
});

test("materialize reuses one staged file for the same source", async () => {
  const fx = await makeFixture();
  try {
    const ctx = createLegacyCtx(fx.sdk, { appId: "mineru-document-workbench" });
    const first = await ctx.resources.materialize({ kind: "local-file", path: fx.sourcePath });
    const second = await ctx.resources.materialize({ kind: "local-file", path: fx.sourcePath });
    assert.equal(first.filePath, second.filePath, "同一文件重复提交应复用同一暂存文件，避免堆积");
  } finally {
    await fs.rm(fx.root, { recursive: true, force: true });
  }
});

test("materialize reports a clear error when staging fails", async () => {
  const fx = await makeFixture();
  try {
    fx.sdk.resources.copy = async () => { throw new Error("boom"); };
    const ctx = createLegacyCtx(fx.sdk, { appId: "mineru-document-workbench" });
    await assert.rejects(
      () => ctx.resources.materialize({ kind: "local-file", path: fx.sourcePath }),
      /暂存到应用数据目录失败/,
      "复制失败时不应把原始路径透出去（那只会暴露难懂的权限错误）",
    );
  } finally {
    await fs.rm(fx.root, { recursive: true, force: true });
  }
});
