import { listJobs } from "../job-store.v6.js";

export const name = "list_jobs";
export const description = "List saved MinerU parsing jobs with their queue/processing state, without exposing credentials or local result paths.";
export const parameters = { type: "object", properties: {} };
export const sessionPermission = { readOnly: true };

export async function execute(_input, ctx) {
  const jobs = await listJobs(ctx.dataDir);
  const now = Date.now();
  const summary = jobs.map((job) => {
    const waitingMinutes = job.createdAt && (job.state === "pending" || job.state === "running")
      ? Math.max(0, Math.round((now - Date.parse(job.createdAt)) / 60000))
      : null;
    return {
      jobId: job.jobId,
      batchId: job.batchId,
      fileName: job.fileName,
      state: job.state,
      stateLabel: job.stateLabel,
      waitingMinutes,
      progress: job.progress,
      createdAt: job.createdAt,
      hasMarkdown: job.hasMarkdown,
      jsonCount: job.jsonCount,
      error: job.error,
    };
  });
  return JSON.stringify(summary);
}
