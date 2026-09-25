import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// panel.js 是浏览器端脚本，无法直接 import。这里把它内部真实的 apiPath 实现
// 抽出来执行，避免“测试里重写一份逻辑”而与实际代码漂移。
const here = path.dirname(fileURLToPath(import.meta.url));
const panelPath = path.join(here, "..", "assets", "panel.js");

async function loadApiPath(pluginId = "mineru-document-workbench") {
  const source = await fs.readFile(panelPath, "utf8");
  const match = /function apiPath\(path\) \{[\s\S]*?\n\}/.exec(source);
  assert.ok(match, "apiPath must exist in assets/panel.js");
  const factory = new Function(
    "location",
    `${match[0]}\nreturn apiPath;`,
  );
  return factory({ pathname: `/api/plugins/${pluginId}/page`, origin: "http://127.0.0.1:20811" });
}

test("apiPath accepts result image paths (the .png extension must not be rejected)", async () => {
  const apiPath = await loadApiPath();
  const jobId = "3f23e28e-3aad-467c-bf75-2f7c67610cee";
  const file = "6d8ece3cbf9224e4fbfb771b4e30d3a2fcfbcbf0ed00f42a61922d23c3a1a15c.png";
  const built = apiPath(`jobs/${jobId}/asset/images/${file}`);
  assert.equal(
    built,
    `http://127.0.0.1:20811/api/plugins/mineru-document-workbench/jobs/${jobId}/asset/images/${file}`,
  );
  // 其它带扩展名的常规路径也不能被误拒
  assert.ok(apiPath("jobs/abc/asset/full.md"));
  assert.ok(apiPath("options"));
});

test("apiPath accepts percent-encoded segments such as a Chinese language name", async () => {
  const apiPath = await loadApiPath();
  const jobId = "3f23e28e-3aad-467c-bf75-2f7c67610cee";
  const lang = encodeURIComponent("中文");
  assert.equal(
    apiPath(`jobs/${jobId}/translation/${lang}`),
    `http://127.0.0.1:20811/api/plugins/mineru-document-workbench/jobs/${jobId}/translation/${lang}`,
  );
  assert.ok(apiPath(`jobs/${jobId}/translation/${lang}/download`));
});

test("apiPath still rejects traversal and malformed input", async () => {
  const apiPath = await loadApiPath();
  for (const bad of [
    "jobs/../options",
    "../../options",
    "jobs/a b/options",
    "jobs/%2e%2e/options",
    "jobs/a\\b",
    "jobs/x?y",
    "",
    null,
    42,
  ]) {
    assert.throws(() => apiPath(bad), /Invalid API path/, `expected rejection for ${JSON.stringify(bad)}`);
  }
});
