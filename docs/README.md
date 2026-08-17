# Documentation

`dsh-workflow-isolate` replaces the DeepSeek Harness rc.7 worker-thread workflow engine with a QuickJS/WASM implementation behind the same `ctx.workflowEngine` service.

| Document                            | Purpose                                                                              |
| ----------------------------------- | ------------------------------------------------------------------------------------ |
| [Architecture](architecture.md)     | Components, run sequence, JSON boundaries, scheduling, cancellation, and events      |
| [Compatibility](compatibility.md)   | Behavior matrix against the official rc.7 worker-thread engine and upgrade checklist |
| [Security model](security-model.md) | Trust boundary, goals, non-goals, controls, and deployment guidance                  |
| [Threat model](threat-model.md)     | Attacker capabilities, concrete abuse cases, residual risks, and deployment tiers    |

Start with the [main README](../README.md) for installation and configuration. Operators should read the security and threat models before accepting scripts across a trust boundary. Contributors changing guest globals, native callbacks, boundary values, provider routing, or shared state must update these documents with the code.
