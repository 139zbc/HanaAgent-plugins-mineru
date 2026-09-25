import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { findJobByBatch, isSafeResultId, jobStateLabel, listJobs, localResult, normalizeProgress, normalizeQueue, previewJob, pruneJobs, resolveStoredResultPath, updateJob } from "../job-store.v6.js";
import { execute as recoverBatch } from "../tools/recover_batch.js";

const jobId = "9e8e4938-3f27-4ef2-89d7-27f8ab627aa1";
const batchId = "d7193db2-691c-4f45-ad0d-67a101fbd29a";

test("lists interrupted jobs without exposing paths or token", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mineru-jobs-"));
  const jobDir = path.join(dir, "jobs", jobId);
  await fs.mkdir(jobDir, { recursive: true });
  await fs.writeFile(path.join(jobDir, "metadata.json"), JSON.stringify({
    fileName: "sample.pdf", state: "submitting", apiToken: "secret", createdAt: "2026-09-24T00:00:00Z",
  }));
  const jobs = await listJobs(dir);
  assert.equal(jobs[0].state, "interrupted_before_batch_id");
  assert.ok(!JSON.stringify(jobs).includes("secret"));
});

test("reads completed result preview only from plugin result directory", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mineru-jobs-"));
  const jobDir = path.join(dir, "jobs", jobId);
  const resultDir = path.join(dir, "recovered", batchId);
  await fs.mkdir(jobDir, { recursive: true });
  await fs.mkdir(resultDir, { recursive: true });
  const md = path.join(resultDir, "full.md");
  const json = path.join(resultDir, "content_list.json");
  await fs.writeFile(md, "# Result");
  await fs.writeFile(json, "[]");
  await fs.writeFile(path.join(jobDir, "metadata.json"), JSON.stringify({
    fileName: "sample.pdf", state: "done", batchId, markdownPath: md, jsonPaths: [json], createdAt: "2026-09-24T00:00:00Z",
  }));
  const preview = await previewJob(dir, jobId);
  assert.equal(preview.markdown, "# Result");
  assert.equal(preview.json, "[]");
  assert.ok(!JSON.stringify(preview).includes(resultDir));
  assert.equal((await localResult(dir, await findJobByBatch(dir, batchId).then((found) => found.job))).markdownPath, md);
});

test("rebases stored result paths from a previous plugin data directory", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mineru-rebase-"));
  const jobDir = path.join(dir, "jobs", jobId);
  const resultDir = path.join(dir, "recovered", batchId);
  await fs.mkdir(jobDir, { recursive: true });
  await fs.mkdir(resultDir, { recursive: true });
  await fs.writeFile(path.join(resultDir, "full.md"), "# Migrated");
  // Record a path from a different (older) data directory, as the migrated history does.
  const stalePath = path.join("C:", "other-hana-home", "plugin-data", "dev", "mineru-document-workbench", "recovered", batchId, "full.md");
  await fs.writeFile(path.join(jobDir, "metadata.json"), JSON.stringify({
    state: "done", batchId, markdownPath: stalePath, jsonPaths: [], createdAt: "2026-09-25T00:00:00Z",
  }));
  assert.equal(await resolveStoredResultPath(dir, batchId, stalePath), path.join(resultDir, "full.md"));
  const preview = await previewJob(dir, jobId);
  assert.equal(preview.markdown, "# Migrated");
  assert.equal(preview.stateLabel, "已完成");
});

test("preview returns null markdown instead of throwing when the result file is gone", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mineru-missing-"));
  const jobDir = path.join(dir, "jobs", jobId);
  await fs.mkdir(jobDir, { recursive: true });
  await fs.writeFile(path.join(jobDir, "metadata.json"), JSON.stringify({
    state: "done", batchId, markdownPath: path.join(dir, "recovered", batchId, "full.md"), jsonPaths: [],
  }));
  assert.equal(await resolveStoredResultPath(dir, batchId, path.join(dir, "nowhere", "full.md")), null);
  const preview = await previewJob(dir, jobId);
  assert.equal(preview.markdown, null);
  assert.equal(await localResult(dir, await findJobByBatch(dir, batchId).then((found) => found.job)), null);
});

