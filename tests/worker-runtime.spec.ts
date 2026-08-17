import { describe, expect, it } from 'vitest'
import { QuickJsWorkflowExecution } from '../src/worker.ts'
import { StopSignal, type IsolateLimits, type WorkerInit, type WorkerToHostMessage } from '../src/protocol.ts'

const DEFAULT_LIMITS: IsolateLimits = {
  memoryLimitBytes: 64 * 1024 * 1024,
  maxStackBytes: 512 * 1024,
  maxInterruptTicks: 250_000,
  maxScriptBytes: 256 * 1024,
  maxResultBytes: 256 * 1024,
  maxAgentRequestBytes: 256 * 1024,
  maxConcurrentAgents: 2,
  maxTotalAgents: 16,
  maxItemsPerCall: 16,
}

interface ExecuteOptions {
  args?: unknown
  limits?: Partial<IsolateLimits>
  onMessage?: (message: WorkerToHostMessage, execution: QuickJsWorkflowExecution) => void
}

async function execute(body: string, options: ExecuteOptions = {}): Promise<WorkerToHostMessage[]> {
  const control = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT)
  const init: WorkerInit = {
    meta: { name: 'worker-test', description: 'worker test' },
    body,
    ...(options.args === undefined ? {} : { args: options.args }),
    limits: { ...DEFAULT_LIMITS, ...options.limits },
    control,
  }
  const messages: WorkerToHostMessage[] = []
  let execution!: QuickJsWorkflowExecution
  execution = new QuickJsWorkflowExecution(init, (message) => {
    messages.push(message)
    options.onMessage?.(message, execution)
  })
  try {
    await execution.initialize()
    await execution.run()
    return messages
  } finally {
    execution.dispose()
  }
}

function resultOf(messages: WorkerToHostMessage[]): Extract<WorkerToHostMessage, { type: 'result' }> {
  const result = messages.find((message): message is Extract<WorkerToHostMessage, { type: 'result' }> => message.type === 'result')
  if (result === undefined) throw new Error('worker did not emit a result')
  return result
}

function settleChildren(message: WorkerToHostMessage, execution: QuickJsWorkflowExecution): void {
  if (message.type !== 'child-start') return
  queueMicrotask(() => {
    execution.onMessage({
      type: 'child-settled',
      callId: message.callId,
      result: { stopReason: 'completed', output: `result-${message.callId}` },
    })
  })
}

