
import { normalizeTargetLanguage, ensureModelAgent, readModelAgent } from "./translate.v3.js";

const HANA_BUS_SKIP = Symbol.for("hana.event-bus.skip");

/**
 * 把早期存下的语言别名（english / 简体中文 这类）改写成规范写法。
 * 这个键在改动前就已经在配置 schema 里，所以不必等 Hana 重启就能写回。
 * 失败只记日志：个性化偏好不值得拦住插件加载。
 */
async function normalizeStoredTargetLanguage(ctx) {
  try {
    const stored = await ctx.config.get("translationTargetLanguage");
    if (typeof stored !== "string") return;
    const normalized = normalizeTargetLanguage(stored);
    if (!normalized || normalized === stored) return;
    await ctx.config.set("translationTargetLanguage", normalized);
    ctx.log.info(`translation target language normalized: ${stored} -> ${normalized}`);
  } catch (error) {
    ctx.log.warn(`translation target language normalization skipped: ${error?.message || error}`);
  }
}

/**
 * 「翻译模型」已经不是插件设置了，模型只在插件页面上选择、记在插件私有 agent 里。
 * 但用户最后一次是在设置页选的，那就把这个选择搬到 agent，别默默丢掉。
 * 优先级：agent 里已有的（页面选的，更新）> 旧配置值。
 */
async function migrateLegacyTranslationModel(ctx) {
  try {
    if (await readModelAgent(ctx)) return;
    const legacy = await ctx.config.get("translationModel");
    const id = typeof legacy?.id === "string" ? legacy.id.trim() : "";
    if (!id) return;
    await ensureModelAgent(ctx, { id, provider: legacy.provider || null });
    ctx.log.info(`translation model moved from plugin settings into the plugin-private agent: ${id}`);
  } catch (error) {
    ctx.log.warn(`translation model migration skipped: ${error?.message || error}`);
  }
}

export default class Plugin {
  async onload() {
    const ctx = this.ctx;
    await normalizeStoredTargetLanguage(ctx);
    await migrateLegacyTranslationModel(ctx);
    if (ctx.bus.handle) {
      this.register(ctx.bus.handle("mineru-document-workbench:status", (payload) => {
        if (payload?.pluginId && payload.pluginId !== ctx.pluginId) return HANA_BUS_SKIP;
        return {
          ok: true,
          pluginId: ctx.pluginId,
          name: "MinerU 文档解析",
        };
      }));
    }
    ctx.log.info("MinerU 文档解析 plugin loaded");
  }

  async onunload() {
    this.ctx.log.info("MinerU 文档解析 plugin unloaded");
  }
}
