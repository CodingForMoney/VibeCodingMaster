# Rust Layered Example

This is a small Rust workspace designed for VCM harness experiments.

It has three architecture layers:

- `foundation`
- `domain`
- `application`

Each layer contains three crates. Each crate contains three Rust source files, and each source file defines three public functions.

```text
foundation/
  config/
  identity/
  telemetry/
domain/
  accounts/
  catalog/
  orders/
application/
  api/
  reporting/
  worker/
```

The structure is intentionally regular so VCM can test generated context such as layer/crate module indexes and Rust public API extraction.
