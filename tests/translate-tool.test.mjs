import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execute, parameters, sessionPermission } from "../tools/translate_result.js";
import { getJob } from "../job-store.v6.js";

const JOB_ID = "4f8f0d1c-6f2a-4f3b-9a3e-2c1d5b7e9a01";
const BATCH_ID = "9c1b2d3e-4f50-4a6b-8c7d-1e2f3a4b5c6d";

async function makeFixture() {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "mineru-tool-"));
  const resultDir = path.join(dataDir, "recovered", BATCH_ID);
  await fs.mkdir(resultDir, { recursive: true });
  const markdownPath = path.join(resultDir, "full.md");
  const markdown = [
    "# Demo report",
    "",
    "The parser converts files into Markdown.",
    "",
    "```python",
    "print(\"hello\")",
    "```",
    "",
    "Support replies within one business day.",
  ].join("\n");
  await fs.writeFile(markdownPath, markdown, "utf8");
  const jobDir = path.join(dataDir, "jobs", JOB_ID);
  await fs.mkdir(jobDir, { recursive: true });
  await fs.writeFile(path.join(jobDir, "metadata.json"), JSON.stringify({
    jobId: JOB_ID,
    state: "done",
    channel: "precision",
    batchId: BATCH_ID,
    fileName: "demo.pdf",
    markdownPath,
    jsonPaths: [],
    createdAt: new Date().toISOString(),
  }, null, 2), "utf8");
  return { dataDir, markdownPath, markdown };
}

function makeCtx(dataDir, { modelCall } = {}) {
  const modelCalls = [];
  const staged = [];
  const ctx = {
    dataDir,
    pluginId: "mineru-document-workbench",
    sessionId: "session-1",
    sessionRef: null,
    sessionPath: null,
    log: { warn: () => {} },
    config: { get: async () => undefined },
    bus: {
      request: async (type, payload) => {
        // 翻译模型现在从插件私有 agent 读（"上次在页面上选的"），不再从插件配置读
        if (type === "agent:profile") {
          assert.equal(payload.agentId, "mineru-translator");
          return { profile: { models: { utility: { id: "MiniMax-M3", provider: "minimax" } } } };
        }
        if (type === "model:sample-text") {
          modelCalls.push(payload);
          if (modelCall) return modelCall(payload);
          return { text: `<translate_input>\n[zh] ${payload.messages[0].content.trim()}\n</translate_input>` };
        }
        return { ok: true };
      },
    },
    stageFile: ({ filePath, label }) => {
      staged.push({ filePath, label });
      return { mediaItem: { kind: "session_file", filePath, label } };
    },
  };
  return { ctx, modelCalls, staged };
}

test("translate_result translates text, preserves code fences and stages the output", async () => {
  const { dataDir, markdown } = await makeFixture();
  const { ctx, modelCalls, staged } = makeCtx(dataDir);

  const result = await execute({ jobId: JOB_ID, targetLanguage: "中文" }, ctx);

  // 只翻译正文：模板要求不翻译代码，代码块不送模型
  const sent = modelCalls.map((call) => call.messages[0].content).join("\n");
  assert.ok(sent.includes("The parser converts files into Markdown."));
  assert.ok(!sent.includes("print("), "code must never be sent to the model");

  // 系统提示词是用户给定模板，且只替换了目标语言与输入
  assert.match(modelCalls[0].systemPrompt, /You are a translation expert\./);
  assert.ok(!modelCalls[0].systemPrompt.includes("print("));
  // agentId 指向插件私有模型 agent
  assert.equal(modelCalls[0].agentId, "mineru-translator");
  const outputPath = path.join(dataDir, "recovered", BATCH_ID, "translated.中文.md");
  const output = await fs.readFile(outputPath, "utf8");
  assert.match(output, /\[zh\] # Demo report/);
  assert.ok(output.includes("```python\nprint(\"hello\")\n```"), "code fence must survive untouched");
  assert.ok(output.includes("[zh] Support replies within one business day."));
  // 段落分隔不得被吞掉
  assert.ok(output.includes("\n\n"), "paragraph breaks must be preserved");

  // 交付与记录
  assert.equal(staged.length, 1);
  assert.equal(staged[0].filePath, outputPath);
  assert.equal(staged[0].label, "translated.中文.md");
  const job = await getJob(dataDir, JOB_ID);
  assert.equal(job.translations.length, 1);
  assert.equal(job.translations[0].lang, "中文");
  assert.equal(job.translations[0].failedChunks, 0);
  assert.equal(job.translations[0].file, "translated.中文.md");
  assert.match(result.content[0].text, /翻译为 中文/);

  await fs.rm(dataDir, { recursive: true, force: true });
});

test("translate_result keeps the original text when a chunk fails and reports it", async () => {
  const { dataDir } = await makeFixture();
  let calls = 0;
  const { ctx, staged } = makeCtx(dataDir, {
    modelCall: () => {
      calls += 1;
      throw new Error("模型未回复正文");
    },
  });

  const result = await execute({ jobId: JOB_ID, targetLanguage: "English" }, ctx);

  // 每个片段重试两次，失败后保留原文
  assert.ok(calls >= 2);
  const outputPath = path.join(dataDir, "recovered", BATCH_ID, "translated.English.md");
  const output = await fs.readFile(outputPath, "utf8");
  assert.ok(output.includes("The parser converts files into Markdown."));
  const job = await getJob(dataDir, JOB_ID);
  assert.ok(job.translations[0].failedChunks >= 1);
  assert.match(result.content[0].text, /片段翻译失败/);
  assert.equal(staged.length, 1);

  await fs.rm(dataDir, { recursive: true, force: true });
});

test("translate_result validates its inputs and refuses unfinished jobs", async () => {
  const { dataDir } = await makeFixture();
  const { ctx } = makeCtx(dataDir);
  await assert.rejects(() => execute({ jobId: "not-a-uuid", targetLanguage: "中文" }, ctx), /Invalid jobId/);
  await assert.rejects(() => execute({ jobId: JOB_ID }, ctx), /targetLanguage is required/);
  await assert.rejects(() => execute({ jobId: "11111111-1111-1111-1111-111111111111", targetLanguage: "中文" }, ctx), /Job not found/);
  await fs.rm(dataDir, { recursive: true, force: true });
});

test("translate_result declares its side effect for the session permission check", () => {
  assert.equal(parameters.required.join(","), "jobId,targetLanguage");
  const described = sessionPermission.describeSideEffect();
  assert.equal(described.kind, "session_file_output");
  assert.ok(described.summary.length > 0);
});
