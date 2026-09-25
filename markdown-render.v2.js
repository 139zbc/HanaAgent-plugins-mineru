// Markdown → 安全 HTML 渲染器（服务端使用，供插件页面展示解析结果）。
//
// 设计要点：
// 1. 结果内容属于外部输入（MinerU 产出），因此**不信任**其中的 HTML。
//    先把原始 HTML 标签抽成占位符，转义其余文本，套用 Markdown 规则，
//    最后只回填白名单标签与白名单属性。
// 2. 图片统一走 resolveImage 回调（由调用方决定是否可解析为可访问 URL）；
//    解析不到时渲染成可见说明，而不是留下坏图。
//
// 这是共享模块，文件名带版本号是刻意的（见 docs/hana-source-findings.md）。
// 修改本文件时请新建 markdown-render.v2.js，更新所有导入方，并删除旧文件。

const ALLOWED_TAGS = new Set([
  "table", "thead", "tbody", "tfoot", "tr", "th", "td", "caption", "colgroup", "col",
  "p", "br", "hr", "b", "strong", "i", "em", "u", "s", "del", "ins", "sub", "sup", "mark", "small",
  "ul", "ol", "li", "dl", "dt", "dd", "code", "pre", "blockquote", "span", "div",
  "h1", "h2", "h3", "h4", "h5", "h6", "a", "img",
]);

const TAG_ATTRS = Object.freeze({
  td: ["colspan", "rowspan", "align"],
  th: ["colspan", "rowspan", "align", "scope"],
  a: ["href", "title"],
  img: ["alt", "width", "height"],
  ol: ["start"],
  col: ["span"],
  colgroup: ["span"],
});

// 明确危险、即使出现在白名单标签内也要丢弃的属性前缀。
const FORBIDDEN_ATTR = /^(on|style$|formaction$|xlink:|srcdoc$)/i;

export function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeAttr(value) {
  return escapeHtml(value).replace(/`/g, "&#96;");
}

function imageNote(ctx, src, alt) {
  const label = alt || src || ctx.altFallback;
  if (typeof ctx.noteFor === "function") {
    try { return String(ctx.noteFor(src, alt)); } catch { /* 回调异常不应破坏渲染 */ }
  }
  return `（图片不可用：${label}）`;
}

/**
 * 净化单个原始 HTML 标签。返回空串表示丢弃该标签。
 * 对 img 特殊处理：src 必须经 resolveImage 解析，避免渲染未授权来源。
 */
export function sanitizeTag(raw, { resolveImage = null, altFallback = "图片", noteFor = null } = {}) {
  const ctx = { resolveImage, altFallback, noteFor };
  const match = /^<\s*(\/?)\s*([A-Za-z][A-Za-z0-9]*)([\s\S]*?)>?$/.exec(raw);
  if (!match) return "";
  const closing = match[1] === "/";
  const name = match[2].toLowerCase();
  const rawAttrs = match[3] || "";
  if (!ALLOWED_TAGS.has(name)) return "";
  if (closing) return `</${name}>`;

  const allowed = TAG_ATTRS[name] || [];
  const attrs = [];
  let src = null;
  let alt = "";
  for (const attr of rawAttrs.matchAll(/([A-Za-z_:][-A-Za-z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>=]+))/g)) {
    const key = attr[1].toLowerCase();
    const value = attr[2] ?? attr[3] ?? attr[4] ?? "";
    if (FORBIDDEN_ATTR.test(key)) continue;
    if (key === "src" && name === "img") { src = value; continue; }
    if (key === "alt" && name === "img") { alt = value; continue; }
    if (!allowed.includes(key)) continue;
    if (key === "href" && !/^https?:\/\//i.test(value)) continue;
    attrs.push(`${key}="${escapeAttr(value)}"`);
  }

  if (name === "img") {
    const resolved = src && resolveImage ? resolveImage(src) : null;
    if (!resolved) {
      return `<span class="md-image-missing">${escapeHtml(imageNote(ctx, src, alt))}</span>`;
    }
    const extra = attrs.length ? ` ${attrs.join(" ")}` : "";
    return `<img src="${escapeAttr(resolved)}" alt="${escapeAttr(alt || altFallback)}" loading="lazy" decoding="async"${extra}>`;
  }
  return `<${name}${attrs.length ? ` ${attrs.join(" ")}` : ""}>`;
}

function renderInline(text, ctx) {
  const codes = [];
  let out = text.replace(/`([^`]+)`/g, (_m, code) => {
    codes.push(code);
    return `\u0001${codes.length - 1}\u0001`;
  });

  // 图片必须早于链接处理（图片语法包含链接语法）。
  out = out.replace(/!\[([^\]]*)\]\(\s*([^)\s]+)(?:\s+"[^"]*")?\s*\)/g, (_m, alt, src) => {
    const resolved = ctx.resolveImage ? ctx.resolveImage(src) : null;
    if (!resolved) return `<span class="md-image-missing">${escapeHtml(imageNote(ctx, src, alt))}</span>`;
    return `<img src="${escapeAttr(resolved)}" alt="${escapeAttr(alt || "图片")}" loading="lazy" decoding="async">`;
  });

  out = out.replace(/\[([^\]]*)\]\(\s*([^)\s]+)(?:\s+"([^"]*)")?\s*\)/g, (_m, label, href, title) => {
    if (!/^https?:\/\//i.test(href)) return escapeHtml(label);
    const titleAttr = title ? ` title="${escapeAttr(title)}"` : "";
    return `<a href="${escapeAttr(href)}" rel="noreferrer noopener" target="_blank"${titleAttr}>${label}</a>`;
  });

  out = out
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/__([^_]+)__/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>")
    .replace(/~~([^~]+)~~/g, "<del>$1</del>");

  out = out.replace(/\u0001(\d+)\u0001/g, (_m, index) => `<code>${escapeHtml(codes[Number(index)])}</code>`);
  return out;
}

