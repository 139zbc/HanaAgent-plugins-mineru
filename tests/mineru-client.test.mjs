import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { batchItems, downloadResult, pollBatch } from "../mineru-document-workbench/lib/mineru-client.js";

function makeStoredZip(entries) {
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const [name, content] of Object.entries(entries)) {
    const nameBytes = Buffer.from(name);
    const body = Buffer.from(content);
    const local = Buffer.alloc(30 + nameBytes.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(0, 10);
    local.writeUInt32LE(0, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(body.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    nameBytes.copy(local, 30);
    chunks.push(local, body);

    const record = Buffer.alloc(46 + nameBytes.length);
    record.writeUInt32LE(0x02014b50, 0);
    record.writeUInt16LE(20, 4);
    record.writeUInt16LE(20, 6);
    record.writeUInt16LE(0, 8);
    record.writeUInt16LE(0, 10);
    record.writeUInt32LE(0, 12);
    record.writeUInt32LE(0, 16);
    record.writeUInt32LE(body.length, 20);
    record.writeUInt32LE(body.length, 24);
    record.writeUInt16LE(nameBytes.length, 28);
    record.writeUInt16LE(0, 30);
    record.writeUInt16LE(0, 32);
    record.writeUInt16LE(0, 34);
    record.writeUInt16LE(0, 36);
    record.writeUInt32LE(0, 38);
    record.writeUInt32LE(offset, 42);
    nameBytes.copy(record, 46);
    central.push(record);
    offset += local.length + body.length;
  }
  const centralBody = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(central.length, 8);
  eocd.writeUInt16LE(central.length, 10);
  eocd.writeUInt32LE(centralBody.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, centralBody, eocd]);
}

test("downloads and extracts full.md plus JSON files", async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "mineru-test-"));
  const zip = makeStoredZip({ "nested/full.md": "# Hello", "nested/content_list.json": "[]" });
  const ctx = { network: { fetch: async () => new Response(zip, { status: 200 }) } };
  const result = await downloadResult(ctx, { full_zip_url: "https://cdn.example/result.zip" }, temp);
  assert.equal(await fs.readFile(result.markdownPath, "utf8"), "# Hello");
  assert.equal(result.jsonPaths.length, 1);
});

test("reads the actual MinerU extract_result array", async () => {
  const item = { state: "done", full_zip_url: "https://cdn-mineru.openxlab.org.cn/result.zip" };
  assert.deepEqual(batchItems({ batch_id: "batch-1", extract_result: [item] }), [item]);
  const calls = [];
  const ctx = {
    config: { get: async (key) => key === "apiToken" ? "test-only" : undefined },
    network: { fetch: async (url, init) => {
      calls.push({ url, authorization: init.headers.Authorization });
      return Response.json({ code: 0, data: { batch_id: "batch-1", extract_result: [item] } });
    } },
  };
  assert.deepEqual(await pollBatch(ctx, "batch-1", { pollTimeoutMs: 1000 }), item);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].authorization, "Bearer test-only");
});

test("reports last state when polling times out", async () => {
  const ctx = {
    config: { get: async () => "test-only" },
    network: { fetch: async () => Response.json({ code: 0, data: { extract_result: [{ state: "pending" }] } }) },
  };
  await assert.rejects(() => pollBatch(ctx, "batch-1", { pollIntervalMs: 250, pollTimeoutMs: 10 }), /last states: pending/);
});

test("rejects unsafe ZIP paths", async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "mineru-test-"));
  const zip = makeStoredZip({ "../escape.md": "bad" });
  const ctx = { network: { fetch: async () => new Response(zip, { status: 200 }) } };
  await assert.rejects(() => downloadResult(ctx, { full_zip_url: "https://cdn.example/result.zip" }, temp), /Unsafe ZIP entry/);
});
