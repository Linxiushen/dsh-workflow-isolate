# Security model

`dsh-workflow-isolate` treats workflow JavaScript as potentially adversarial orchestration input. It places that code in QuickJS/WASM and exposes a narrow RPC surface instead of evaluating it in the host's V8 realm.

This is defense in depth. It is not a claim that arbitrary hostile code can safely share a privileged, multi-tenant DSH process.

## Boundary statement

The intended boundary is between the **QuickJS guest realm** and the **Node.js worker/DSH host**.

Inside the untrusted side:

- the model-written workflow body;
- its `args` data;
- guest-created objects, functions, promises, errors, and prototypes; and
- child result data after it has been projected into JSON.

On the trusted side:

- the engine and worker bootstrap;
- `quickjs-emscripten`, its WASM artifact, and the JavaScript/WASM toolchain;
- DSH, Cordis, and the configured subagent provider;
- model and tool credentials held by the host;
- the provider's child agents and every capability granted to them; and
- the operating system, Node runtime, and dependency installation path.

The host-side provider is intentionally powerful. `agent()` can cause it to spend tokens, reach models and networks, or invoke tools according to provider policy. QuickJS contains orchestration code; it does not reduce the authority of the provider invoked through the allowed RPC.

## Security goals

### No ambient Node authority

The guest does not receive `process`, `require`, `module`, Node built-ins, dynamic import, timers, filesystem, network, or host object references. JavaScript constructors are created by QuickJS, so a constructor-chain expression stays in the QuickJS runtime rather than recovering V8's `Function` constructor.

### Capability-shaped host access

Only `agent`, `parallel`, `pipeline`, `phase`, `log`, and `args` are installed. Native callback references are removed after the frozen guest wrappers are created. `agent()` accepts a closed option vocabulary and maps to one host operation: starting a DSH child agent.

### Data-only crossings

Host/worker/realm payloads cross as plain JSON rather than live objects. Unsupported reachable values cannot cross; cycles, sparse arrays, exotic prototypes, non-finite numbers, and oversized results fail closed. Structured child schemas are restricted to DSH's supported object-rooted subset.

### Bounded computation and fan-out

QuickJS heap, stack, and interrupt limits constrain guest work. A host deadline and worker termination bound uncooperative runs. Separate child concurrency, total-child, per-call item, agent-request, source, and result limits cover resource dimensions that a JavaScript heap limit cannot.

### Bounded lifecycle

Cancellation closes admission and shares one abort signal across provider starts and published children. First-terminal-wins settlement and idempotent disposal prevent late worker or provider messages from reviving a run. Lifecycle events are paired on termination paths.

## Non-goals

The project does not promise:

- protection from a vulnerability in QuickJS, Emscripten glue, Node worker threads, or this bridge;
- operating-system isolation, syscall filtering, or a separate credential namespace;
- safety from a malicious or compromised host-side subagent provider;
- prevention of authorized token spend or external side effects caused through `agent()`;
- elimination of timing, memory-pressure, CPU-contention, or model-output side channels;
- deterministic CPU accounting across QuickJS versions and platforms;
- semantic validation of child-agent output;
- protection from dependency or installation-time supply-chain compromise; or
- uninterrupted host availability under every native/WASM failure mode.

## Control summary

| Risk                        | Primary control                                       | Residual risk                                              |
| --------------------------- | ----------------------------------------------------- | ---------------------------------------------------------- |
| Recover Node globals        | Separate QuickJS runtime; no host object injection    | Runtime or bridge vulnerability                            |
| Infinite synchronous loop   | Interrupt fuel; shared cancellation flag              | Tick rate varies; native failure can delay observation     |
| Excess elapsed time         | Host wall deadline; forced worker termination         | Host event-loop starvation can delay timers                |
| Guest heap/stack exhaustion | QuickJS heap and stack caps                           | WASM/worker overhead exists outside guest accounting       |
| Child-agent explosion       | Concurrency, total-call, and item caps                | Each allowed child can still be expensive                  |
| Oversized provider requests | Per-agent UTF-8 JSON request cap                      | Allowed prompts can still be semantically costly           |
| Boundary object attacks     | Lossless JSON snapshots and schema checks             | Valid JSON can still be very costly within configured caps |
| Prototype pollution         | Plain-object checks and data-property materialization | Bugs in downstream consumers remain possible               |
| Cancellation races          | Admission closure and first-terminal-wins state       | Misbehaving providers may ignore abort until force cleanup |
| Dependency compromise       | Pinned lockfile, review, CI                           | No reproducible-build or provenance guarantee yet          |

## Deployment guidance

1. Pin this repository or package to a reviewed commit/version and keep the lockfile intact.
2. Treat changes to `quickjs-emscripten`, the worker bridge, JSON materialization, or native callbacks as security-sensitive.
3. Set `maxConcurrentAgents` and `maxTotalAgents` from a token/cost budget, not from CPU capacity alone.
4. Lower memory, fuel, wall-time, source, result, and item limits for exposed deployments; test representative legitimate workloads before rollout.
5. Restrict the host subagent provider's models, tools, network, filesystem, and credentials independently. Guest isolation does not substitute for provider policy.
6. Run separate harness processes or containers for mutually hostile tenants. Apply OS-level CPU/memory quotas and network policy where the threat model requires them.
7. Monitor `workflow/end` outcomes and engine metrics for repeated fuel, memory, deadline, and child-cap terminations.
8. Keep DSH and QuickJS updates staged behind adversarial and compatibility tests.

## Verification expectations

Security-sensitive changes should cover at least:

- `constructor` and prototype-chain escape probes;
- attempts to access `process`, `require`, dynamic import, timers, and Node modules;
- cyclic, sparse, non-finite, accessor-bearing, symbol/non-enumerable, exotic-prototype, and `__proto__` values;
- infinite loops, deep recursion, heap exhaustion, oversized source/results/agent requests, and fan-out caps;
- cancellation before ready, during provider startup, during child execution, and after worker settlement;
- worker failure with outstanding children and exact event pairing; and
- dropped `agent()` promises and late provider settlements.

See [Threat model](threat-model.md) for concrete attacker actions and [SECURITY.md](../SECURITY.md) for private reporting.
