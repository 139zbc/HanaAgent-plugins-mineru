import { resolveConfiguredMode, PARSE_MODES, CHANNELS } from "../parse-options.v2.js";

export default function registerStatusRoute(app, ctx) {
  app.get("/status", async (c) => {
    const token = await ctx.config.get("apiToken");
    return c.json({
      ok: true,
      pluginId: ctx.pluginId,
      name: "MinerU 文档解析",
      configured: typeof token === "string" && token.length > 0,
      modelVersion: resolveConfiguredMode(await ctx.config.get("modelVersion")),
      modes: PARSE_MODES,
      channels: CHANNELS,
    });
  });
}
