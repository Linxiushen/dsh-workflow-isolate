# Contributing

Thanks for improving `dsh-workflow-isolate`. This project sits on a security-sensitive runtime boundary, so small, reviewable changes with explicit invariants are preferred over broad refactors.

## Prerequisites

- Node.js `22.19.x` or `24.x`
- pnpm `11.7+` and `<12`
- Corepack enabled
- A platform supported by `quickjs-emscripten`

## Set up

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm check
```

Useful focused commands:

```sh
pnpm lint
pnpm typecheck
pnpm test
pnpm test:coverage
pnpm build
pnpm publint
```

Do not edit generated `dist/` output. The production build is created from `src/` and validated by `publint`.

## Design constraints

Changes should preserve these properties unless the proposal explicitly changes the security model:

- The QuickJS guest receives no Node/V8 object or ambient I/O capability.
- The guest API remains closed and intentionally small.
- Realm, worker, and host boundaries transfer plain JSON rather than borrowed object references.
- Every run owns a fresh QuickJS runtime and worker.
- Resource controls remain independent: heap, stack, fuel, wall time, source/result size, fan-out, and disposal grace.
- Terminal state is first-wins and cleanup is idempotent.
- `WorkflowRun.result` never rejects after a run is published.
- Every emitted `workflow/agent-start` has exactly one matching `workflow/agent-end`; start/end run events are also paired.
- DSH rc.7 compatibility is tested at the service seam, not inferred from structural similarity.

Read [Architecture](docs/architecture.md), [Security model](docs/security-model.md), and [Threat model](docs/threat-model.md) before changing the worker protocol, native callbacks, JSON projection, or cancellation path.

## Tests

Match test depth to risk. A normal bug fix should include a regression test. Boundary changes should also include adversarial cases.

Security-sensitive coverage includes:

- constructor/prototype escape attempts and missing Node globals;
- functions, symbols, cycles, sparse arrays, non-finite values, exotic prototypes, and `__proto__` keys;
- infinite loops, recursion, memory pressure, source/result caps, and child fan-out caps;
- cancellation at worker boot, provider start, child execution, and terminal races;
- dropped child promises, late messages, worker failures, and exact lifecycle pairing; and
- a real DSH boot or contract test when the upstream integration changes.

Avoid assertions on free-form QuickJS or V8 stack text. Prefer stable workflow error codes, stop reasons, metrics classifications, and event data.

## Pull requests

Before opening a pull request:

1. Rebase or merge the current default branch without rewriting unrelated work.
2. Run `pnpm check` on a supported Node version.
3. Explain the behavior change, boundary impact, and verification performed.
4. Update both READMEs when user-facing installation, configuration, or compatibility changes.
5. Update the threat model when adding a global, native callback, accepted value type, provider option, or shared state.
6. Add a changelog entry under `Unreleased` for user-visible changes.

Keep commits scoped and use imperative subjects. Generated files, coverage output, local credentials, and environment files must not be committed.

## Compatibility changes

Do not widen DSH peer ranges based only on successful compilation. Follow the checklist in [Compatibility](docs/compatibility.md#upgrade-checklist), including a real profile boot and lifecycle tests against the targeted DSH release.

## Security reports

Do not open a public issue for a possible sandbox escape, host-capability leak, resource-limit bypass, or dependency compromise. Follow [SECURITY.md](SECURITY.md) instead.
