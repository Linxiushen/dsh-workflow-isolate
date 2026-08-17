import { performance } from 'node:perf_hooks'
import { QuickJsWorkflowExecution } from '../dist/worker.js'

const requestedRuns = Number.parseInt(process.env.BENCHMARK_RUNS ?? '25', 10)
const runs = Number.isSafeInteger(requestedRuns) ? Math.min(500, Math.max(5, requestedRuns)) : 25

const limits = {
  memoryLimitBytes: 64 * 1024 * 1024,
  maxStackBytes: 1024 * 1024,
  maxInterruptTicks: 250_000,
  maxScriptBytes: 256 * 1024,
  maxResultBytes: 1024 * 1024,
  maxAgentRequestBytes: 1024 * 1024,
  maxConcurrentAgents: 4,
  maxTotalAgents: 1000,
  maxItemsPerCall: 4096,
}

async function runQuickJs() {
  const messages = []
  const execution = new QuickJsWorkflowExecution({
    meta: { name: 'benchmark', description: 'Runtime overhead benchmark' },
    body: 'return { answer: args.value + 1 }',
    args: { value: 41 },
    limits,
    control: new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT),
  }, message => { messages.push(message) })

  const startedAt = performance.now()
  try {
    await execution.initialize()
    const initializedAt = performance.now()
    await execution.run()
    const finishedAt = performance.now()
    const terminal = messages.find(message => message.type === 'result')
    if (terminal?.result.stopReason !== 'completed' || terminal.result.value?.answer !== 42) {
      throw new Error(`unexpected QuickJS result: ${JSON.stringify(terminal)}`)
    }
    return {
      initializeMs: initializedAt - startedAt,
      executeMs: finishedAt - initializedAt,
      totalMs: finishedAt - startedAt,
    }
  } finally {
    execution.dispose()
  }
}

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
const nativeFunction = new AsyncFunction('args', 'return { answer: args.value + 1 }')

async function runNativeReference() {
  const startedAt = performance.now()
  const result = await nativeFunction({ value: 41 })
  const finishedAt = performance.now()
  if (result.answer !== 42) throw new Error('unexpected native reference result')
  return finishedAt - startedAt
}

function percentile(values, fraction) {
  const ordered = [...values].sort((left, right) => left - right)
  return ordered[Math.min(ordered.length - 1, Math.floor(ordered.length * fraction))]
}

function summary(values) {
  return {
    median: percentile(values, 0.5),
    p95: percentile(values, 0.95),
    min: Math.min(...values),
    max: Math.max(...values),
  }
}

const quickJsSamples = []
const nativeSamples = []
for (let index = 0; index < runs; index += 1) {
  quickJsSamples.push(await runQuickJs())
  nativeSamples.push(await runNativeReference())
}

const warmQuickJs = quickJsSamples.slice(1)
const report = {
  platform: `${process.platform}/${process.arch}`,
  node: process.version,
  runs,
  coldQuickJsMs: quickJsSamples[0],
  warmQuickJsMs: {
    initialize: summary(warmQuickJs.map(sample => sample.initializeMs)),
    execute: summary(warmQuickJs.map(sample => sample.executeMs)),
    total: summary(warmQuickJs.map(sample => sample.totalMs)),
  },
  nativeReferenceMs: summary(nativeSamples),
}

console.log('Node AsyncFunction is an overhead reference, not a security-equivalent engine.')
console.log(JSON.stringify(report, null, 2))
