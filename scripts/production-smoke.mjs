// Production-boundary smoke test: extract the delivery zip to a fresh temp dir
// (simulating ${HANA_HOME}/plugins/<id>: outside the repo, no node_modules, no
// workspace symlinks) and import every server-side entry point.
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import zlib from "node:zlib";

const zipPath = process.argv[2];
if (!zipPath) throw new Error("usage: node production-smoke.mjs <zip>");

// Minimal ZIP reader (stored + deflate) so this script needs no dependencies.
function readZip(buffer) {
  const eocd = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0) throw new Error("not a zip");
  const count = buffer.readUInt16LE(eocd + 10);
  const centralOffset = buffer.readUInt32LE(eocd + 16);
  const out = [];
  let cursor = centralOffset;
  for (let i = 0; i < count; i++) {
    const method = buffer.readUInt16LE(cursor + 10);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const name = buffer.subarray(cursor + 46, cursor + 46 + nameLength).toString("utf8");
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
    const raw = buffer.subarray(dataOffset, dataOffset + compressedSize);
    out.push({ name, data: method === 0 ? raw : zlib.inflateRawSync(raw) });
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return out;
}

const root = await fsp.mkdtemp(path.join(os.tmpdir(), "mineru-prod-"));
for (const entry of readZip(fs.readFileSync(zipPath))) {
  const target = path.join(root, entry.name);
  await fsp.mkdir(path.dirname(target), { recursive: true });
  await fsp.writeFile(target, entry.data);
}
console.log(`extracted to ${root}`);
console.log(`node_modules present: ${fs.existsSync(path.join(root, "node_modules"))}`);
console.log(`package.json present: ${fs.existsSync(path.join(root, "package.json"))}`);

const failures = [];
async function importEntry(rel) {
  try {
    const mod = await import(pathToFileURL(path.join(root, rel)).href);
    return mod;
  } catch (error) {
    failures.push(`${rel}: ${error.message}`);
    return null;
  }
}

// 1) lifecycle entry
const index = await importEntry("index.js");
console.log(`index.js default export is class/function: ${typeof index?.default === "function"}`);

// 2) tools: must expose name/description/execute
const toolDir = path.join(root, "tools");
for (const file of fs.readdirSync(toolDir).filter((f) => f.endsWith(".js"))) {
  const mod = await importEntry(path.join("tools", file));
  if (!mod) continue;
  const ok = Boolean(mod.name) && Boolean(mod.description) && typeof mod.execute === "function";
  if (!ok) failures.push(`${file}: missing name/description/execute`);
  console.log(`  tool ${String(mod.name).padEnd(18)} ok=${ok} permission=${mod.sessionPermission?.kind || (mod.sessionPermission?.readOnly ? "readOnly" : "none")}`);
}

// 3) routes: factory (default function) or register export
const routeDir = path.join(root, "routes");
for (const file of fs.readdirSync(routeDir).filter((f) => f.endsWith(".js"))) {
  const mod = await importEntry(path.join("routes", file));
  if (!mod) continue;
  const shape = typeof mod.default === "function" ? "default(app, ctx)" : (typeof mod.register === "function" ? "register(app, ctx)" : "UNKNOWN");
  if (shape === "UNKNOWN") failures.push(`${file}: no default factory or register export`);
  console.log(`  route ${file.padEnd(20)} ${shape}`);
}

// 4) manifest sanity
const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
const requiredCaps = ["network.fetch", "resource.materialize"];
const missingCaps = requiredCaps.filter((c) => !manifest.capabilities?.includes(c));
if (missingCaps.length) failures.push(`manifest missing capabilities: ${missingCaps.join(", ")}`);
if (manifest.trust !== "full-access") failures.push("manifest trust must be full-access");
console.log(`  manifest trust=${manifest.trust} caps=[${manifest.capabilities?.join(", ")}] hosts=[${manifest.network?.allowedHosts?.join(", ")}] methods=[${manifest.network?.methods?.join(", ")}]`);

// 5) no secrets shipped in the package
const text = fs.readdirSync(root, { recursive: true })
  .filter((f) => typeof f === "string" && !fs.statSync(path.join(root, f)).isDirectory())
  .map((f) => fs.readFileSync(path.join(root, f), "utf8"))
  .join("\n");
for (const needle of ["sk-", "Bearer sk", "apiToken\":\"sk-"]) {
  if (text.includes(needle)) failures.push(`package appears to contain a secret pattern: ${needle}`);
}

console.log("");
if (failures.length) {
  console.log("FAILURES:");
  for (const f of failures) console.log(`  - ${f}`);
  process.exitCode = 1;
} else {
  console.log("production smoke test: PASS");
}
