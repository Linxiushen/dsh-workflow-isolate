# Threat model

## Scope

The protected asset is the Node.js/DSH host authority that should not become directly callable by model-written workflow JavaScript. Secondary assets are host availability, bounded child-agent cost, lifecycle integrity, and the integrity of data crossing the guest boundary.

The primary attacker controls the workflow body and its `args`. The attacker can use standard QuickJS JavaScript, invoke exposed hooks, construct arbitrary in-realm object graphs, schedule promises, throw values, and intentionally consume CPU, stack, heap, result bytes, or child-agent budget.

The following are trusted for this model: the DSH host, engine implementation, QuickJS/Emscripten dependency, Node.js runtime, operating system, package installation channel, Cordis, and selected subagent provider. Compromise of one of those components is outside the guest containment claim.

## Boundary map

| Boundary            | Allowed crossing                                                               | Rejected crossing                                                   |
| ------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------- |
| Host to worker      | Validated metadata, script text, JSON args, numeric limits, shared stop signal | Credentials, general environment, arbitrary host handles            |
| Worker to QuickJS   | Frozen workflow hooks and JSON args                                            | Node globals, V8 functions/objects, module loader, I/O APIs, timers |
| QuickJS to host     | Phase/log strings and validated child-agent request data                       | Functions, prototypes, symbols, cycles, non-JSON values             |
| Host to QuickJS     | Projected child text or validated structured JSON                              | Live child runs, Agents, Cordis context, provider errors as objects |
| Engine to observers | DSH `workflow/*` data snapshots                                                | Live run control and mutable final value aliases                    |

## Attacker actions

### Recover host execution through JavaScript reflection

**Attempt:** use `globalThis`, constructors, prototypes, `eval`, or `Function` to reach `process`, `require`, or a V8 object.

**Mitigation:** these operations remain within QuickJS. No Node object is intentionally installed, and the native bridge is wrapped behind closed guest functions whose raw globals are deleted.

**Residual risk:** a memory-safety or bridge bug could cross the runtime boundary. This project has not received an independent security audit.

### Smuggle capabilities through values

**Attempt:** return functions, getters, proxies, cycles, exotic prototypes, sparse arrays, non-finite numbers, or `__proto__` keys that alter a host object.

**Mitigation:** the bridge transfers a recursive plain-JSON projection, bounds depth/size, and materializes keys as data properties. Non-JSON capabilities are not transferred.

**Residual risk:** logically malicious but valid JSON remains possible. Downstream code must still treat strings and records as untrusted data.

### Run forever

**Attempt:** use a tight loop, unbounded recursion, self-renewing promise work, or ignore cancellation.

**Mitigation:** QuickJS interrupt fuel and shared cancellation checks stop guest execution; a host wall deadline and disposal grace end with `worker.terminate()`.

**Residual risk:** host timer delivery depends on host availability. Interrupt ticks are not exact instruction accounting. Bugs in native/WASM execution may not stop as cleanly as guest bytecode.

### Exhaust memory or stack

**Attempt:** allocate large graphs/strings, recurse deeply, or amplify serialized results.

**Mitigation:** QuickJS heap/stack limits, Node worker resource limits, source/result/agent-request byte caps, JSON-depth checks, and forced termination.

**Residual risk:** worker, WASM, message, and host bookkeeping memory is not identical to QuickJS heap accounting. Simultaneous runs multiply per-run limits.

### Cause uncontrolled child fan-out or spend

**Attempt:** loop over `agent()`, create large `parallel()`/`pipeline()` arrays, or drop returned promises while continuing to enqueue work.

**Mitigation:** total-agent, concurrent-agent, and per-call item caps; host admission closes at terminal state; terminal settlement reaps detached calls, and `dispose()` waits for cleanup only within its configured bound.

**Residual risk:** every allowed child has real model/tool cost and authority. Provider policy and external budgets must cap that cost independently.

### Abuse the allowed provider RPC

**Attempt:** craft prompts or provider/model selections that induce a child agent to disclose data, call tools, access networks, or make external changes.

**Mitigation:** the engine validates the request shape and routes only through registered DSH provider APIs.

**Residual risk:** this behavior is inside the allowed capability. The host provider, its prompt/tool policy, and its credentials remain trusted. Use provider-level sandboxing and approval controls.

### Exploit lifecycle races

**Attempt:** cancel during worker boot, settle children after termination, send duplicate/late messages, or leave starts without ends.

**Mitigation:** ready/go startup, canonical abort signal, admission closure, first-terminal-wins state, idempotent cleanup, child ledger, and synthesized cancellation ends.

**Residual risk:** a provider that ignores cancellation can retain external work beyond the engine's local grace. Its process/service must enforce its own cancellation and quotas.

### Compromise dependencies or build artifacts

**Attempt:** publish or inject malicious QuickJS glue, transitive packages, lockfile changes, or install scripts.

**Mitigation:** exact QuickJS version, frozen lockfile installation in CI, reviewable source, package-surface validation, and release artifacts built from the repository.

**Residual risk:** there is no formal provenance, reproducible-build, or independent artifact-attestation guarantee yet. Consumers should pin commits or verified releases.

## Deployment tiers

| Scenario                                                       | Guidance                                                                                                                          |
| -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Single-user local harness; model already has powerful tools    | This engine adds useful containment and resource controls. Keep ordinary provider approval policy.                                |
| Shared service with trusted users but model-written workflows  | Use strict caps, separate provider credentials/scopes, monitoring, and per-service OS quotas.                                     |
| Mutually hostile tenants or arbitrary public script submission | Do not rely on this package alone. Isolate tenants in separate processes/containers/VMs with OS resource and network controls.    |
| High-value secrets or regulated workloads                      | Require a dedicated security review, dependency governance, restricted providers, and an independently enforced sandbox boundary. |

## Review triggers

Revisit this threat model when any of the following changes:

- a new native callback or guest global is exposed;
- the boundary accepts a type beyond plain JSON;
- QuickJS, Emscripten, Node, or DSH workflow versions change;
- workers are pooled or realms are reused;
- provider routing or script-selectable options expand;
- shared-memory communication expands beyond the stop signal; or
- the engine is used for public multi-tenant script execution.
