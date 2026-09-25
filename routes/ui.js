import fs from "node:fs";
import path from "node:path";

/**
 * 兼容桥接（2026-09-25）
 *
 * 现象：Hana 0.450.0 在本地 loopback 连接下，插件 iframe 文档只凭 plugin surface
 * session 被放行时，页面响应不会签发 /assets/ 专用 cookie；随后的 panel.js /
 * panel.css 请求因缺少凭据返回 403 missing_credential，三栏界面无法渲染。
 *
 * 处理：把同一份 panel.css / panel.js 内联进页面返回，去掉那次会失败的第二次请求。
 * 这不会把任何凭据放进 URL，也不新建静态文件路由；文件仍保留在 assets/ 下。
 *
 * 回退：宿主修好资产会话签发后，把 INLINE_ASSETS 改成 false 即可恢复
 * /api/plugins/{pluginId}/assets/ 引用。
 */
const INLINE_ASSETS = true;

function readAsset(ctx, name) {
  return fs.readFileSync(path.join(ctx.pluginDir, "assets", name), "utf-8");
}

function escapeInlineScript(code) {
  // 只处理会提前结束 <script> 的序列；其余内容原样保留。
  return code.replace(/<\/script/gi, "<\\/script");
}

export default function registerPluginUiRoutes(app, ctx) {
  app.get("/page", (c) => c.html(renderShell(c, ctx, "page")));
  app.get("/widget", (c) => c.html(renderShell(c, ctx, "widget")));
}

function renderShell(c, ctx, surface) {
  const hanaCss = c.req.query("hana-css") || "";
  const theme = c.req.query("hana-theme") || "inherit";
  const assetBase = `/api/plugins/${encodeURIComponent(ctx.pluginId)}/assets`;
  const title = "MinerU 文档解析";

  let styleTag = `<link rel="stylesheet" href="${assetBase}/panel.css">`;
  let scriptTag = `<script type="module" src="${assetBase}/panel.js"></script>`;
  let mode = "assets";
  if (INLINE_ASSETS) {
    try {
      styleTag = `<style>\n${readAsset(ctx, "panel.css")}\n</style>`;
      scriptTag = `<script type="module">\n${escapeInlineScript(readAsset(ctx, "panel.js"))}\n</script>`;
      mode = "inline";
    } catch (error) {
      ctx.log?.warn?.(`inline assets unavailable, using /assets/: ${error?.message || error}`);
    }
  }

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  ${hanaCss ? `<link rel="stylesheet" href="${escapeAttr(hanaCss)}">` : ""}
  ${styleTag}
</head>
<body data-hana-theme="${escapeAttr(theme)}" data-surface="${surface}" data-asset-mode="${mode}">
  <div id="root" data-surface="${surface}"><main style="padding:24px;font-family:sans-serif">正在加载 MinerU 工作台…</main></div>
  <script>
    function diagnostic(message){ var root=document.getElementById('root'); if(root) root.textContent=message; }
    window.addEventListener('error', function(event){ diagnostic('工作台脚本错误：' + (event.message || '未知错误')); });
    window.addEventListener('DOMContentLoaded', function(){ window.parent.postMessage({ type: 'ready' }, '*'); });
  </script>
  ${scriptTag}
</body>
</html>`;
}

function escapeAttr(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;");
}

function escapeHtml(value) {
  return escapeAttr(value).replace(/>/g, "&gt;");
}
