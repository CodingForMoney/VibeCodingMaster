# VCM Dev Container

This dev container is the sandbox boundary for running VCM role terminals
against the Rust layered example.

Security defaults:

- runs as the non-root `vscode` user
- drops Linux capabilities
- enables `no-new-privileges`
- disables Docker's default seccomp profile so Codex can run `bwrap`
- mounts only the host Docker socket for Docker CLI access
- does not auto-run project code during container creation

The container includes Rust, Node.js, Docker CLI access, Claude Code, and Codex.
Authenticate AI CLIs inside the container when needed; do not mount host
credential directories into the container by default.

Codex uses `bwrap` on Linux to create its own sandbox. Docker's default seccomp
profile blocks namespace-related syscalls that `bwrap` needs, so this template
uses `--security-opt=seccomp=unconfined`. Keep `--cap-drop=ALL` and
`no-new-privileges`; only add `--privileged` or `SYS_ADMIN` for local debugging
if the host kernel disables unprivileged user namespaces.

Recommended checks:

```bash
cargo test --workspace
cargo clippy --workspace --all-targets
```
