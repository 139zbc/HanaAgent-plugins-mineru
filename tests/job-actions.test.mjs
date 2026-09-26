import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { deleteJob, describeDeletion, isInProgressState, isInProgressJob, effectiveState } from "../mineru-document-workbench/lib/job-actions.v2.js";

const JOB_ID = "9e8e4938-3f27-4ef2-89d7-27f8ab627aa1";
const BATCH_ID = "a6382aec-d809-47f5-afdc-eacdc83b5973";
const OTHER_JOB = "5c1f9a2b-7d3e-4c88-9b21-0f4e6a8d1b23";

async function makeDataDir({ state = "done", withResults = true, batchId = BATCH_ID } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mineru-delete-"));
  const jobDir = path.join(dir, "jobs", JOB_ID);
  await fs.mkdir(jobDir, { recursive: true });
  await fs.writeFile(path.join(jobDir, "metadata.json"), JSON.stringify({
    jobId: JOB_ID, batchId, fileName: "sample.pdf", state, createdAt: "2026-09-25T00:00:00Z",
  }));
  // 一个不该被牵连的邻居任务
  const otherDir = path.join(dir, "jobs", OTHER_JOB);
  await fs.mkdir(otherDir, { recursive: true });
  await fs.writeFile(path.join(otherDir, "metadata.json"), JSON.stringify({ jobId: OTHER_JOB, state: "done", fileName: "keep.pdf" }));

  if (withResults && batchId) {
    const resultDir = path.join(dir, "recovered", batchId);
    await fs.mkdir(path.join(resultDir, "images"), { recursive: true });
    await fs.writeFile(path.join(resultDir, "full.md"), "# Result");
    await fs.writeFile(path.join(resultDir, "images", "a.png"), Buffer.alloc(2048));
  }
  return dir;
}

async function exists(p) {
  try { await fs.access(p); return true; } catch { return false; }
}

test("classifies in-progress states", () => {
  for (const s of ["pending", "running", "converting", "uploading", "waiting-file", "submitting"]) {
    assert.equal(isInProgressState(s), true, `${s} should be in progress`);
  }
  for (const s of ["done", "failed", "interrupted_before_batch_id", "unknown"]) {
    assert.equal(isInProgressState(s), false, `${s} should not be in progress`);
  }
});

test("describes what a deletion would remove", async () => {
  const dir = await makeDataDir();
  const info = await describeDeletion(dir, JOB_ID);
  assert.equal(info.fileName, "sample.pdf");
  assert.equal(info.inProgress, false);
  assert.equal(info.hasResults, true);
  assert.ok(info.resultBytes >= 2048, `expected result bytes >= 2048, got ${info.resultBytes}`);
  assert.equal(info.totalBytes, info.jobBytes + info.resultBytes);
  assert.equal(await describeDeletion(dir, "not-a-job-id"), null);
});

test("deletes the record together with its result files, leaving neighbours alone", async () => {
  const dir = await makeDataDir();
  const result = await deleteJob(dir, JOB_ID);
  assert.equal(result.ok, true);
  assert.equal(result.fileName, "sample.pdf");

  assert.equal(await exists(path.join(dir, "jobs", JOB_ID)), false, "job dir should be gone");
  assert.equal(await exists(path.join(dir, "recovered", BATCH_ID)), false, "result dir should be gone");
  // 邻居必须完好
  assert.equal(await exists(path.join(dir, "jobs", OTHER_JOB, "metadata.json")), true);
});

test("refuses to delete an in-progress job unless explicitly forced", async () => {
  const dir = await makeDataDir({ state: "pending" });
  const refused = await deleteJob(dir, JOB_ID);
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, "active");
  assert.equal(refused.state, "pending");
  // 拒绝时不能有任何破坏
  assert.equal(await exists(path.join(dir, "jobs", JOB_ID, "metadata.json")), true);
  assert.equal(await exists(path.join(dir, "recovered", BATCH_ID)), true);

  const forced = await deleteJob(dir, JOB_ID, { allowActive: true });
  assert.equal(forced.ok, true);
  assert.equal(await exists(path.join(dir, "jobs", JOB_ID)), false);
  assert.equal(await exists(path.join(dir, "recovered", BATCH_ID)), false);
});

test("reports missing and malformed ids without touching the filesystem", async () => {
  const dir = await makeDataDir();
  assert.deepEqual(await deleteJob(dir, "not-a-job-id"), { ok: false, reason: "invalid_id" });
  assert.deepEqual(await deleteJob(dir, null), { ok: false, reason: "invalid_id" });
  const missing = await deleteJob(dir, "11111111-1111-4111-8111-111111111111");
  assert.equal(missing.ok, false);
  assert.equal(missing.reason, "not_found");
  // 已有任务不受影响
  assert.equal(await exists(path.join(dir, "jobs", JOB_ID, "metadata.json")), true);
});

test("deletes a job that has no result files", async () => {
  const dir = await makeDataDir({ withResults: false, batchId: null });
  const result = await deleteJob(dir, JOB_ID);
  assert.equal(result.ok, true);
  assert.equal(result.resultBytes, 0);
  assert.equal(await exists(path.join(dir, "jobs", JOB_ID)), false);
});

test("never deletes outside the plugin data directory", async () => {
  const dir = await makeDataDir();
  const outside = path.join(dir, "keep-me.txt");
  await fs.writeFile(outside, "important");
  // 各种越界写法都必须被当作非法 id 拒绝
  for (const evil of ["../keep-me.txt", "..", "../../", "recovered/..", "a/../../b"]) {
    const r = await deleteJob(dir, evil);
    assert.equal(r.ok, false, `expected refusal for ${JSON.stringify(evil)}`);
    assert.equal(r.reason, "invalid_id");
  }
  assert.equal(await exists(outside), true, "file outside jobs/ must survive");
  assert.equal(await exists(path.join(dir, "jobs", JOB_ID, "metadata.json")), true);
});

test("treats an interrupted submit as deletable, not as an active task", async () => {
  // submitting 且无 batchId = 永远不会再推进的残留（listJobs 显示为「已中断」）
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mineru-delete-stale-"));
  const jobDir = path.join(dir, "jobs", JOB_ID);
  await fs.mkdir(jobDir, { recursive: true });
  await fs.writeFile(path.join(jobDir, "metadata.json"), JSON.stringify({
    jobId: JOB_ID, fileName: "stale.pdf", state: "submitting", createdAt: "2026-09-25T00:00:00Z",
  }));

  assert.equal(effectiveState({ state: "submitting" }), "interrupted_before_batch_id");
  assert.equal(isInProgressJob({ state: "submitting" }), false);

  const info = await describeDeletion(dir, JOB_ID);
  assert.equal(info.inProgress, false);
  assert.equal(info.state, "interrupted_before_batch_id");

  // 无需 force 即可删除
  const result = await deleteJob(dir, JOB_ID);
  assert.equal(result.ok, true);
  assert.equal(await exists(path.join(dir, "jobs", JOB_ID)), false);
});

test("still treats a genuinely submitting job (with batchId) as active", async () => {
  assert.equal(effectiveState({ state: "submitting", batchId: "abc" }), "submitting");
  assert.equal(isInProgressJob({ state: "submitting", batchId: "abc" }), true);
});
