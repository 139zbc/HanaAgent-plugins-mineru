import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import zlib from "node:zlib";

const MAX_FILE_BYTES = 200 * 1024 * 1024;
const MAX_ZIP_BYTES = 50 * 1024 * 1024;

async function configValue(ctx, key, fallback) {
  const value = ctx.config?.get ? await ctx.config.get(key) : ctx.config?.[key];
  return value === undefined || value === null || value === "" ? fallback : value;
}

function apiUrl(baseUrl, suffix) {
  return `${String(baseUrl || "https://mineru.net").replace(/\/$/, "")}${suffix}`;
}

function assertApiResponse(payload, label) {
  if (!payload || payload.code !== 0) {
    throw new Error(`${label} failed: ${payload?.msg || "unknown MinerU error"}`);
  }
  return payload.data;
}

async function responseJson(response, label) {
  if (!response.ok) throw new Error(`${label} HTTP ${response.status}`);
  return assertApiResponse(await response.json(), label);
}

async function readFileBytes(filePath) {
  const stat = await fs.stat(filePath);
  if (stat.size > MAX_FILE_BYTES) throw new Error("File exceeds MinerU 200MB limit");
  return new Uint8Array(await fs.readFile(filePath));
}

const PRECISION_MODELS = new Set(["vlm", "pipeline"]);

/**
 * 只允许 vlm / pipeline 传给 MinerU。
 * 配置里的 modelVersion 也可能是通道型取值（如 "agent"），不能原样发出去。
 */
export function sanitizePrecisionModel(value) {
  return PRECISION_MODELS.has(value) ? value : "vlm";
}

export async function submitFile(ctx, filePath, fileName, options = {}) {
  const token = options.apiToken || await configValue(ctx, "apiToken");
  if (!token) throw new Error("MinerU API token is not configured");
  const baseUrl = options.apiBaseUrl || await configValue(ctx, "apiBaseUrl", "https://mineru.net");
  const bytes = await readFileBytes(filePath);
  const data = {
    files: [{ name: fileName, data_id: crypto.randomUUID() }],
    model_version: sanitizePrecisionModel(options.modelVersion || await configValue(ctx, "modelVersion", "vlm")),
    enable_table: options.enableTable ?? true,
    enable_formula: options.enableFormula ?? true,
    is_ocr: options.isOcr ?? false,
    language: options.language || "ch",
  };
  const response = await ctx.network.fetch(apiUrl(baseUrl, "/api/v4/file-urls/batch"), {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(data),
    timeoutMs: 60000,
  });
  const uploadData = await responseJson(response, "request upload URL");
  const uploadUrl = uploadData.file_urls?.[0];
  if (!uploadData.batch_id || !uploadUrl) throw new Error("MinerU did not return batch_id or upload URL");

  const uploadResponse = await ctx.network.fetch(uploadUrl, {
    method: "PUT",
    body: bytes,
    timeoutMs: 120000,
  });
  if (!uploadResponse.ok) throw new Error(`upload file HTTP ${uploadResponse.status}`);

  return { batchId: uploadData.batch_id, fileName, bytes: bytes.byteLength };
}

export async function getBatchResult(ctx, batchId, options = {}) {
  const token = options.apiToken || await configValue(ctx, "apiToken");
  if (!token) throw new Error("MinerU API token is not configured");
  const baseUrl = options.apiBaseUrl || await configValue(ctx, "apiBaseUrl", "https://mineru.net");
  const response = await ctx.network.fetch(apiUrl(baseUrl, `/api/v4/extract-results/batch/${encodeURIComponent(batchId)}`), {
    method: "GET",
    headers: { Authorization: `Bearer ${token}` },
    timeoutMs: 60000,
  });
  return responseJson(response, "query MinerU batch");
}

export function batchItems(payload) {
  const data = payload?.data ?? payload;
  const items = Array.isArray(data) ? data : data?.extract_result ?? data?.results ?? [data];
  if (!Array.isArray(items) || !items.length) throw new Error("MinerU batch response has no results");
  return items;
}