test("recovers completed files after a fresh module context without MinerU credentials", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mineru-jobs-"));
  const resultDir = path.join(dir, "recovered", batchId);
  const jobDir = path.join(dir, "jobs", jobId);
  await fs.mkdir(resultDir, { recursive: true });
  await fs.mkdir(jobDir, { recursive: true });
  const md = path.join(resultDir, "full.md");
  await fs.writeFile(md, "# Persisted result");
  await fs.writeFile(path.join(jobDir, "metadata.json"), JSON.stringify({ state: "done", batchId, markdownPath: md, jsonPaths: [] }));
  const staged = [];
  const ctx = {
    dataDir: dir, sessionId: "session-test", sessionPath: "session-test.jsonl",
    stageFile: ({ filePath }) => { staged.push(filePath); return { mediaItem: { type: "session_file", fileId: "test-file" } }; },
    config: { get: () => { throw new Error("should not request a token for local result"); } },
    network: { fetch: () => { throw new Error("should not query MinerU for local result"); } },
  };
  const result = await recoverBatch({ batchId }, ctx);
  assert.equal(staged.length, 1);
  assert.equal(staged[0], md);
  assert.match(result.content[0].text, /18 bytes/);
});

test("normalizes MinerU progress and ignores non-numeric payloads", () => {
  assert.deepEqual(normalizeProgress({ extracted_pages: 3, total_pages: 12, start_time: "2026-09-24 11:43:20" }), {
    extractedPages: 3, totalPages: 12, startTime: "2026-09-24 11:43:20", queue: null,
  });
  assert.equal(normalizeProgress({ note: "no numbers" }), null);
  assert.equal(normalizeProgress(null), null);
});

test("labels queue states and surfaces an optional queue position", () => {
  assert.equal(jobStateLabel("pending"), "排队中");
  assert.equal(jobStateLabel("running"), "解析中");
  assert.equal(jobStateLabel("done"), "已完成");
  assert.equal(jobStateLabel("unknown-thing"), "unknown-thing");
  assert.equal(normalizeQueue({ state: "pending" }), null);
  assert.deepEqual(normalizeQueue({ queue_position: "433", waiting_ahead: 432 }), { position: 433, ahead: 432, total: null });
  assert.deepEqual(normalizeProgress(null, { state: "pending", queue_position: 12 }), {
    extractedPages: null, totalPages: null, startTime: null, queue: { position: 12, ahead: null, total: null },
  });
});

test("prune keeps the newest N jobs, spares unfinished ones, and is dry-run by default", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mineru-prune-"));
  const make = async (id, state, createdAt, batchId) => {
    const jobDir = path.join(dir, "jobs", id);
    await fs.mkdir(jobDir, { recursive: true });
    await fs.writeFile(path.join(jobDir, "metadata.json"), JSON.stringify({ state, createdAt, batchId: batchId || null }));
  };
  const old = "11111111-1111-4111-8111-111111111111";
  const recentDone = "22222222-2222-4222-8222-222222222222";
  const running = "33333333-3333-4333-8333-333333333333";
  const doneBatch = "44444444-4444-4444-8444-444444444444";
  await make(old, "done", "2026-09-01T00:00:00Z", doneBatch);
  await make(recentDone, "done", "2026-09-20T00:00:00Z");
  await make(running, "running", "2026-09-19T00:00:00Z");
  const resultDir = path.join(dir, "recovered", doneBatch);
  await fs.mkdir(resultDir, { recursive: true });
  await fs.writeFile(path.join(resultDir, "full.md"), "# old");

  const planned = await pruneJobs(dir, { keep: 1 });
  assert.deepEqual(planned.map((item) => item.jobId), [old]);
  assert.ok(await fs.readdir(path.join(dir, "jobs", old)).then(() => true));
  assert.ok(await fs.readdir(resultDir).then(() => true));

  const removed = await pruneJobs(dir, { keep: 1, dryRun: false });
  assert.deepEqual(removed.map((item) => item.jobId), [old]);
  assert.equal(await fs.readdir(path.join(dir, "jobs")).then((list) => list.includes(old)), false);
  assert.equal(await fs.stat(resultDir).then(() => true, () => false), false);
  assert.equal(await fs.readdir(path.join(dir, "jobs")).then((list) => list.includes(running)), true);
});

