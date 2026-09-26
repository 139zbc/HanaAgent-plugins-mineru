/**
 * V1 → V2 适配层
 * ===============
 *
 * 迁移策略：业务模块（job-store / parse-channels / translate / routes / tools）
 * 尽量一字不改地保留，由这一层把它们原本依赖的 **v1 插件上下文（ctx）** 投影到
 * **v2 App SDK** 上。这样迁移的工程量集中在"接口翻译"，而不是"重写业务"。
 *
 * 映射表
 *   ctx.dataDir                → sdk.dataDir
 *   ctx.config.get / .set      → sdk.config.get / .set
 *   ctx.log.info / warn / ...  → sdk.logger.*
 *   ctx.network.fetch          → sdk.network.fetch
 *   ctx.resources.materialize  → sdk.resources.materialize（归一化出 filePath）
 *   ctx.stageFile(...)         → sdk.resources.stage({ path, name })
 *   ctx.bus.handle             → sdk.bus.handle
 *   ctx.pluginId               → 本 App 的 manifest id
 *   ctx.sessionPath            → 工具调用上下文里的 sessionPath
 *   ctx.bus.request(verb)      → sdk.bus.request(verb)，但下面四个动词被拦截
 *
 * 被拦截的动词（v2 里不存在、被明确拒绝，或换了一套所有权模型）
 *   model:sample-text        v2 的车 bus 允许清单里没有这个词，调用会被拒绝。
 *                            这里用 sdk.models.streamEvents 实现同样的语义。
 *   provider:models-by-type  改用 sdk.models.list（免额外授权）后本地过滤。
 *   agent:profile             这三个是 v1「插件私有 agent」那套做法的三个动作。
 *   agent:create              v2 没有 plugin_private agent，App 也不能把别的
 *   agent:update-config       agent 当成自己的私有存储。这里改用
 *                             sdk.storage.global（本 App 私有，不需要能力授权）
 *                             记住「翻译用哪个模型」，对外行为保持一致。
 */

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const STORAGE_KEY_TRANSLATION_MODEL = "translation.model";

/** 从 v2 模型目录里挑出聊天模型；目录项形状与 GET /api/models 同一套投影。 */
function isChatModel(model) {
  const capability = model?.capability ?? model?.capabilities;
  if (!capability) return true; // 没有能力位信息时不排除，交给调用方
  if (typeof capability === "string") return capability === "chat" || capability.includes("chat");
  if (Array.isArray(capability)) return capability.some((item) => String(item).includes("chat"));
  if (typeof capability === "object") {
    if (capability.chat) return true;
    return Object.keys(capability).some((key) => key.includes("chat") && capability[key]);
  }
  return true;
}

function requestId(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

// ── 待读文件的暂存 ────────────────────────────────────────────────────────

/** 暂存目录名（位于 dataDir 下，是子进程唯一可读写的许可根）。 */
const STAGE_DIRNAME = "uploads";
/** 暂存文件保留时长；解析调用只需秒级，过后就可以清。 */
const STAGE_TTL_MS = 30 * 60 * 1000;

function shortHash(text) {
  return crypto.createHash("sha1").update(String(text)).digest("hex").slice(0, 12);
}

/** 文件名清洗：只留字母数字、点、短横、下划线和中文，并限长。 */
function safeBaseName(name) {
  const cleaned = String(name || "file").replace(/[^\w.\-\u4e00-\u9fff]+/g, "_").slice(-80);
  return cleaned || "file";
}

/** 清理过期暂存文件；失败不影响调用。 */
async function pruneStaged(dir) {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const now = Date.now();
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const full = path.join(dir, entry.name);
      try {
        const st = await fs.stat(full);
        if (now - st.mtimeMs > STAGE_TTL_MS) await fs.rm(full, { force: true });
      } catch { /* 单个文件失败不影响其他 */ }
    }
  } catch { /* 目录尚未创建等 */ }
}

