type PollRun = () => void | Promise<void>;

interface PollJob {
  id: string;
  intervalMs: number;
  nextRunAt: number;
  inFlight: boolean;
  run: PollRun;
  token: symbol;
}

const MIN_TICK_MS = 1000;
const jobs = new Map<string, PollJob>();
let timer: number | undefined;

export interface PollSubscriptionOptions {
  intervalMs: number;
  runImmediately?: boolean;
}

export function subscribePollJob(id: string, run: PollRun, options: PollSubscriptionOptions): () => void {
  const token = Symbol(id);
  const intervalMs = Math.max(MIN_TICK_MS, options.intervalMs);
  const now = Date.now();
  jobs.set(id, {
    id,
    intervalMs,
    nextRunAt: options.runImmediately === false ? now + intervalMs : now,
    inFlight: false,
    run,
    token
  });
  ensureTimer();
  void runDueJobs();

  return () => {
    const current = jobs.get(id);
    if (current?.token !== token) {
      return;
    }
    jobs.delete(id);
    if (jobs.size === 0 && timer !== undefined) {
      window.clearInterval(timer);
      timer = undefined;
    }
  };
}

function ensureTimer(): void {
  if (timer !== undefined || typeof window === "undefined") {
    return;
  }
  timer = window.setInterval(() => {
    void runDueJobs();
  }, MIN_TICK_MS);
}

async function runDueJobs(): Promise<void> {
  const now = Date.now();
  for (const job of jobs.values()) {
    if (job.inFlight || job.nextRunAt > now) {
      continue;
    }
    void runJob(job);
  }
}

async function runJob(job: PollJob): Promise<void> {
  job.inFlight = true;
  try {
    await job.run();
  } catch {
    // Poll jobs are expected to report user-facing errors themselves.
  } finally {
    const current = jobs.get(job.id);
    if (current?.token === job.token) {
      current.inFlight = false;
      current.nextRunAt = Date.now() + current.intervalMs;
    }
  }
}
