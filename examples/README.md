# Examples

DeepSeek Harness's workflow tool accepts three values:

- `meta`: workflow identity and optional progress annotations;
- `args`: plain JSON input exposed as the guest global `args`; and
- `script`: a plain JavaScript function body, not a module and not TypeScript.

[`research-synthesis.mjs`](research-synthesis.mjs) exports those three values as an importable request fixture. The `script` string is the part sent to the model-facing workflow tool or passed to `ctx.workflowEngine.start()` together with a live parent Agent.

The example demonstrates:

- structured child-agent output;
- `pipeline()` without a cross-stage barrier;
- `parallel()` for independent review perspectives;
- explicit phases and observer logs;
- filtering ordinary child failures represented as `null`; and
- returning a plain JSON result.

The file itself is ordinary ESM so editors and test harnesses can import it. Do not include its `export const request = ...` wrapper inside the workflow body.
