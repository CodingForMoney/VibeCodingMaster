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

The container includes Rust, Node.js, Docker CLI access, and Claude Code.
Authenticate AI CLIs inside the container when needed; do not mount host
credential directories into the container by default.

The container is the sandbox boundary for VCM-managed Claude Code role
sessions. This template also sets `VCM_SANDBOX=devcontainer` as an explicit
fallback signal.

Recommended checks:

```bash
cargo test --workspace
cargo clippy --workspace --all-targets
```
