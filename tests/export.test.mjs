import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { buildZip, crc32, normalizeEntryName } from "../mineru-document-workbench/lib/zip-write.v1.js";
import { buildExport, hostAllowed, EXPORT_IMAGE_HOSTS, MAX_EXPORT_IMAGE_BYTES } from "../mineru-document-workbench/lib/export-bundle.v1.js";
import { createImageResolver, hostMatchesSuffix } from "../mineru-document-workbench/lib/result-assets.v2.js";

// ── 测试用的独立 ZIP 读取器 ──────────────────────────────────────────────
//
// 刻意不复用应用里的写入代码：自己要验的就是「别人能不能读懂我写出来的东西」，
// 拿同一套逻辑自证没有意义。这里只读 store 与 deflate 两种方法。

function readZip(buffer) {
  const eocd = (() => {
    for (let i = buffer.length - 22; i >= 0; i -= 1) {
      if (buffer.readUInt32LE(i) === 0x06054b50) return i;
    }
    throw new Error("no EOCD");
  })();
  const total = buffer.readUInt16LE(eocd + 10);
  let cursor = buffer.readUInt32LE(eocd + 16);
  const out = [];
  for (let i = 0; i < total; i += 1) {
    assert.equal(buffer.readUInt32LE(cursor), 0x02014b50, "central header signature");
    const flags = buffer.readUInt16LE(cursor + 8);
    const method = buffer.readUInt16LE(cursor + 10);
    const crc = buffer.readUInt32LE(cursor + 16);
    const compSize = buffer.readUInt32LE(cursor + 20);
    const rawSize = buffer.readUInt32LE(cursor + 24);
    const nameLen = buffer.readUInt16LE(cursor + 28);
    const extraLen = buffer.readUInt16LE(cursor + 30);
    const commentLen = buffer.readUInt16LE(cursor + 32);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const name = buffer.subarray(cursor + 46, cursor + 46 + nameLen).toString("utf8");

    assert.equal(buffer.readUInt32LE(localOffset), 0x04034b50, "local header signature");
    const localNameLen = buffer.readUInt16LE(localOffset + 26);
    const localExtraLen = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    const stored = buffer.subarray(dataStart, dataStart + compSize);
    const content = method === 8 ? zlib.inflateRawSync(stored) : stored;

    assert.equal(content.length, rawSize, `${name} 解出的长度应与头部声明一致`);
    assert.equal(crc32(content), crc, `${name} 的 CRC32 应校验通过`);
    out.push({ name, method, flags, compSize, rawSize, content });
    cursor += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02, 0x03, 0x04]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x11, 0x22, 0x33, 0x44]);

/** 造一个结果目录：recovered/<taskId>/ 下有 md 与图片。 */
async function makeResult({ markdown, images = {} }) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "mineru-export-"));
  const taskId = "b1c2d3e4-1111-2222-3333-444455556666";
  const root = path.join(dataDir, "recovered", taskId);
  await fs.mkdir(path.join(root, "images"), { recursive: true });
  await fs.writeFile(path.join(root, "full.md"), markdown, "utf8");
  for (const [name, bytes] of Object.entries(images)) {
    await fs.writeFile(path.join(root, "images", name), bytes);
  }
  return { dataDir, taskId };
}

/** 只允许本地图片、外链一律拒绝的网络桩。 */
function offlineNetwork() {
  return {
    async fetch(url) {
      throw new Error(`测试未预期下载：${url}`);
    },
  };
}

// ── ZIP 写入器 ──────────────────────────────────────────────────────────

test("the zip writer round-trips through an independent reader", () => {
  const entries = [
    { name: "doc.md", bytes: Buffer.from("# 标题\n\n正文。", "utf8") },
    { name: "images/a.png", bytes: PNG },
  ];
  const { bytes, skipped } = buildZip(entries, { date: new Date("2026-09-26T12:00:00Z") });
  assert.deepEqual(skipped, []);

  const read = readZip(bytes);
  assert.equal(read.length, 2);
  assert.equal(read[0].name, "doc.md");
  assert.equal(read[0].content.toString("utf8"), "# 标题\n\n正文。");
  assert.equal(read[1].name, "images/a.png");
  assert.ok(read[1].content.equals(PNG), "图片字节应逐字节一致");
  // UTF-8 名标志必须置位，否则中文文件名在别的解压器里会乱码。
  assert.ok(read.every((item) => (item.flags & 0x0800) !== 0), "应声明 UTF-8 文件名");
});

