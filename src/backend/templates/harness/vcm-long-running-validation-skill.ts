export function renderVcmLongRunningValidationSkillRules(): string {
  return `## Rule

Do not end the current turn only to wait for a long-running shell callback.

Use a bounded file-backed job instead.

## Protocol

1. Start the command through \`.ai/tools/run-long-check\`.
2. Write job state under \`.ai/vcm/jobs/<job-id>/\`.
3. Run \`.ai/tools/watch-job <job-id> --timeout <duration>\` in the same turn.
4. Treat success, failure, and timeout as explicit results.
5. Read the final status and relevant log tail.
6. Record command, result, duration, and required follow-up wherever the caller normally records command evidence.

Example:

\`\`\`bash
.ai/tools/run-long-check -- cargo test --workspace
.ai/tools/watch-job <job-id> --timeout 20m
\`\`\`

## Job Files

\`\`\`text
.ai/vcm/jobs/<job-id>/command.json
.ai/vcm/jobs/<job-id>/status.json
.ai/vcm/jobs/<job-id>/stdout.log
.ai/vcm/jobs/<job-id>/stderr.log
\`\`\`

## Timeout

Timeout is not "unknown". It is a command result.

On timeout:

- summarize the latest log tail
- record the timeout in \`status.json\`
- report whether the timed-out process was stopped
- do not mark the command as passed

\`watch-job\` should attempt to stop the timed-out command process group. If termination cannot be confirmed, say so in the summary.

## Cleanup

\`.ai/vcm/jobs/**\` is runtime state. Delete it after the command result and useful log evidence have been recorded where needed.
`;
}
