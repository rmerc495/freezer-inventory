export type JobResult = 'completed' | 'failed' | 'rate_limited';
export const RUN_BUDGET_MS = 45000;
const MIN_CLAIM_BUDGET_MS = 5000;

// Claim only the next small parallel batch; keep draining within this invocation
// instead of waiting another minute between batches. Unclaimed work stays safe.
export async function drainQueue<Job>({ claim, process, now = Date.now }: {
  claim: (deadline: number) => Promise<Job[]>;
  process: (job: Job, deadline: number) => Promise<JobResult>;
  now?: () => number;
}) {
  const deadline = now() + RUN_BUDGET_MS;
  let claimed = 0;
  let completed = 0;
  while (deadline - now() >= MIN_CLAIM_BUDGET_MS) {
    const jobs = await claim(deadline);
    if (!jobs.length) return { claimed, completed, stopped: 'empty' };
    claimed += jobs.length;
    // Wait for the whole batch even if one database completion fails, so no
    // in-flight request is abandoned when the handler returns.
    const results = await Promise.allSettled(jobs.map(job => process(job, deadline)));
    completed += results.filter(result => result.status === 'fulfilled' && result.value === 'completed').length;
    if (results.some(result => result.status === 'rejected')) return { claimed, completed, stopped: 'worker_error' };
    if (results.some(result => result.status === 'fulfilled' && result.value === 'rate_limited')) return { claimed, completed, stopped: 'rate_limited' };
  }
  return { claimed, completed, stopped: 'time_budget' };
}
