import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// 设置页的呈现完全由 manifest 的配置 schema 决定（宿主 PluginsTab 直接读 schema）：
//   boolean → 开关；有 enum → 下拉；object/array → 多行文本；其余 → 输入框
//   字符串字段若 sensitive:true，输入框是 password 且 GET /config 返回 ********，
//   因此「能看见 Token」只能靠 sensitive:false。
// 这些断言把这个契约钉住，避免以后有人「顺手」改回去。
const here = path.dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(await fs.readFile(path.join(here, "..", "manifest.json"), "utf8"));
const properties = manifest.contributes.configuration.properties;

test("the API token is viewable in plugin settings", () => {
  const token = properties.apiToken;
  assert.ok(token, "apiToken must stay declared");
  // 宿主对 sensitive:true 的字段一律 password 输入框 + 脱敏返回值，无法查看；
  // 这里刻意设为 false，让用户能直接核对与复制 Token。
  assert.notEqual(token.sensitive, true);
  assert.match(token.description, /可见/);
});

test("the translation model is not a plugin setting anymore", () => {
  // 模型只在插件页面上选择，记忆存在插件私有 agent 里
  assert.equal(properties.translationModel, undefined);
  assert.equal(properties.translationTargetLanguage.type, "string");
});

test("the default target language renders as a dropdown and defaults to 中文", () => {
  const lang = properties.translationTargetLanguage;
  assert.ok(Array.isArray(lang.enum), "enum is what makes the host render a select");
  assert.equal(lang.default, "中文");
  assert.equal(lang.enum[0], "中文");
  // 宿主会校验写入值必须落在 enum 内
  assert.ok(lang.enum.includes(lang.default));
  for (const item of lang.enum) assert.equal(typeof item, "string");
  assert.ok(lang.enum.length >= 10);
});

test("the page and the manifest agree on the language list", async () => {
  const panelJs = await fs.readFile(path.join(here, "..", "assets", "panel.js"), "utf8");
  const match = /const TARGET_LANGUAGES = \[([\s\S]*?)\];/.exec(panelJs);
  assert.ok(match, "TARGET_LANGUAGES must exist in panel.js");
  const pageList = match[1].split(",").map((item) => item.trim().replace(/^"|"$/g, "")).filter(Boolean);
  assert.deepEqual(
    pageList,
    properties.translationTargetLanguage.enum,
    "the page dropdown and the settings dropdown must not drift apart",
  );
});

test("the parse mode setting stays a dropdown too", () => {
  const mode = properties.modelVersion;
  assert.deepEqual(mode.enum, ["vlm", "pipeline", "agent"]);
  assert.equal(mode.default, "vlm");
});
