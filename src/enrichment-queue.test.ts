import { expect, it } from 'vitest';
import { drainQueue, RUN_BUDGET_MS } from '../supabase/functions/enrich-items/queue';

it('drains 15 queued names in one run with at most five calls in flight', async () => {
  const jobs = Array.from({ length: 15 }, (_, i) => i);
  const processed: number[] = [];
  let active = 0; let peak = 0;
  const result = await drainQueue({
    claim: async () => jobs.splice(0, 5),
    process: async job => {
      peak = Math.max(peak, ++active);
      await Promise.resolve();
      processed.push(job); --active;
      return 'completed';
    },
  });
  expect(result).toEqual({ claimed: 15, completed: 15, stopped: 'empty' });
  expect(new Set(processed).size).toBe(15);
  expect(peak).toBe(5);
});

it('leaves unclaimed work for the next run when the time budget runs low', async () => {
  let time = 0;
  const jobs = Array.from({ length: 15 }, (_, i) => i);
  const result = await drainQueue({ now: () => time, claim: async () => jobs.splice(0, 5), process: async () => { time = RUN_BUDGET_MS - 4000; return 'completed'; } });
  expect(result).toEqual({ claimed: 5, completed: 5, stopped: 'time_budget' });
  expect(jobs).toHaveLength(10);
});

it('continues past individual failures but stops claiming after a rate limit', async () => {
  const jobs = Array.from({ length: 15 }, (_, i) => i);
  const result = await drainQueue({ claim: async () => jobs.splice(0, 5), process: async job => job === 0 ? 'failed' : job === 9 ? 'rate_limited' : 'completed' });
  expect(result).toEqual({ claimed: 10, completed: 8, stopped: 'rate_limited' });
  expect(jobs).toHaveLength(5);
});

it('waits for other in-flight completions when one database acknowledgement fails', async () => {
  let finished = false;
  const result = await drainQueue({ claim: async () => [1, 2], process: async job => {
    if (job === 1) throw new Error('database unavailable');
    await Promise.resolve(); finished = true; return 'completed';
  } });
  expect(finished).toBe(true);
  expect(result).toEqual({ claimed: 2, completed: 1, stopped: 'worker_error' });
});