describe('QuickJsWorkflowExecution', () => {
  it('bridges args, progress, and agent results across JSON boundaries', async () => {
    const messages = await execute(`
phase('research')
log('starting')
const child = await agent('inspect the package', { label: 'inspection' })
args.ticket += 1
return { child, input: args }
`, { args: { ticket: 42 }, onMessage: settleChildren })

    expect(messages).toContainEqual({ type: 'phase', title: 'research' })
    expect(messages).toContainEqual({ type: 'log', message: 'starting' })
    expect(messages).toContainEqual(expect.objectContaining({
      type: 'child-start',
      callId: 1,
      info: { seq: 1, label: 'inspection', phase: 'research' },
    }))
    expect(resultOf(messages)).toMatchObject({
      result: {
        value: { child: 'result-1', input: { ticket: 43 } },
        stopReason: 'completed',
        agentsStarted: 1,
      },
      metrics: { runtime: 'quickjs-wasm', termination: 'completed' },
    })
  })

  it('matches the official 48-character default agent label', async () => {
    const messages = await execute(`return await agent('x'.repeat(60))`, { onMessage: settleChildren })
    expect(messages).toContainEqual(expect.objectContaining({
      type: 'child-start',
      info: { seq: 1, label: `${'x'.repeat(47)}\u2026` },
    }))
  })

  it('does not expose Node through guest function constructors or leak prototype changes', async () => {
    const messages = await execute(`
Object.prototype.inRealmOnly = 'guest'
return {
  constructorEscape: phase.constructor('return typeof process + ":" + typeof require')(),
  nativeAgentHook: typeof globalThis.__dshAgent,
  argsType: typeof args,
  inherited: ({}).inRealmOnly,
}
`)

    expect(resultOf(messages).result).toMatchObject({
      stopReason: 'completed',
      value: {
        constructorEscape: 'undefined:undefined',
        nativeAgentHook: 'undefined',
        argsType: 'undefined',
        inherited: 'guest',
      },
    })
    expect((Object.prototype as Record<string, unknown>).inRealmOnly).toBeUndefined()
  })

  it('keeps validation and fatal propagation intact after primordial tampering', async () => {
    const messages = await execute(`
Object.keys = () => []
WeakSet.prototype.has = () => false
globalThis.WeakSet = class FakeWeakSet {}
Promise.all = () => Promise.resolve(['forged'])
return await parallel([() => agent('must not start', { bogus: true })])
`)

    const terminal = resultOf(messages)
    expect(messages.some(message => message.type === 'child-start')).toBe(false)
    expect(terminal.result.stopReason).toBe('error')
    expect(terminal.result.error).toContain('UNSUPPORTED_OPTION')
    expect(terminal.metrics.termination).toBe('script-error')
  })

  it('rejects values that QuickJS dump would otherwise convert lossily', async () => {
    for (const body of [
      'return new Date(0)',
      'Object.prototype.toJSON = () => ({ name: "Forged", message: "forged" }); return Number.NaN',
      'return [, 1]',
      'const value = [1]; value.extra = true; return value',
      'return { [Symbol("hidden")]: true }',
    ]) {
      const terminal = resultOf(await execute(body))
      expect(terminal.result.stopReason).toBe('error')
      expect(terminal.result.error).toContain('RESULT_UNSERIALIZABLE')
      expect(terminal.metrics.termination).toBe('script-error')
    }
  })

  it('rejects accessors without executing their getters', async () => {
    const resultMessages = await execute(`
const value = {}
Object.defineProperty(value, 'secret', {
  enumerable: true,
  get() { log('getter executed'); return 'secret' },
})
return value
`)
    expect(resultOf(resultMessages).result.error).toContain('accessor property')
    expect(resultMessages.some(message => message.type === 'log')).toBe(false)

    const optionMessages = await execute(`
let reads = 0
const options = {}
Object.defineProperty(options, 'label', {
  enumerable: true,
  get() { reads += 1; return 'label' },
})
try {
  agent('must not start', options)
  return { bypassed: true, reads }
} catch (error) {
  return { code: error.code, reads }
}
`)
    expect(optionMessages.some(message => message.type === 'child-start')).toBe(false)
    expect(resultOf(optionMessages).result).toMatchObject({
      stopReason: 'completed',
      value: { code: 'INVALID_ARGUMENT', reads: 0 },
    })
  })

  it('snapshots results without invoking guest-controlled toJSON methods', async () => {
    const terminal = resultOf(await execute(`
Array.prototype.toJSON = () => ({ forged: 'array' })
Object.prototype.toJSON = () => ({ forged: 'object' })
return [1, { ok: true }]
`))
    expect(terminal.result).toMatchObject({
      stopReason: 'completed',
      value: [1, { ok: true }],
    })
  })

  it('observes the body promise without trusting mutable Promise globals', async () => {
    const terminal = resultOf(await execute(`
Promise.resolve = () => ({ then(resolve) { resolve({ forged: 'resolve' }) } })
Promise.prototype.then = function (resolve) { resolve({ forged: 'then' }) }
return { authentic: true }
`))
    expect(terminal.result).toMatchObject({
      stopReason: 'completed',
      value: { authentic: true },
    })
  })

  it('injects child JSON without trusting mutable guest parsers or __proto__ setters', async () => {
    const structured = JSON.parse('{"__proto__":{"polluted":"yes"},"answer":42}') as unknown
    const messages = await execute(`
JSON.parse = () => ({ forged: true })
Array.prototype.toJSON = () => ({ forged: 'array' })
Object.prototype.toJSON = () => ({ forged: 'object' })
const value = await agent('structured', {
  schema: { type: 'object', properties: { answer: { type: 'number' } }, required: ['answer'] },
})
value.answer += 1
return {
  answer: value.answer,
  hasOwnProto: Object.prototype.hasOwnProperty.call(value, '__proto__'),
  polluted: ({}).polluted ?? null,
}
`, {
      onMessage(message, execution) {
        if (message.type !== 'child-start') return
        queueMicrotask(() => {
          execution.onMessage({
            type: 'child-settled',
            callId: message.callId,
            result: { stopReason: 'completed', output: '', structured },
          })
        })
      },
    })

    expect(resultOf(messages).result).toMatchObject({
      stopReason: 'completed',
      value: { answer: 43, hasOwnProto: true, polluted: null },
    })
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })

  it('enforces concurrency without making a dropped agent promise delay the body result', async () => {
    let active = 0
    let peak = 0
    const messages = await execute(`
agent('dropped')
return await parallel([
  () => agent('one'),
  () => agent('two'),
  () => agent('three'),
])
`, {
      limits: { maxConcurrentAgents: 2 },
      onMessage(message, execution) {
        if (message.type !== 'child-start') return
        active += 1
        peak = Math.max(peak, active)
        if (message.request.prompt === 'dropped') return
        setTimeout(() => {
          active -= 1
          execution.onMessage({
            type: 'child-settled',
            callId: message.callId,
            result: { stopReason: 'completed', output: `result-${message.callId}` },
          })
        }, 2)
      },
    })

    expect(peak).toBe(2)
    expect(messages.filter(message => message.type === 'child-start')).toHaveLength(4)
    expect(resultOf(messages).result).toMatchObject({
      stopReason: 'completed',
      value: ['result-2', 'result-3', 'result-4'],
      agentsStarted: 4,
    })
  })

  it('reports schema and total-agent violations with distinct fatal codes', async () => {
    const schemaMessages = await execute(`
return await agent('bad schema', { schema: { type: 'string' } })
`)
    expect(resultOf(schemaMessages).result.error).toContain('UNSUPPORTED_SCHEMA')

    const capMessages = await execute(`
await agent('first')
return await agent('over cap')
`, { limits: { maxTotalAgents: 1 }, onMessage: settleChildren })
    expect(resultOf(capMessages).result).toMatchObject({ stopReason: 'error', agentsStarted: 1 })
    expect(resultOf(capMessages).result.error).toContain('AGENT_CAP')

    const requestMessages = await execute(`return await agent('x'.repeat(64))`, {
      limits: { maxAgentRequestBytes: 32 },
    })
    expect(requestMessages.some(message => message.type === 'child-start')).toBe(false)
    expect(resultOf(requestMessages).result).toMatchObject({ stopReason: 'error', agentsStarted: 0 })
    expect(resultOf(requestMessages).result.error).toContain('REQUEST_CAP')

    const labelMessages = await execute(`return await agent('x', { label: 'y'.repeat(64) })`, {
      limits: { maxAgentRequestBytes: 64 },
    })
    expect(labelMessages.some(message => message.type === 'child-start')).toBe(false)
    expect(resultOf(labelMessages).result.error).toContain('REQUEST_CAP')
  })

  it('turns malformed structured child output into an agent-result failure', async () => {
    const messages = await execute(`
return await agent('structured', {
  schema: { type: 'object', properties: {}, additionalProperties: false },
})
`, {
      onMessage(message, execution) {
        if (message.type !== 'child-start') return
        queueMicrotask(() => {
          execution.onMessage({
            type: 'child-settled',
            callId: message.callId,
            result: { stopReason: 'completed', output: '', structured: Number.NaN },
          })
        })
      },
    })

    expect(resultOf(messages).result.error).toContain('AGENT_RESULT')
    expect(resultOf(messages).metrics.termination).toBe('script-error')
  })

  it('interrupts infinite scripts when their fuel is exhausted', async () => {
    const messages = await execute('await Promise.resolve(); while (true) {}', { limits: { maxInterruptTicks: 20 } })
    const terminal = resultOf(messages)
    expect(terminal.result.stopReason).toBe('error')
    expect(terminal.result.error).toContain('interrupt-fuel limit exceeded')
    expect(terminal.metrics.termination).toBe('fuel')
  })

  it('classifies QuickJS heap exhaustion as a memory termination', async () => {
    const messages = await execute(`
const allocation = new ArrayBuffer(16 * 1024 * 1024)
return allocation.byteLength
`, { limits: { memoryLimitBytes: 2 * 1024 * 1024 } })
    const terminal = resultOf(messages)
    expect(terminal.result.stopReason).toBe('error')
    expect(terminal.metrics.termination).toBe('memory')
  })

  it('settles an in-flight agent call as cancelled without disposing the realm early', async () => {
    const messages = await execute('return await agent("never settles")', {
      onMessage(message, execution) {
        if (message.type !== 'child-start') return
        queueMicrotask(() => {
          execution.onMessage({ type: 'cancel', reason: 'test stop', signal: StopSignal.Cancelled })
        })
      },
    })

    const terminal = resultOf(messages)
    expect(terminal.result).toMatchObject({
      value: null,
      stopReason: 'cancelled',
      error: 'workflow run cancelled: test stop',
      agentsStarted: 1,
    })
    expect(terminal.metrics.termination).toBe('cancelled')
  })
})