export function createLegacyCtx(sdk, { appId, toolContext = null } = {}) {
  const callToken = typeof toolContext?.callToken === "string" ? toolContext.callToken : undefined;
  const sessionPath = typeof toolContext?.sessionPath === "string" ? toolContext.sessionPath : null;

  const log = {
    debug: (...args) => sdk.logger.debug(...args),
    info: (...args) => sdk.logger.info(...args),
    warn: (...args) => sdk.logger.warn(...args),
    error: (...args) => sdk.logger.error(...args),
  };

  // ── 翻译模型记忆：v1 存在插件私有 agent 里，v2 改存本 App 私有存储 ──────────
  /**
   * 把待读文件放进 dataDir。
   *
   * dataDir 是子进程唯一可读写的许可根；外部文件必须先复制进来。
   * 暂存目录是 dataDir/uploads，文件名带上源路径的短哈希：
   * 同一文件重复提交会复用同一个文件（覆盖），不会无限堆积。
   */
  async function stageForRead(ref, sourcePath) {
    // 已经在 dataDir 内的路径不用复制
    const rel = path.relative(sdk.dataDir, sourcePath);
    if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) return sourcePath;

    const dir = path.join(sdk.dataDir, STAGE_DIRNAME);
    await fs.mkdir(dir, { recursive: true });
    // 顺手清掉过期的暂存文件（不阻断当前流程）
    void pruneStaged(dir);

    const target = path.join(dir, `${shortHash(sourcePath)}-${safeBaseName(path.basename(sourcePath))}`);
    try {
      await fs.rm(target, { force: true });
      await sdk.resources.copy(
        ref ?? { kind: "local-file", path: sourcePath },
        { kind: "local-file", path: target },
      );
    } catch (error) {
      // 复制失败时不要退回原路径：那只会让上游抛出难以理解的权限错误。
      throw new Error(`无法读取所选文件（暂存到应用数据目录失败）：${error?.message || error}`);
    }
    return target;
  }

  async function readStoredModel() {
    try {
      const raw = await sdk.storage.global.get(STORAGE_KEY_TRANSLATION_MODEL);
      if (!raw || typeof raw !== "object") return null;
      if (typeof raw.id !== "string" || !raw.id.trim()) return null;
      return { id: raw.id.trim(), provider: typeof raw.provider === "string" && raw.provider.trim() ? raw.provider.trim() : null };
    } catch (error) {
      log.warn(`translation model read failed: ${error?.message || error}`);
      return null;
    }
  }

  async function listChatModels() {
    const out = await sdk.models.list();
    const models = Array.isArray(out?.models) ? out.models : [];
    return models
      .filter((model) => typeof model?.id === "string" && model.id && isChatModel(model))
      .map((model) => ({ id: model.id, provider: model.provider ?? null, name: model.name || model.id }));
  }

  /** 补出 provider：目录里查不到时退回 undefined，由宿主报出明确错误。 */
  async function resolveProvider(modelId) {
    try {
      const catalog = await listChatModels();
      return catalog.find((model) => model.id === modelId)?.provider ?? null;
    } catch {
      return null;
    }
  }

  /**
   * model:sample-text 的 v2 实现。
   *
   * v1 载荷：{ systemPrompt, messages, maxTokens, agentId? } → 回 { text }
   * v2 路径：sdk.models.streamEvents({ requestId, provider, model, messages, systemPrompt, maxTokens })
   *
   * systemPrompt 原样发出，宿主不会追加任何内容——这一点与 v1 的约定一致。
   */
  async function sampleText(payload) {
    const stored = await readStoredModel();
    if (!stored?.id) {
      const error = new Error("尚未选择翻译模型；请在 MinerU 工作台的「译文」页签里先选模型");
      error.code = "NO_TRANSLATION_MODEL";
      throw error;
    }
    const provider = stored.provider || (await resolveProvider(stored.id));
    if (!provider) {
      const error = new Error(`无法为模型 ${stored.id} 解析 provider；请在「译文」页签重新选择模型`);
      error.code = "UNKNOWN_TRANSLATION_PROVIDER";
      throw error;
    }

    const stream = sdk.models.streamEvents({
      requestId: requestId("mineru-translate"),
      provider,
      model: stored.id,
      messages: Array.isArray(payload?.messages) ? payload.messages : [],
      ...(typeof payload?.systemPrompt === "string" ? { systemPrompt: payload.systemPrompt } : {}),
      ...(Number.isFinite(payload?.maxTokens) ? { maxTokens: payload.maxTokens } : {}),
      ...(callToken ? { callToken } : {}),
    });

    let out = "";
    for await (const event of stream) {
      if (event?.type === "text-delta" && typeof event.delta === "string") out += event.delta;
      else if (event?.type === "error") {
        const error = new Error(event.message || "模型调用失败");
        error.code = event.code || "MODEL_STREAM_ERROR";
        throw error;
      }
    }
    return { text: out };
  }

  const bus = {
    async request(verb, payload) {
      switch (verb) {
        case "model:sample-text":
          return sampleText(payload);

        case "provider:models-by-type":
          return { models: await listChatModels() };

        case "agent:profile":
          return { profile: { models: { utility: await readStoredModel() } } };

        case "agent:create":
          // v2 里没有 plugin_private agent；这个动作变成一次无副作用的确认，
          // 真正的状态由 agent:update-config 落到本 App 私有存储。
          return { agentId: typeof payload?.id === "string" ? payload.id : appId };

        case "agent:update-config": {
          const wanted = payload?.partial?.models?.utility ?? null;
          await sdk.storage.global.set(STORAGE_KEY_TRANSLATION_MODEL, wanted);
          return { ok: true };
        }

        default:
          return sdk.bus.request(verb, payload);
      }
    },
    handle: (name, handler, options) => sdk.bus.handle(name, handler, options),
    hasHandler: (name) => sdk.bus.hasHandler(name),
  };

  const resources = {
    /**
     * v1 的 materialize 回包带 filePath；v2 的类型是 unknown，这里做一层归一化。
     *
     * 关键在于：v2 的 `materialize` 返回的是**用户的原始文件路径**，
     * 而 app 子进程开着 Node Permission Model —— 读取许可根只有 dataDir
     * （与安装目录），外部路径上的裸 `fs` 读取会被直接拒绝：
     *   Access to this API has been restricted. Use --allow-fs-read to manage permissions.
     *
     * v1 插件没有这层限制，业务代码因此一直直接 `fs.readFile(filePath)`。
     * 这里把外部文件先复制进 dataDir，再把这个可读的路径交给业务代码，
     * `lib/` 里仍然一行不改。
     */
    async materialize(ref, options) {
      const out = await sdk.resources.materialize(ref, options);
      const record = out && typeof out === "object" ? out : {};
      const sourcePath = typeof record.filePath === "string" ? record.filePath
        : typeof record.path === "string" ? record.path
        : null;
      if (!sourcePath) return { ...record, filePath: null };
      return { ...record, filePath: await stageForRead(ref, sourcePath) };
    },
  };

  return {
    // ── 身份与目录 ────────────────────────────────────────────────────────────
    pluginId: appId,
    appId,
    dataDir: sdk.dataDir,

    // ── 会话身份（工具调用时才有）────────────────────────────────────────────
    sessionId: null,
    sessionRef: null,
    sessionPath,

    // ── 基础设施 ──────────────────────────────────────────────────────────────
    log,
    logger: log,
    config: {
      get: (key, opts) => sdk.config.get(key, opts),
      set: (key, value, opts) => sdk.config.set(key, value, opts),
      getAll: (opts) => sdk.config.getAll(opts),
    },
    network: {
      fetch: (input, init) => sdk.network.fetch(input, init),
    },
    resources,
    bus,

    /**
     * 把产物交付到当前会话。
     *
     * v1 形状（同步）：ctx.stageFile({ sessionId, sessionRef, sessionPath, filePath, label })
     *   → { mediaItem }
     * v2 形状（异步）：await ctx.stageFile({ filePath, label })
     *   → { file, mediaItem, resource }
     *
     * v2 的 sdk.resources.stage 自己会带上本次工具调用的令牌，不需要手传会话身份。
     */
    stageFile: async ({ filePath, path: altPath, label, name } = {}) => {
      const source = filePath || altPath;
      if (!source) throw new Error("stageFile 需要 filePath");
      return sdk.resources.stage({
        path: source,
        ...(label || name ? { name: label || name } : {}),
      });
    },
  };
}