test("recover_batch reports a still-running batch and persists progress without staging files", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mineru-jobs-"));
  const jobDir = path.join(dir, "jobs", jobId);
  await fs.mkdir(jobDir, { recursive: true });
  await fs.writeFile(path.join(jobDir, "metadata.json"), JSON.stringify({ state: "pending", batchId, fileName: "sample.pdf" }));
  const ctx = {
    dataDir: dir, sessionId: "session-test",
    stageFile: () => { throw new Error("must not stage while still processing"); },
    config: { get: async () => "test-token" },
    network: {
      fetch: async () => Response.json({
        code: 0,
        data: { extract_result: [{ state: "running", extract_progress: { extracted_pages: 2, total_pages: 9 } }] },
      }),
    },
  };
  const message = await recoverBatch({ batchId }, ctx);
  assert.match(message, /仍在解析中/);
  assert.match(message, /2\/9 页/);
  const jobs = await listJobs(dir);
  assert.equal(jobs[0].state, "running");
  assert.equal(jobs[0].stateLabel, "解析中");
  assert.deepEqual(jobs[0].progress, { extractedPages: 2, totalPages: 9, startTime: null, queue: null });
});

test("recover_batch rejects a malformed batch id before touching the network", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mineru-jobs-"));
  const ctx = {
    dataDir: dir, sessionId: "session-test", stageFile: () => {},
    config: { get: async () => "test-token" },
    network: { fetch: () => { throw new Error("network must not be reached"); } },
  };
  for (const bad of ["not-a-batch", "", "../etc/passwd", "a".repeat(200), 42, null]) {
    await assert.rejects(() => recoverBatch({ batchId: bad }, ctx), /Invalid batchId/, `expected rejection for ${JSON.stringify(bad)}`);
  }
});

test("accepts both precision batch ids and lightweight agent task ids", () => {
  // 精准通道：严格 UUID
  assert.equal(isSafeResultId("a6382aec-d809-47f5-afdc-eacdc83b5973"), true);
  // 轻量通道：最后一段 13/14 位十六进制（MinerU 实测形状）
  assert.equal(isSafeResultId("a90e6ab6-44f3-4554-b459-b62fe4c6b43605"), true);
  assert.equal(isSafeResultId("11556203-2a18-46cc-9e2a-54843cd14bdc12"), true);
  // 短错字 / 路径穿越 / 非法类型
  assert.equal(isSafeResultId("not-a-batch"), false);
  assert.equal(isSafeResultId("../escape"), false);
  assert.equal(isSafeResultId("has space here"), false);
  assert.equal(isSafeResultId(null), false);
});

test("persists failure and exposes bounded error in history", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mineru-jobs-"));
  const jobDir = path.join(dir, "jobs", jobId);
  await fs.mkdir(jobDir, { recursive: true });
  await fs.writeFile(path.join(jobDir, "metadata.json"), JSON.stringify({ state: "pending", batchId, fileName: "sample.pdf" }));
  const ctx = {
    dataDir: dir, sessionId: "session-test", stageFile: () => { throw new Error("unexpected stage"); },
    config: { get: async () => "test-token" },
    network: { fetch: async () => Response.json({ code: 0, data: { extract_result: [{ state: "failed", err_msg: "Invalid document" }] } }) },
  };
  await assert.rejects(() => recoverBatch({ batchId }, ctx), /Invalid document/);
  const jobs = await listJobs(dir);
  assert.equal(jobs[0].state, "failed");
  assert.equal(jobs[0].error, "Invalid document");
  await updateJob(dir, jobId, { state: "pending", error: null });
  assert.equal((await listJobs(dir))[0].state, "pending");
});
