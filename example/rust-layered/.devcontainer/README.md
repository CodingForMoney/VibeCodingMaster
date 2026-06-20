# VCM Dev Container

This dev container is the sandbox boundary for running VCM role terminals
against the Rust layered example.

Security defaults:

- runs as the non-root `vscode` user
- drops Linux capabilities
- enables `no-new-privileges`
- marks the container as the VCM sandbox boundary
- mounts only the host Docker socket for Docker CLI access
- does not auto-run project code during container creation

The container includes Rust, Node.js, Docker CLI access, Claude Code, and Codex.
Authenticate AI CLIs inside the container when needed; do not mount host
credential directories into the container by default.

VCM-managed Codex Reviewer and Codex Translator sessions auto-detect container
runtimes and start Codex with its nested sandbox disabled. The container is the
security boundary, which avoids Linux container `bwrap` and `apply_patch`
failures caused by double sandboxing. This template also sets
`VCM_SANDBOX=devcontainer` as an explicit fallback signal. Manual Codex CLI runs
may still use Codex's own sandbox and can need host/kernel support for
unprivileged user namespaces.

Recommended checks:

```bash
cargo test --workspace
cargo clippy --workspace --all-targets
```