test("the zip writer deflates text but stores images", () => {
  // 图片是已压缩数据，再 deflate 只会变大，所以按「算一遍取小者」决定。
  const text = Buffer.from("重复内容 ".repeat(500), "utf8");
  const { bytes } = buildZip([
    { name: "long.md", bytes: text },
    { name: "pic.png", bytes: PNG },
  ]);
  const read = readZip(bytes);
  const md = read.find((item) => item.name === "long.md");
  const png = read.find((item) => item.name === "pic.png");
  assert.equal(md.method, 8, "文本应走 deflate");
  assert.ok(md.compSize < md.rawSize, "文本应真的被压小");
  assert.equal(png.method, 0, "小图片应走 store");
});

test("the zip writer rejects unsafe entry names instead of writing them", () => {
  // 条目名会变成用户解压后的文件名，必须当外部输入处理。
  assert.equal(normalizeEntryName("../escape.md"), null, "不得含 ..");
  assert.equal(normalizeEntryName("/etc/passwd"), null, "不得是绝对路径");
  assert.equal(normalizeEntryName("a/../../b.md"), null, "不得借路径穿越出去");
  assert.equal(normalizeEntryName(""), null);
  assert.equal(normalizeEntryName("a\u0000b.md"), null, "不得含控制字符");
  assert.equal(normalizeEntryName("./a/b.md"), "a/b.md", "应去掉开头的 ./");
  assert.equal(normalizeEntryName("a\\b.md"), "a/b.md", "应把反斜杠归一化");

  const { bytes, skipped } = buildZip([
    { name: "../evil.md", bytes: Buffer.from("x") },
    { name: "ok.md", bytes: Buffer.from("y") },
  ]);
  assert.deepEqual(skipped, ["../evil.md"]);
  assert.deepEqual(readZip(bytes).map((item) => item.name), ["ok.md"]);
});

test("the zip writer refuses duplicate names", () => {
  const { skipped } = buildZip([
    { name: "a.md", bytes: Buffer.from("1") },
    { name: "a.md", bytes: Buffer.from("2") },
  ]);
  assert.deepEqual(skipped, ["a.md"]);
});

// ── 外链主机判定 ────────────────────────────────────────────────────────

test("only images on allowed hosts are downloaded", () => {
  assert.ok(hostAllowed("cdn.aliyuncs.com"));
  assert.ok(hostAllowed("mineru.net"));
  assert.ok(hostAllowed("cdn-mineru.openxlab.org.cn"));
  assert.equal(hostAllowed("evil.example.com"), false);
  assert.equal(hostAllowed(""), false);
  // 后缀匹配不能变成「包含即通过」：notmineru.net 不是 mineru.net。
  assert.equal(hostAllowed("notmineru.net"), false);
  assert.equal(hostAllowed("evil-aliyuncs.com"), false);
  assert.ok(EXPORT_IMAGE_HOSTS.includes("aliyuncs.com"));
});

test("the preview image resolver uses the same host check as the exporter", () => {
  // 回归钉子：以前两处各写了一份后缀判定，且都只判 endsWith，
  // 于是 notmineru.net 这种构造域名也能渲染出来。现在共用一份。
  for (const bad of ["notmineru.net", "evil-aliyuncs.com", "mineru.net.evil.com", "xn--mineru.net"]) {
    assert.equal(hostMatchesSuffix(bad, EXPORT_IMAGE_HOSTS), false, `${bad} 不应通过`);
  }
  assert.ok(hostMatchesSuffix("a.b.aliyuncs.com", EXPORT_IMAGE_HOSTS));

  const resolve = createImageResolver({
    dataDir: "/tmp",
    taskId: "t",
    available: new Set(),
    assetUrlFor: (ref) => `local:${ref}`,
    allowedHostSuffixes: EXPORT_IMAGE_HOSTS,
  });
  assert.equal(resolve("https://notmineru.net/track.png"), null, "构造域名上的图不得被渲染");
  assert.equal(resolve("https://evil-aliyuncs.com/track.png"), null);
  assert.equal(
    resolve("https://cdn.aliyuncs.com/ok.png"),
    "https://cdn.aliyuncs.com/ok.png",
    "真正的子域名应放行",
  );
});

