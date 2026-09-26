/**
 * MinerU 文档解析 — Hana v2 App 入口
 *
 * 这个文件是 v1 插件 index.js 的迁移产物。原来那份是一个 class（onload/onunload），
 * 现在换成 v2 的 defineApp(sdk => ...)。业务代码全部原封不动地留在 lib/ 下，
 * 由 v2-ctx.js 把 v2 的 sdk 投影成它们原本认识的 v1 ctx。
 *
 * 三件事：
 *   1. 注册六个 Agent 工具（工具名保持 v1 的 `{appId}_{tool}` 形状，是刻意对齐）
 *   2. 注册应用自带的后端路由（工作台页面读数据的那套 /options /jobs /translate ...）
 *   3. 启动日志
 */

import { defineApp } from "./sdk/app-contract/server-client.js";
import { createLegacyCtx } from "./v2-ctx.js";

import * as submitDocument from "./lib/tools/submit_document.js";
import * as parseDocument from "./lib/tools/parse-document.js";
import * as recoverBatch from "./lib/tools/recover_batch.js";
import * as referenceResult from "./lib/tools/reference_result.js";
import * as translateResult from "./lib/tools/translate_result.js";
import * as listJobs from "./lib/tools/list_jobs.js";

import registerJobRoutes from "./lib/routes/jobs.js";
import registerStatusRoutes from "./lib/routes/status.js";
import registerTranslateRoutes from "./lib/routes/translate.js";
import registerExportRoutes from "./lib/routes/export.js";
import registerIntakeRoutes from "./lib/routes/intake.js";

export const name = "mineru-document-workbench";

const APP_ID = "mineru-document-workbench";

/**
 * v1 宿主会替插件给工具名加 `{插件id}_` 前缀，v2 不加（重名会当场拒载）。
 * 这里手工补回同一个前缀，工具名与 v1 完全一致：
 *   mineru-document-workbench_submit_document
 * 这样已经按旧名字写好的 Agent 提示词、技能文档、用户习惯都不用改。
 */
const TOOL_PREFIX = `${APP_ID}_`;

const TOOL_MODULES = [submitDocument, parseDocument, recoverBatch, referenceResult, translateResult, listJobs];

/**
 * v1 的工具 execute 有两种返回形态：纯字符串（如 list_jobs、submit_document 的模板串）
 * 与 `{ content, details }` 对象。
 *
 * v2 只认 `{ content: [{ type: "text", text }] }`——字符串会被当成空结果，工具静默无声。
 * 这在迁移后在真实宿主里表现为「调用成功但没有任何输出」。这里统一归一化，
 * 业务代码仍然一行不改。
 */
function normalizeToolResult(result) {
  if (result && typeof result === "object" && Array.isArray(result.content)) {
    return result;
  }
  if (typeof result === "string") {
    return { content: [{ type: "text", text: result }] };
  }
  if (result === null || result === undefined) {
    return { content: [{ type: "text", text: "" }] };
  }
  let text;
  try {
    text = typeof result === "object" ? JSON.stringify(result, null, 2) : String(result);
  } catch {
    text = String(result);
  }
  return { content: [{ type: "text", text }] };
}

/**
 * v1 的 sessionPermission 里 describeSideEffect 是个函数；跨进程只认数据字段，
 * 函数字段过不来。这里只挑出可序列化的那几个，避免整条声明被判非法。
 */
function sanitizeSessionPermission(declaration) {
  if (!declaration || typeof declaration !== "object") return null;
  const allowed = ["readOnly", "kind", "auto", "description", "sideEffect"];
  const picked = {};
  for (const key of allowed) {
    const value = declaration[key];
    if (value === undefined || typeof value === "function") continue;
    picked[key] = value;
  }
  return Object.keys(picked).length ? picked : null;
}

export default defineApp(async (sdk) => {
  await sdk.logger.info(`${APP_ID} (v2) loaded`);

  for (const mod of TOOL_MODULES) {
    if (!mod?.name || typeof mod.execute !== "function") {
      await sdk.logger.warn(`${APP_ID}: 跳过形状异常的工具模块 ${mod?.name || "(anonymous)"}`);
      continue;
    }
    const sessionPermission = sanitizeSessionPermission(mod.sessionPermission);
    await sdk.tools.register({
      name: `${TOOL_PREFIX}${mod.name}`,
      description: mod.description,
      parameters: mod.parameters,
      ...(sessionPermission ? { sessionPermission } : {}),
      execute: async (args) => normalizeToolResult(await mod.execute(
        args ?? {},
        createLegacyCtx(sdk, { appId: APP_ID, toolContext: args?.context ?? null }),
      )),
    });
  }

  // 单 bundle 路线：在入口里注册后端路由，路由地址是
  //   /api/apps/mineru-document-workbench/routes/<子路径>
  // 注意：v2 里 `routes/` 目录与 ctx.routes.register 互斥。这里选了入口注册，
  // 所以路由源统一放在 lib/routes/ 下，不放在应用根目录的 routes/。
  await sdk.routes.register((app) => {
    const ctx = createLegacyCtx(sdk, { appId: APP_ID, toolContext: null });
    registerJobRoutes(app, ctx);
    registerStatusRoutes(app, ctx);
    registerTranslateRoutes(app, ctx);
    registerExportRoutes(app, ctx);
    registerIntakeRoutes(app, ctx);
  });

  await sdk.logger.info(`${APP_ID} (v2) ready: ${TOOL_MODULES.length} tools, backend routes mounted`);
});
