# Compatibility with the official engine

`dsh-workflow-isolate` targets the workflow seam in DeepSeek Harness `0.1.0-rc.7`. It is intended to replace `@deepseek-ai/dsh-workflow-worker-thread`, not run alongside it. Both provide the single `ctx.workflowEngine` service consumed by `@deepseek-ai/dsh-tool-workflow` and `@deepseek-ai/dsh-tool-ralph`.

The upstream API is a release candidate. Compatibility claims below are version-specific and should be revalidated before widening the peer range.

## Matrix

| Surface            | Official `dsh-workflow-worker-thread` rc.7                    | `dsh-workflow-isolate`                                                            | Status / difference                                      |
| ------------------ | ------------------------------------------------------------- | --------------------------------------------------------------------------------- | -------------------------------------------------------- |
| Cordis service     | Provides `ctx.workflowEngine`                                 | Provides `ctx.workflowEngine`                                                     | Compatible                                               |
| Run API            | `WorkflowStartRequest` to `WorkflowRun`                       | Same DSH types                                                                    | Compatible                                               |
| Result contract    | Never-rejecting result; `completed`, `cancelled`, `error`     | Same                                                                              | Compatible                                               |
| Run ownership      | `cancel()` plus idempotent bounded `dispose()`                | Same                                                                              | Compatible                                               |
| Metadata           | `name`, `description`, optional `whenToUse`, `phases`         | Same strict shape                                                                 | Compatible                                               |
| Script form        | Plain JavaScript function body with top-level `await`         | Same                                                                              | Compatible subset; QuickJS rather than V8 syntax/runtime |
| Guest input        | Global `args`                                                 | Global `args`                                                                     | Compatible, JSON snapshot enforced                       |
| Child hook         | `agent(prompt, options?)`                                     | Same                                                                              | Compatible                                               |
| Child options      | `label`, `phase`, `schema`, `provider`, `model`               | Same closed vocabulary                                                            | Compatible                                               |
| Structured output  | DSH object-rooted JSON Schema subset                          | Same DSH validator                                                                | Compatible                                               |
| Combinators        | `parallel(thunks)`, `pipeline(items, ...stages)`              | Same semantics                                                                    | Compatible                                               |
| Progress hooks     | `phase(title)`, `log(message)`                                | Same events                                                                       | Compatible                                               |
| Child failures     | Ordinary failed child resolves to `null`                      | Same                                                                              | Compatible                                               |
| Fatal hook errors  | Invalid call/schema/cap terminates workflow                   | Same                                                                              | Compatible                                               |
| Event family       | Six `workflow/*` events                                       | Same                                                                              | Compatible                                               |
| Event pairing      | Start/end and agent-start/agent-end paired                    | Same, including synthesized termination ends                                      | Compatible                                               |
| Provider policy    | Configured provider; per-run override                         | Same                                                                              | Compatible                                               |
| Per-run total cap  | May lower configured ceiling                                  | Same                                                                              | Compatible                                               |
| Agent request size | No separate payload cap                                       | 1 MiB default UTF-8 JSON cap                                                      | Additional limit                                         |
| Worker topology    | One Node worker per run                                       | One Node worker per run                                                           | Compatible operational shape                             |
| Guest runtime      | V8 `node:vm` in worker                                        | QuickJS/WASM in worker                                                            | Deliberately different                                   |
| Security stance    | Upstream explicitly says `node:vm` is not a security boundary | Separate language runtime with narrow bridge; still not an absolute sandbox claim | Stronger boundary, different risk profile                |
| Synchronous limit  | V8 `vm` timeout for initial slice                             | QuickJS interrupt-fuel budget across guest execution                              | Different tuning unit                                    |
| Elapsed limit      | Cancellation/disposal grace                                   | Explicit host wall deadline plus disposal grace                                   | Additional limit                                         |
| Guest memory/stack | Primarily worker/V8 behavior                                  | Explicit QuickJS heap and stack limits plus worker limits                         | Additional limits                                        |
| Node globals       | Not intentionally injected; recoverable after a VM escape     | Not injected; guest constructors remain in QuickJS                                | Deliberately stronger separation                         |
| Timers/modules/I/O | Not part of script API                                        | Not installed                                                                     | Compatible intended API                                  |
| Error stacks/text  | V8 formatting                                                 | QuickJS/bridge formatting                                                         | May differ; do not parse free-form text                  |
| Metrics            | No isolate-metrics contract                                   | Concrete `IsolatedRun.metrics` promise with QuickJS termination/resource data     | Public extension; not part of DSH seam                   |

