import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  AGENT_LIMITS, agentErrorText, agentState, downloadAgentMarkdown,
  submitAgentFile, getAgentResult, queryByChannel, submitByMode,
} from "../mineru-document-workbench/lib/parse-channels.v1.js";
import { sanitizePrecisionModel } from "../mineru-document-workbench/lib/mineru-client.js";

// 记录一次请求，便于断言方法/URL/请求头。
function recordingCtx(handler) {
  const calls = [];
  return {
    calls,
    ctx: {
      config: { get: async () => undefined },
      network: {
        fetch: async (url, init = {}) => {
          calls.push({ url: String(url), method: init.method || "GET", headers: init.headers || {}, body: init.body });
          return handler(String(url), init);
        },
      },
    },
  };
}

test("agent submit posts without Authorization and uploads without Content-Type", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mineru-agent-"));
  const filePath = path.join(dir, "sample.pdf");
  await fs.writeFile(filePath, Buffer.from("%PDF-1.4 test"));

  const { ctx, calls } = recordingCtx(async (url) => {
    if (url.endsWith("/api/v1/agent/parse/file")) {
      return Response.json({ code: 0, data: { task_id: "11556203-2a18-46cc-9e2a-54843cd14bdc12", file_url: "https://oss-mineru.openxlab.org.cn/agent/x.pdf?Expires=1" } });
    }
    if (url.startsWith("https://oss-mineru.openxlab.org.cn/")) return new Response("", { status: 200 });
    throw new Error(`unexpected url ${url}`);
  });

  const result = await submitAgentFile(ctx, filePath, "sample.pdf", { isOcr: true });
  assert.equal(result.taskId, "11556203-2a18-46cc-9e2a-54843cd14bdc12");
  assert.equal(result.bytes, Buffer.byteLength("%PDF-1.4 test"));

  assert.equal(calls.length, 2);
  const [submit, upload] = calls;
  assert.equal(submit.method, "POST");
  assert.match(submit.url, /\/api\/v1\/agent\/parse\/file$/);
  // 免 Token 是这个接口的核心性质
  assert.equal(submit.headers.Authorization, undefined);
  const submitBody = JSON.parse(String(submit.body));
  assert.equal(submitBody.file_name, "sample.pdf");
  assert.equal(submitBody.is_ocr, true);

  assert.equal(upload.method, "PUT");
  // MinerU 明确要求上传时不要设置 Content-Type
  assert.equal(upload.headers["Content-Type"], undefined);
  assert.ok(upload.body instanceof Uint8Array);
});

test("agent submit rejects files above the 10MB lightweight limit before any request", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mineru-agent-big-"));
  const filePath = path.join(dir, "big.pdf");
  await fs.writeFile(filePath, Buffer.alloc(AGENT_LIMITS.maxBytes + 1));

  const { ctx, calls } = recordingCtx(async () => { throw new Error("must not be called"); });
  await assert.rejects(() => submitAgentFile(ctx, filePath, "big.pdf"), /10MB/);
  assert.equal(calls.length, 0);
});

test("agent errors surface the documented error codes", async () => {
  const { ctx } = recordingCtx(async () => Response.json({
    code: 0, data: { task_id: "t", state: "failed", err_code: -30003, err_msg: "file page count exceeds lightweight API limit" },
  }));
  const payload = agentState(await getAgentResult(ctx, "t"));
  assert.equal(payload.state, "failed");
  assert.equal(payload.errCode, -30003);
  assert.match(agentErrorText(payload.errCode, payload.errMsg), /页数超出/);
  assert.match(agentErrorText(undefined, "original message"), /original message/);
  assert.equal(agentErrorText(undefined, ""), "Agent 轻量解析失败");
});