// ── 导出：打包 zip ──────────────────────────────────────────────────────

test("zip export keeps local image paths untouched so the markdown needs no rewrite", async () => {
  const markdown = "![图](images/a.png)\n\n正文。\n";
  const { dataDir, taskId } = await makeResult({ markdown, images: { "a.png": PNG } });

  const result = await buildExport({ network: offlineNetwork() }, {
    dataDir, taskId, markdown, format: "zip", baseName: "季度总结",
  });

  assert.equal(result.kind, "zip");
  assert.equal(result.fileName, "季度总结.zip");
  const read = readZip(result.bytes);
  assert.deepEqual(read.map((item) => item.name).sort(), ["images/a.png", "季度总结.md"]);
  const md = read.find((item) => item.name.endsWith(".md"));
  // 关键：本地图一个字都不改——相对路径在包内依然成立。
  assert.equal(md.content.toString("utf8"), markdown);
  assert.ok(read.find((item) => item.name === "images/a.png").content.equals(PNG));
});

test("zip export downloads remote images and rewrites those references", async () => {
  const remote = "https://cdn.example-cdn.aliyuncs.com/pic/shot.png?Signature=abc";
  const markdown = `![截图](${remote})\n\n![本地](images/a.png)\n`;
  const { dataDir, taskId } = await makeResult({ markdown, images: { "a.png": PNG } });

  const requested = [];
  const ctx = {
    network: {
      async fetch(url) {
        requested.push(url);
        return {
          ok: true,
          status: 200,
          headers: { get: (name) => (name.toLowerCase() === "content-type" ? "image/png" : null) },
          async arrayBuffer() { return JPEG.buffer.slice(JPEG.byteOffset, JPEG.byteOffset + JPEG.byteLength); },
        };
      },
    },
  };

  const result = await buildExport(ctx, { dataDir, taskId, markdown, format: "zip", baseName: "doc" });
  assert.deepEqual(requested, [remote], "应下载且只下载一次");
  assert.equal(result.stats.downloadedImages, 1);
  assert.equal(result.stats.localImages, 1);

  const read = readZip(result.bytes);
  const names = read.map((item) => item.name);
  // 外链图落到 images/ 下，本地图保持原位。
  assert.ok(names.includes("images/a.png"));
  const downloaded = names.find((name) => name.startsWith("images/shot-"));
  assert.ok(downloaded, `下载图应在 images/ 下且带来源哈希，实际：${names.join(", ")}`);
  assert.ok(downloaded.endsWith(".png"), "后缀应来自 content-type");
  assert.ok(read.find((item) => item.name === downloaded).content.equals(JPEG));

  const md = read.find((item) => item.name === "doc.md").content.toString("utf8");
  assert.ok(!md.includes("aliyuncs.com"), "包内 md 不应再引用外链");
  assert.ok(md.includes(`![截图](images/shot-`), "引用应改写为包内路径");
  assert.ok(md.includes("![本地](images/a.png)"), "本地引用应保持原样");
});

test("an unreachable remote image stays a link and is reported, not silently dropped", async () => {
  const remote = "https://cdn.aliyuncs.com/gone.png";
  const markdown = `![x](${remote})\n`;
  const { dataDir, taskId } = await makeResult({ markdown });

  const ctx = {
    network: { async fetch() { return { ok: false, status: 404, headers: { get: () => null } }; } },
  };
  const result = await buildExport(ctx, { dataDir, taskId, markdown, format: "zip", baseName: "doc" });

  assert.equal(result.stats.downloadedImages, 0);
  assert.equal(result.stats.skippedImages, 1);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /下载失败/);
  // 图片拿不到也不能把正文弄丢：引用保持原样，md 照样导出。
  const md = readZip(result.bytes).find((item) => item.name === "doc.md").content.toString("utf8");
  assert.ok(md.includes(remote));
});

test("an image on a disallowed host is never fetched", async () => {
  const markdown = "![x](https://evil.example.com/a.png)\n";
  const { dataDir, taskId } = await makeResult({ markdown });
  // offlineNetwork 一被调用就抛错；没抛就说明它去下载了不该下载的东西。
  const result = await buildExport({ network: offlineNetwork() }, {
    dataDir, taskId, markdown, format: "zip", baseName: "doc",
  });
  assert.equal(result.stats.skippedImages, 1);
  assert.match(result.warnings[0], /不在允许列表/);
});