## JavaScript portability

Workflow scripts should be runtime-neutral orchestration code. Supported patterns include async functions, promises, arrays, plain objects, JSON methods, `Promise.all`, closures, and the provided workflow hooks.

Do not depend on:

- Node.js globals or built-in modules;
- dynamic `import()` or CommonJS loading;
- `Buffer`, streams, filesystem, sockets, subprocesses, or timers;
- V8-specific syntax, stack traces, error messages, or optimization behavior;
- shared object identity with the host; or
- non-JSON return values.

The engine synchronously parse-checks the same async-function-body shape with V8, then QuickJS compiles it in the worker. A script accepted by the official V8 engine can therefore settle as an error if it uses a JavaScript feature that the pinned QuickJS build does not implement.

## Script-hook behavior

### `agent(prompt, options?)`

The prompt must be a non-empty string. Options are a plain JSON object containing only `label`, `phase`, `schema`, `provider`, and `model`. With `schema`, the resolved value is validated structured output; without it, the resolved value is final child text. A child that ends without `completed` resolves to `null`.

Bad arguments, unknown options, unsupported schema keywords, provider startup failure, infrastructure result failure, cancellation, and budget exhaustion are fatal. The combinators rethrow those failures rather than silently converting them to an item-level `null`.

### `parallel(thunks)`

Accepts an array of zero-argument functions, runs them concurrently subject to the engine's agent admission cap, and waits for all. An ordinary thunk exception becomes `null` for that item.

### `pipeline(items, ...stages)`

Each item progresses through the stages independently. A stage receives `(previous, originalItem, index)`. There is no barrier between stages. An ordinary exception turns that item into `null` and skips its later stages.

### `phase(title)` and `log(message)`

These are observer narration only. A phase groups later agents by title; it does not impose execution ordering. Calls emit the standard DSH lifecycle events.

## Upgrade checklist

Before claiming compatibility with a newer DSH release:

1. Diff `@deepseek-ai/dsh-workflow` request, result, event, and error types.
2. Diff the official worker engine's metadata, hook, cap, cancellation, and lifecycle behavior.
3. Run the shared contract tests against both providers.
4. Boot a real DSH profile with `@deepseek-ai/dsh-tool-workflow` and `tool-ralph` consumers.
5. Exercise cancellation before ready, during provider start, during a child, and during guest computation.
6. Verify exact event pairing and that the final value is absent from `workflow/end`.
7. Re-baseline fuel, wall-time, and memory thresholds on supported Node platforms.
8. Update the peer dependency range and this matrix only after those checks pass.

## Upstream references

- [Official workflow worker-thread README](https://github.com/deepseek-ai/deepseek-harness/blob/99f6f02fecdb7dff40c3fbc9470f5907c29f74ca/packages/workflow/workflow-worker-thread/README.md)
- [Official workflow subsystem documentation](https://github.com/deepseek-ai/deepseek-harness/blob/99f6f02fecdb7dff40c3fbc9470f5907c29f74ca/docs/subsystems/workflow.md)
- [Official model-facing workflow tool](https://github.com/deepseek-ai/deepseek-harness/tree/99f6f02fecdb7dff40c3fbc9470f5907c29f74ca/packages/workflow/tool-workflow)
