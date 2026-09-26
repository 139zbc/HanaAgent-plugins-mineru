import { execute as submitDocument } from "./submit_document.js";
import { PARSE_MODES } from "../parse-options.v2.js";

export const name = "parse_document";
export const description = "Submit a document to MinerU and return its batch ID. Retrieve results later using recover_batch; this compatibility tool does not block on long polling.";
export const parameters = {
  type: "object",
  properties: {
    source: {
      type: "object",
      description: "Hana ResourceRef for the user-selected source file."
    },
    fileName: { type: "string" },
    modelVersion: {
      type: "string",
      enum: PARSE_MODES.map((mode) => mode.id),
      description: "解析方式：vlm（MinerU VLM）、pipeline（MinerU 传统管线）、agent（Agent 轻量解析 API，免 Token）。省略时使用插件配置。"
    },
    isOcr: { type: "boolean", default: false },
    enableTable: { type: "boolean", default: true },
    enableFormula: { type: "boolean", default: true }
  },
  required: ["source"]
};

export const sessionPermission = {
  kind: "external_side_effect",
  describeSideEffect: () => ({
    kind: "external_network_upload",
    summary: "Upload a user-selected document to the configured MinerU service and return generated parsing files.",
    ruleId: "mineru-document-upload",
  }),
};

export async function execute(input = {}, toolCtx) {
  return submitDocument(input, toolCtx);
}