test("queryByChannel routes agent tasks to the lightweight endpoint and reports done with a markdown url", async () => {
  const { ctx, calls } = recordingCtx(async () => Response.json({
    code: 0, data: { task_id: "t", state: "done", markdown_url: "https://cdn-mineru.openxlab.org.cn/pdf/t/full.md" },
  }));
  const snapshot = await queryByChannel(ctx, { channel: "agent", taskId: "11556203-2a18-46cc-9e2a-54843cd14bdc12" });
  assert.equal(snapshot.done, true);
  assert.match(snapshot.markdownUrl, /full\.md$/);
  assert.match(calls[0].url, /\/api\/v1\/agent\/parse\//);
  assert.equal(calls[0].method, "GET");
});

test("downloadAgentMarkdown writes full.md and reports no JSON", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mineru-agent-md-"));
  const { ctx } = recordingCtx(async () => new Response("# Title\n\nbody", { status: 200 }));
  const out = await downloadAgentMarkdown(ctx, "https://cdn-mineru.openxlab.org.cn/pdf/t/full.md", dir);
  assert.equal(await fs.readFile(out.markdownPath, "utf8"), "# Title\n\nbody");
  assert.deepEqual(out.jsonPaths, []);
  assert.equal(out.zipPath, null);
});

test("submitByMode uses the agent channel without a token and the precision channel with one", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mineru-mode-"));
  const filePath = path.join(dir, "sample.pdf");
  await fs.writeFile(filePath, Buffer.from("%PDF-1.4"));

  // 轻量通道：没有 apiToken 也应该可行
  const agent = recordingCtx(async (url) => {
    if (url.endsWith("/api/v1/agent/parse/file")) return Response.json({ code: 0, data: { task_id: "agent-task-id-123456", file_url: "https://oss-mineru.openxlab.org.cn/a.pdf" } });
    return new Response("", { status: 200 });
  });
  const agentResult = await submitByMode(agent.ctx, { filePath, fileName: "sample.pdf", modeId: "agent" });
  assert.equal(agentResult.channel, "agent");
  assert.equal(agentResult.batchId, "agent-task-id-123456");
  assert.equal(agentResult.jsonAvailable, false);

  // 精准通道：缺 Token 必须明确报错，并提示可改用 agent
  const precisionNoToken = recordingCtx(async () => { throw new Error("must not be called"); });
  await assert.rejects(
    () => submitByMode(precisionNoToken.ctx, { filePath, fileName: "sample.pdf", modeId: "pipeline" }),
    /token is not configured/,
  );
  assert.equal(precisionNoToken.calls.length, 0);

  // 精准通道：带 Token 时走 /api/v4/file-urls/batch，且发送 model_version
  const precision = recordingCtx(async (url) => {
    if (url.endsWith("/api/v4/file-urls/batch")) return Response.json({ code: 0, data: { batch_id: "a6382aec-d809-47f5-afdc-eacdc83b5973", file_urls: ["https://mineru.oss-cn-shanghai.aliyuncs.com/up"] } });
    return new Response("", { status: 200 });
  });
  precision.ctx.config.get = async (key) => (key === "apiToken" ? "test-token" : undefined);
  const precisionResult = await submitByMode(precision.ctx, { filePath, fileName: "sample.pdf", modeId: "pipeline" });
  assert.equal(precisionResult.channel, "precision");
  assert.equal(precisionResult.modeId, "pipeline");
  assert.equal(JSON.parse(String(precision.calls[0].body)).model_version, "pipeline");
});

test("precision model_version is sanitized so a channel value can never leak to MinerU", () => {
  assert.equal(sanitizePrecisionModel("vlm"), "vlm");
  assert.equal(sanitizePrecisionModel("pipeline"), "pipeline");
  assert.equal(sanitizePrecisionModel("agent"), "vlm");
  assert.equal(sanitizePrecisionModel(undefined), "vlm");
  assert.equal(sanitizePrecisionModel(null), "vlm");
  assert.equal(sanitizePrecisionModel("MinerU-HTML"), "vlm");
});
