export function renderVcmLongRunningValidationSkillRules(): string {
  return `Use this skill for builds, browser checks, E2E tests, release suites, or any command that may run longer than 2 minutes.

## Rule

Never run the Bash tool with \`run_in_background: true\`, and never detach a process with \`nohup\`, \`setsid\`, \`disown\`, or a trailing \`&\`. VCM denies these calls.

The only sanctioned long-running mechanism is \`.ai/tools/run-long-check\` plus \`.ai/tools/watch-job\` through this skill.

Each run-long-check or watch-job invocation must be the only top-level command in its Bash tool call. Do not pipe it, append or prepend another command, place it in a conditional chain or subshell, capture it with command substitution, or invoke it through a shell command string. Ordinary redirection is allowed. A directly passed script such as \`-- bash /tmp/check.sh\` is allowed; \`-- bash -c '...'\` is not.

The hard ceiling is 60 minutes per job, enforced by the job worker itself. No approval can raise this ceiling; split larger operations into jobs that each fit within it.

## Protocol

1. Start the command with an explicit ceiling: \`.ai/tools/run-long-check --timeout <duration> -- <command>\`. Pass the validation executable and its arguments directly. Do not use a shell command-string wrapper, pipeline its output, or append another command: run-long-check already captures stdout/stderr, and shell wrappers can hide the validation exit code. Pick the ceiling from \`docs/TESTING.md\` guidance or a realistic estimate, never above 60m. The tool prints the job id and creates job state under \`.ai/vcm/jobs/<job-id>/\`.
2. In the same turn, run \`.ai/tools/watch-job <job-id>\` as its own Bash tool call. The default watch window is 8 minutes.
3. If watch-job exits 125, the job is still running and a bounded handoff is active for the next watcher: run \`.ai/tools/watch-job <job-id>\` again immediately. Do not end the turn between windows.
4. Repeat until watch-job reports a terminal result.
5. Read the final status and the relevant log tail.
6. Record command, result, duration, and required follow-up wherever the caller normally records command evidence.

Example:

\`\`\`bash
.ai/tools/run-long-check --timeout 30m -- cargo test --workspace
.ai/tools/watch-job <job-id>
.ai/tools/watch-job <job-id>   # repeat while the exit code is 125
\`\`\`

## Exit Codes

Treat watch-job exit codes as explicit results:

- \`0\`: success.
- \`1\`: failed; read the log tails.
- \`124\`: timeout; the job hit its ceiling and was killed; not passed.
- \`125\`: still running; call watch-job again now.
- \`4\`: orphaned or stale; the job lost foreground supervision and was killed, or its worker died; not passed.
- \`2\`: usage error or unknown job id.

## Supervision

A running job requires a live foreground watcher:

- watch-job renews the job supervision lease while it runs.
- A normal exit 125 records a five-minute handoff deadline for the next model-generated watcher call. The next watcher renews the lease and clears that handoff when it starts.
- Without a normal handoff, about two minutes without lease renewal causes the worker to kill the command process group and record \`orphaned\`. An expired handoff is also recorded as \`orphaned\` with a distinct reason.
- VCM also blocks ending the turn while a job is running. Stay in the turn and keep watching.
- Only one validation job may run at a time; run-long-check refuses to start a second one.

## Job Files

\`\`\`text
.ai/vcm/jobs/<job-id>/command.json
.ai/vcm/jobs/<job-id>/status.json
.ai/vcm/jobs/<job-id>/stdout.log
.ai/vcm/jobs/<job-id>/stderr.log
.ai/vcm/jobs/<job-id>/lease
.ai/vcm/jobs/<job-id>/watch-handoff.json   # present only between normal watch windows
\`\`\`

## Timeout

Timeout is not "unknown". It is a command result.

On timeout the worker stops the command process group and records \`timeout\` in \`status.json\`; watch-job reports it with exit code 124:

- summarize the latest log tail
- report whether the timed-out process was stopped
- do not mark the command as passed
- do not retry in the background

## Cleanup

\`.ai/vcm/jobs/**\` is runtime state. Delete it after the command result and useful log evidence have been recorded where needed.
`;
}
