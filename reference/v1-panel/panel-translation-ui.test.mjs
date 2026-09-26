import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// 页面脚本与样式无法在 Node 里挂载 DOM，所以这里做源码级断言。
// 目的不是复述实现，而是钉住两个已经真实发生过的回归。
const here = path.dirname(fileURLToPath(import.meta.url));
const panelPath = path.join(here, "panel.js");
const panelJs = await fs.readFile(panelPath, "utf8");
const panelCss = await fs.readFile(path.join(here, "panel.css"), "utf8");

// 从真实源码里抽出 normalizeLanguage 来执行，避免测试重写一份逻辑而与实现漂移。
async function loadNormalizeLanguage() {
  const map = /const LANGUAGE_ALIASES = \{[\s\S]*?\n\};/.exec(panelJs);
  const fn = /function normalizeLanguage\(value\) \{[\s\S]*?\n\}/.exec(panelJs);
  assert.ok(map, "LANGUAGE_ALIASES must exist in assets/panel.js");
  assert.ok(fn, "normalizeLanguage must exist in assets/panel.js");
  return new Function(`${map[0]}\n${fn[0]}\nreturn normalizeLanguage;`)();
}

test("a stored English language name is normalized to the list entry", async () => {
  const normalize = await loadNormalizeLanguage();
  // 用户之前手输过 English，配置里就是它；不能因此让菜单同时出现 English 和 英语
  assert.equal(normalize("English"), "英语");
  assert.equal(normalize("  english  "), "英语");
  assert.equal(normalize("Japanese"), "日语");
  // 旧的「简体中文」也要归一到列表里的「中文」，否则同一语言会出现两项
  assert.equal(normalize("简体中文"), "中文");
  assert.equal(normalize("chinese"), "中文");
  assert.equal(normalize("中文"), "中文", "already canonical values pass through");
  assert.equal(normalize("粤语"), "粤语", "unknown values are kept, not dropped");
  assert.equal(normalize(""), "");
  assert.equal(normalize(null), "");
});

test("hidden actually hides: the CSS keeps a global [hidden] rule", () => {
  // .translation-bar 带 display:flex，会盖过浏览器默认的 [hidden]{display:none}，
  // 导致「只在译文页签显示」的翻译工具条永远显示（真实发生过的 bug）。
  assert.match(panelCss, /\[hidden\]\{display:none!important\}/);
  assert.match(panelCss, /\.translation-bar\{display:flex/);
});

test("the translation bar is tied to the 译文 tab and only when translations exist", () => {
  assert.match(panelJs, /bar\.hidden = kind !== "translation" \|\| !translations\.length/);
  // 页签高亮跟随当前视图
  assert.match(panelJs, /classList\.toggle\("active", tab === kind\)/);
});

test("target language is a dropdown, not a free-text input", () => {
  // 旧实现是 <input list="langPresets"> + <datalist>，已移除
  assert.doesNotMatch(panelJs, /id="translateLang"/);
  assert.doesNotMatch(panelJs, /langPresets/);
  assert.doesNotMatch(panelJs, /id="translateLang"\)\.value/);
  // 新实现：触发器 + 列表 + 选中勾
  assert.match(panelJs, /id="langTrigger"/);
  assert.match(panelJs, /id="langMenu"/);
  assert.match(panelJs, /id="langValue"/);
  assert.match(panelCss, /\.lang-menu\{/);
  assert.match(panelCss, /\.lang-option\[aria-selected="true"\] \.lang-check\{opacity:1\}/);
});

test("the language list covers the common set, starts with 中文, and can carry an out-of-list stored value", () => {
  const match = /const TARGET_LANGUAGES = \[([\s\S]*?)\];/.exec(panelJs);
  assert.ok(match, "TARGET_LANGUAGES must exist");
  const list = match[1].split(",").map((item) => item.trim().replace(/^"|"$/g, "")).filter(Boolean);
  for (const lang of ["中文", "繁体中文", "英语", "日语", "韩语", "法语", "德语"]) {
    assert.ok(list.includes(lang), `missing ${lang}`);
  }
  assert.ok(list.length >= 10);
  // 默认值就是列表第一项，且页面初始值取它
  assert.equal(list[0], "中文");
  assert.match(panelJs, /let targetLanguage = TARGET_LANGUAGES\[0\];/);
  // 归一化后仍不在列表里的值（例如「粤语」）要作为额外一项放最前，不能被丢掉
  assert.match(panelJs, /: \[targetLanguage, \.\.\.TARGET_LANGUAGES\]/);
  assert.match(panelJs, /const value = normalizeLanguage\(lang\);/);
});

test("starting a translation uses the dropdown value, and the copy instruction falls back to it", () => {
  assert.match(panelJs, /const language = currentTargetLanguage\(\);/);
  assert.match(panelJs, /targetLanguage: language, model/);
  assert.match(panelJs, /currentTranslationLang\(\) \|\| currentTargetLanguage\(\)/);
});

test("the dropdown closes on outside click, Escape and selection", () => {
  assert.match(panelJs, /if \(holder && !holder\.contains\(event\.target\)\) closeLangMenu\(\)/);
  assert.match(panelJs, /event\.key === "Escape"/);
  assert.match(panelJs, /item\.onclick = \(\) => \{ setTargetLanguage\(lang\); closeLangMenu\(\); \}/);
});
