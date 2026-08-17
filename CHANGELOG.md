# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html) within the constraints of a pre-1.0 DSH release-candidate integration.

## [Unreleased]

## [0.1.0] - 2026-08-18

### Added

- QuickJS/WASM implementation of the DeepSeek Harness `WorkflowEngine` seam targeting DSH `0.1.0-rc.7`.
- Fresh per-run runtime and worker with guest heap, stack, interrupt-fuel, wall-time, source-size, result-size, agent-request, and worker resource limits.
- JSON-only host/worker/realm boundaries and DSH structured-output schema validation.
- Compatible `agent`, `parallel`, `pipeline`, `phase`, `log`, and `args` workflow surface.
- Child concurrency, total-call, and per-combinator item budgets.
- Bounded cancellation/disposal, forced worker termination, and paired `workflow/*` lifecycle events.
- DSH bundle patch that replaces the official worker-thread engine row.
- English and Chinese documentation, architecture and threat model, compatibility matrix, example workflow, and CI/repository templates.

[Unreleased]: https://github.com/Linxiushen/dsh-workflow-isolate/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/Linxiushen/dsh-workflow-isolate/releases/tag/v0.1.0
