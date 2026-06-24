import { useEffect, useRef } from "react";
import { subscribePollJob } from "./poll-scheduler.js";

export function useScheduledPoll(
  id: string | null,
  run: () => void | Promise<void>,
  options: {
    intervalMs: number;
    enabled?: boolean;
    runImmediately?: boolean;
  }
): void {
  const runRef = useRef(run);

  useEffect(() => {
    runRef.current = run;
  }, [run]);

  useEffect(() => {
    if (!id || options.enabled === false) {
      return undefined;
    }
    return subscribePollJob(id, () => runRef.current(), {
      intervalMs: options.intervalMs,
      runImmediately: options.runImmediately
    });
  }, [id, options.enabled, options.intervalMs, options.runImmediately]);
}
