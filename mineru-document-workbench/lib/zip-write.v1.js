// 最小 ZIP 打包器（只做导出需要的那部分）。
//
// 为什么自己写：导出要产出「md + images/」这种目录结构，而唯一的交付通道是
// `resource.saveFile`——它只收一个 base64 文件。所以必须自己把多个文件打成一个包。
// 宿主没有提供「打包」能力，应用也不能起子进程，因此在这里实现。
//
// 格式上只需要 store（0）与 deflate（8）两种方法：
//   - 图片（JPEG/PNG…）本来就是压缩过的，再 deflate 通常更大，走 store；
//   - Markdown / JSON 文本走 deflate，能显著缩小。
// 两种都算一遍、取小的那个，比按扩展名硬编码更稳。
//
// 这是共享模块，文件名带版本号是刻意的（见 docs/hana-source-findings.md）。
// 修改本文件时请新建 zip-write.v2.js，更新所有导入方，并删除旧文件。

import zlib from "node:zlib";

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;

// 第 11 位：文件名为 UTF-8。中文文件名不设这一位会变成乱码。
const FLAG_UTF8 = 0x0800;

const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    table[i] = c;
  }
  return table;
})();

export function crc32(buffer) {
  let c = -1;
  const bytes = buffer instanceof Uint8Array ? buffer : Buffer.from(buffer);
  for (let i = 0; i < bytes.length; i += 1) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/**
 * MS-DOS 的日期时间打包（各 2 字节）。
 * 年份从 1980 起算；ZIP 格式本身的限制，不是笔误。
 */
function dosDateTime(date) {
  const d = date instanceof Date && !Number.isNaN(date.getTime()) ? date : new Date();
  const year = Math.max(1980, d.getFullYear());
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
  const day = ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time: time & 0xffff, date: day & 0xffff };
}

/**
 * 归一化条目名：统一用 `/`、去掉开头的 `./` 与 `/`。
 * 返回 null 表示这个名字不能用（空、绝对路径、含 `..` 或控制字符）。
 *
 * 这是安全边界：条目名最终会变成用户解压后的文件名，必须当外部输入处理。
 */
export function normalizeEntryName(value) {
  const raw = String(value ?? "").trim().replace(/\\/g, "/");
  if (!raw) return null;
  // 绝对路径一律拒（含 Windows 盘符）。本写入器的条目名都是自己生成的，
  // 出现绝对路径就说明调用方有 bug：宁可拒绝并报出来，也不要默默改写成相对路径。
  if (raw.startsWith("/")) return null;
  if (/^[A-Za-z]:\//.test(raw)) return null;
  const name = raw.replace(/^(\.\/)+/, "");
  if (!name) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(name)) return null;
  const parts = name.split("/").filter((part) => part && part !== ".");
  if (!parts.length) return null;
  if (parts.some((part) => part === "..")) return null;
  return parts.join("/");
}

function compress(name, bytes) {
  // 文本类才值得压；算一遍取小者，避免拍脑袋的扩展名名单出错。
  if (!/\.(md|markdown|json|txt|svg|html|css|js)$/i.test(name)) {
    return { method: METHOD_STORE, data: bytes };
  }
  try {
    const deflated = zlib.deflateRawSync(bytes, { level: 6 });
    return deflated.length < bytes.length
      ? { method: METHOD_DEFLATE, data: deflated }
      : { method: METHOD_STORE, data: bytes };
  } catch {
    return { method: METHOD_STORE, data: bytes };
  }
}

/**
 * 打包成一个 ZIP。
 *
 * @param {Array<{ name: string, bytes: Buffer|Uint8Array|string }>} entries
 * @param {{ date?: Date }} [options]
 * @returns {{ bytes: Buffer, skipped: string[] }}
 */
export function buildZip(entries, options = {}) {
  const { time, date } = dosDateTime(options.date);
  const locals = [];
  const centrals = [];
  const seen = new Set();
  const skipped = [];
  let offset = 0;

  for (const entry of entries) {
    const name = normalizeEntryName(entry?.name);
    if (!name) { skipped.push(String(entry?.name ?? "")); continue; }
    if (seen.has(name)) { skipped.push(name); continue; }
    seen.add(name);

    const raw = Buffer.isBuffer(entry.bytes)
      ? entry.bytes
      : Buffer.from(entry.bytes ?? "");
    const nameBytes = Buffer.from(name, "utf8");
    const crc = crc32(raw);
    const { method, data } = compress(name, raw);

    const local = Buffer.alloc(30 + nameBytes.length);
    local.writeUInt32LE(SIG_LOCAL, 0);
    local.writeUInt16LE(20, 4);            // 解压所需版本
    local.writeUInt16LE(FLAG_UTF8, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);            // extra 长度
    nameBytes.copy(local, 30);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(SIG_CENTRAL, 0);
    central.writeUInt16LE(20, 4);          // 创建者版本
    central.writeUInt16LE(20, 6);          // 解压所需版本
    central.writeUInt16LE(FLAG_UTF8, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt16LE(0, 30);          // extra
    central.writeUInt16LE(0, 32);          // comment
    central.writeUInt16LE(0, 34);          // 起始磁盘
    central.writeUInt16LE(0, 36);          // 内部属性
    central.writeUInt32LE(0, 38);          // 外部属性
    central.writeUInt32LE(offset, 42);

    locals.push(local, data);
    centrals.push(central, nameBytes);
    offset += local.length + data.length;
  }

  const centralBuffer = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(SIG_EOCD, 0);
  eocd.writeUInt16LE(0, 4);                 // 本磁盘号
  eocd.writeUInt16LE(0, 6);                 // 中央目录所在磁盘
  eocd.writeUInt16LE(seen.size, 8);         // 本磁盘条目数
  eocd.writeUInt16LE(seen.size, 10);        // 总条目数
  eocd.writeUInt32LE(centralBuffer.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);                // 注释长度

  return { bytes: Buffer.concat([...locals, centralBuffer, eocd]), skipped };
}