export async function pollBatch(ctx, batchId, options = {}) {
  const intervalMs = Number(options.pollIntervalMs ?? await configValue(ctx, "pollIntervalMs", 2000));
  const timeoutMs = Number(options.pollTimeoutMs ?? await configValue(ctx, "pollTimeoutMs", 600000));
  if (!Number.isFinite(intervalMs) || intervalMs < 250 || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("Invalid polling interval or timeout");
  }
  const deadline = Date.now() + timeoutMs;
  let lastStates = [];
  while (Date.now() < deadline) {
    const items = batchItems(await getBatchResult(ctx, batchId, options));
    lastStates = items.map((item) => item?.state || item?.extract_state || "unknown");
    const item = items.find((candidate) => candidate?.state === "done" && candidate?.full_zip_url);
    if (item) return item;
    const failed = items.find((candidate) => candidate?.state === "failed");
    if (failed) throw new Error(failed.err_msg || "MinerU parsing failed");
    await new Promise((resolve) => setTimeout(resolve, Math.min(intervalMs, Math.max(0, deadline - Date.now()))));
  }
  throw new Error(`MinerU polling timed out after ${timeoutMs}ms (last states: ${lastStates.join(", ") || "none"})`);
}

export async function downloadResult(ctx, result, outputDir, options = {}) {
  const zipUrl = result.full_zip_url;
  if (!zipUrl) throw new Error("MinerU result did not include full_zip_url");
  const response = await ctx.network.fetch(zipUrl, { method: "GET", timeoutMs: 120000 });
  if (!response.ok) throw new Error(`download result HTTP ${response.status}`);
  const declaredSize = Number(response.headers.get("content-length"));
  if (declaredSize > MAX_ZIP_BYTES) throw new Error("MinerU result ZIP exceeds 50MB limit");
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > MAX_ZIP_BYTES) throw new Error("MinerU result ZIP exceeds 50MB limit");
  await fs.mkdir(outputDir, { recursive: true });
  const zipPath = path.join(outputDir, "result.zip");
  await fs.writeFile(zipPath, bytes);
  const files = extractZip(bytes, outputDir);
  const markdown = files.find((file) => path.basename(file).toLowerCase() === "full.md");
  const jsonFiles = files.filter((file) => file.toLowerCase().endsWith(".json"));
  if (!markdown) throw new Error("MinerU ZIP did not contain full.md");
  return { zipPath, markdownPath: markdown, jsonPaths: jsonFiles, files };
}

function extractZip(buffer, outputDir) {
  const entries = parseCentralDirectory(buffer);
  const outputRoot = path.resolve(outputDir);
  const files = [];
  for (const entry of entries) {
    if (!entry.name || entry.name.endsWith("/")) continue;
    const normalized = entry.name.replace(/\\/g, "/");
    const target = path.resolve(outputRoot, normalized);
    if (target !== outputRoot && !target.startsWith(`${outputRoot}${path.sep}`)) {
      throw new Error(`Unsafe ZIP entry: ${entry.name}`);
    }
    const compressed = buffer.subarray(entry.dataOffset, entry.dataOffset + entry.compressedSize);
    let content;
    if (entry.method === 0) content = compressed;
    else if (entry.method === 8) content = zlib.inflateRawSync(compressed);
    else throw new Error(`Unsupported ZIP compression method: ${entry.method}`);
    if (content.length !== entry.uncompressedSize) throw new Error(`ZIP size mismatch: ${entry.name}`);
    awaitWrite(target, content);
    files.push(target);
  }
  return files;
}

function awaitWrite(target, content) {
  fsSync.mkdirSync(path.dirname(target), { recursive: true });
  fsSync.writeFileSync(target, content);
}

function parseCentralDirectory(buffer) {
  const eocd = findSignatureBackward(buffer, 0x06054b50);
  if (eocd < 0) throw new Error("Invalid ZIP: end of central directory not found");
  const count = buffer.readUInt16LE(eocd + 10);
  const centralSize = buffer.readUInt32LE(eocd + 12);
  const centralOffset = buffer.readUInt32LE(eocd + 16);
  const entries = [];
  let cursor = centralOffset;
  for (let i = 0; i < count; i++) {
    if (buffer.readUInt32LE(cursor) !== 0x02014b50) throw new Error("Invalid ZIP central directory");
    const method = buffer.readUInt16LE(cursor + 10);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const uncompressedSize = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const name = buffer.subarray(cursor + 46, cursor + 46 + nameLength).toString("utf8");
    if (buffer.readUInt32LE(localOffset) !== 0x04034b50) throw new Error(`Invalid ZIP local header: ${name}`);
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    entries.push({ name, method, compressedSize, uncompressedSize, dataOffset: localOffset + 30 + localNameLength + localExtraLength });
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  if (cursor !== centralOffset + centralSize) throw new Error("Invalid ZIP central directory size");
  return entries;
}

function findSignatureBackward(buffer, signature) {
  for (let i = buffer.length - 22; i >= 0; i--) if (buffer.readUInt32LE(i) === signature) return i;
  return -1;
}