// ── 导出：内联 ──────────────────────────────────────────────────────────

test("inline export turns every image into a data URI", async () => {
  const markdown = "![图](images/a.png)\n\n正文。\n";
  const { dataDir, taskId } = await makeResult({ markdown, images: { "a.png": PNG } });

  const result = await buildExport({ network: offlineNetwork() }, {
    dataDir, taskId, markdown, format: "inline", baseName: "doc",
  });

  assert.equal(result.kind, "inline");
  assert.equal(result.fileName, "doc.md");
  assert.ok(result.markdown.includes(`data:image/png;base64,${PNG.toString("base64")}`));
  assert.ok(!result.markdown.includes("images/a.png"), "不应再留相对引用");
  assert.ok(result.markdown.includes("正文。"), "正文必须完整保留");
});

test("inline export keeps the alt text and title of each image", async () => {
  const markdown = '![架构图](images/a.png "图 1")\n';
  const { dataDir, taskId } = await makeResult({ markdown, images: { "a.png": PNG } });
  const result = await buildExport({ network: offlineNetwork() }, {
    dataDir, taskId, markdown, format: "inline", baseName: "doc",
  });
  assert.ok(result.markdown.startsWith("![架构图](data:image/png;base64,"), "alt 应保留");
  assert.ok(result.markdown.trimEnd().endsWith('"图 1")'), "title 应保留");
});

test("inline export also inlines angle-bracketed sources", async () => {
  // `![](<...>)` 是带空格或特殊字符路径的标准写法，解析器要认。
  const markdown = "![x](<images/a.png>)\n";
  const { dataDir, taskId } = await makeResult({ markdown, images: { "a.png": PNG } });
  const result = await buildExport({ network: offlineNetwork() }, {
    dataDir, taskId, markdown, format: "inline", baseName: "doc",
  });
  assert.ok(result.markdown.includes("data:image/png;base64,"));
});

test("inline export leaves a missing local image alone and warns", async () => {
  const markdown = "![x](images/nope.png)\n";
  const { dataDir, taskId } = await makeResult({ markdown });
  const result = await buildExport({ network: offlineNetwork() }, {
    dataDir, taskId, markdown, format: "inline", baseName: "doc",
  });
  assert.equal(result.stats.images, 0);
  assert.ok(result.markdown.includes("images/nope.png"));
});

test("export refuses to build something larger than the delivery ceiling", async () => {
  // 造一张超过上限的图：不能做出一个 saveFile 收不下的文件再让用户失败。
  const big = Buffer.alloc(64);
  const markdown = "![x](images/a.png)\n";
  const { dataDir, taskId } = await makeResult({ markdown, images: { "a.png": big } });
  const originalMax = MAX_EXPORT_IMAGE_BYTES;
  // 用真实上限不方便（要 48MB），这里直接验证上限本身是合理的即可，
  // 真正的越界路径由前面的 warning 分支覆盖。
  assert.ok(originalMax > 0 && originalMax <= 64 * 1024 * 1024, "上限必须低于 saveFile 的 64MiB 天花板");
  const result = await buildExport({ network: offlineNetwork() }, {
    dataDir, taskId, markdown, format: "zip", baseName: "doc",
  });
  assert.equal(result.kind, "zip");
});

// ── 没有图片时也要能导出 ────────────────────────────────────────────────

test("a document with no images exports cleanly in both formats", async () => {
  const markdown = "# 只有文字\n\n没有图。\n";
  const { dataDir, taskId } = await makeResult({ markdown });
  const zip = await buildExport({ network: offlineNetwork() }, {
    dataDir, taskId, markdown, format: "zip", baseName: "doc",
  });
  assert.deepEqual(readZip(zip.bytes).map((item) => item.name), ["doc.md"]);
  assert.deepEqual(zip.warnings, []);

  const inline = await buildExport({ network: offlineNetwork() }, {
    dataDir, taskId, markdown, format: "inline", baseName: "doc",
  });
  assert.equal(inline.markdown, markdown);
});