function splitTableRow(line) {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return trimmed.split("|").map((cell) => cell.trim());
}

const TABLE_SEPARATOR = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

export function renderMarkdown(markdown, options = {}) {
  const ctx = {
    resolveImage: options.resolveImage || null,
    altFallback: options.altFallback || "图片",
    noteFor: typeof options.noteFor === "function" ? options.noteFor : null,
  };
  const source = String(markdown ?? "");

  // 1) 抽出原始 HTML 标签，避免被 Markdown 规则改写。
  const rawTags = [];
  const withPlaceholders = source.replace(/<\/?[A-Za-z][^>]*>/g, (tag) => {
    rawTags.push(tag);
    return `\u0002${rawTags.length - 1}\u0002`;
  });

  // 2) 转义其余文本。
  const lines = escapeHtml(withPlaceholders).split(/\r?\n/);
  const html = [];
  let index = 0;

  const flushParagraph = (buffer) => {
    if (!buffer.length) return;
    html.push(`<p>${renderInline(buffer.join("<br>"), ctx)}</p>`);
    buffer.length = 0;
  };

  const paragraph = [];
  while (index < lines.length) {
    const line = lines[index];

    // 代码块（围栏）
    const fence = /^\s*(```|~~~)\s*([A-Za-z0-9_+-]*)\s*$/.exec(line);
    if (fence) {
      flushParagraph(paragraph);
      const marker = fence[1];
      const lang = fence[2];
      const body = [];
      index += 1;
      while (index < lines.length && !new RegExp(`^\\s*${marker}\\s*$`).test(lines[index])) {
        body.push(lines[index]);
        index += 1;
      }
      index += 1; // 跳过结束围栏
      const langAttr = lang ? ` class="language-${escapeAttr(lang)}"` : "";
      html.push(`<pre><code${langAttr}>${body.join("\n")}</code></pre>`);
      continue;
    }

    // 表格：当前行以 | 开头且下一行是分隔行
    if (/^\s*\|/.test(line) && index + 1 < lines.length && TABLE_SEPARATOR.test(lines[index + 1])) {
      flushParagraph(paragraph);
      const header = splitTableRow(line);
      index += 2;
      const rows = [];
      while (index < lines.length && /^\s*\|/.test(lines[index])) {
        rows.push(splitTableRow(lines[index]));
        index += 1;
      }
      const head = header.map((cell) => `<th>${renderInline(cell, ctx)}</th>`).join("");
      const body = rows.map((row) => `<tr>${row.map((cell) => `<td>${renderInline(cell, ctx)}</td>`).join("")}</tr>`).join("");
      html.push(`<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`);
      continue;
    }

    // 标题
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flushParagraph(paragraph);
      const level = heading[1].length;
      html.push(`<h${level}>${renderInline(heading[2], ctx)}</h${level}>`);
      index += 1;
      continue;
    }

    // 分隔线
    if (/^\s*([-*_])\s*\1\s*\1[\s\-*_]*$/.test(line)) {
      flushParagraph(paragraph);
      html.push("<hr>");
      index += 1;
      continue;
    }

    // 引用
    if (/^\s*&gt;\s?/.test(line)) {
      flushParagraph(paragraph);
      const quote = [];
      while (index < lines.length && /^\s*&gt;\s?/.test(lines[index])) {
        quote.push(lines[index].replace(/^\s*&gt;\s?/, ""));
        index += 1;
      }
      html.push(`<blockquote>${renderInline(quote.join("<br>"), ctx)}</blockquote>`);
      continue;
    }

    // 列表（有序 / 无序）
    const bullet = /^\s*([-*+])\s+(.*)$/.exec(line);
    const numbered = /^\s*(\d+)[.)]\s+(.*)$/.exec(line);
    if (bullet || numbered) {
      flushParagraph(paragraph);
      const ordered = Boolean(numbered);
      const items = [];
      while (index < lines.length) {
        const b = /^\s*([-*+])\s+(.*)$/.exec(lines[index]);
        const n = /^\s*(\d+)[.)]\s+(.*)$/.exec(lines[index]);
        if (ordered ? !n : !b) break;
        items.push(renderInline((n ? n[2] : b[2]) || "", ctx));
        index += 1;
      }
      const tag = ordered ? "ol" : "ul";
      html.push(`<${tag}>${items.map((item) => `<li>${item}</li>`).join("")}</${tag}>`);
      continue;
    }

    // 空行 = 段落分隔
    if (!line.trim()) {
      flushParagraph(paragraph);
      index += 1;
      continue;
    }

    paragraph.push(line);
    index += 1;
  }
  flushParagraph(paragraph);

  // 3) 回填净化后的原始 HTML 标签。
  return html.join("\n").replace(/\u0002(\d+)\u0002/g, (_m, position) => sanitizeTag(rawTags[Number(position)], ctx));
}
