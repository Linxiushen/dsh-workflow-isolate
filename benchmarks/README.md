# Runtime benchmark

Run the reproducible microbenchmark from the repository root:

```bash
pnpm benchmark
```

Set `BENCHMARK_RUNS` to an integer from 5 through 500 to change the sample count. The default is 25. The benchmark reports:

- the cold QuickJS/WASM module, runtime, context, and script time;
- warm fresh-runtime initialization, execution, and total median/p95;
- a Node `AsyncFunction` reference for scale.

The Node reference is not a security-equivalent alternative and must not be used to infer isolation strength. Results depend on CPU, OS, Node version, power policy, and concurrent load. Compare results only when those inputs are recorded and equivalent.
