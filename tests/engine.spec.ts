import { Context } from '@deepseek-ai/cordis'
import { tmpdir } from 'node:os'
import type { Worker } from 'node:worker_threads'
import type { Agent } from '@deepseek-ai/dsh-agent'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import type {
  SubagentCapabilities,
  SubagentProvider,
  SubagentResult,
  SubagentRun,
  SubagentStartRequest,
} from '@deepseek-ai/dsh-subagent'
import { WorkflowError, type WorkflowAgentEndInfo } from '@deepseek-ai/dsh-workflow'
import { afterEach, describe, expect, it } from 'vitest'
import IsolatedWorkflowEngine, { type Config, workerSpawnEnv } from '../src/index.ts'

function fakeParent(): Agent {
  return { id: 'workflow-parent', options: {} } as unknown as Agent
}

function textResult(text: string): SubagentResult {
  return { output: [{ type: 'text', text }], stopReason: 'completed' }
}

function deferred<T>(): {
  promise: Promise<T>
  resolve(value: T | PromiseLike<T>): void
} {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((fulfill) => { resolve = fulfill })
  return { promise, resolve }
}

interface StubRun {
  request: SubagentStartRequest
  settle(result: SubagentResult): void
  disposeCalls: number
}

class StubProvider implements SubagentProvider {
  readonly capabilities: SubagentCapabilities = {
    outputSchema: true,
    depthLimit: true,
    toolFilter: true,
    persona: false,
  }
  readonly inheritsParentContext = false
  readonly runs: StubRun[] = []

  constructor(
    readonly name: string,
    private readonly reply?: (request: SubagentStartRequest, index: number) => SubagentResult,
  ) {}

  async start(request: SubagentStartRequest): Promise<SubagentRun> {
    const terminal = deferred<SubagentResult>()
    let settled = false
    const settle = (result: SubagentResult): void => {
      if (settled) return
      settled = true
      terminal.resolve(result)
    }
    const record: StubRun = { request, settle, disposeCalls: 0 }
    const index = this.runs.push(record) - 1
    request.signal.addEventListener('abort', () => {
      settle({ output: [], stopReason: 'aborted' })
    }, { once: true })
    if (this.reply !== undefined) queueMicrotask(() => { settle(this.reply!(request, index)) })

    return {
      id: `stub-child-${index + 1}` as SubagentRun['id'],
      localAgent: undefined,
      result: terminal.promise,
      dispose: async () => {
        record.disposeCalls += 1
        settle({ output: [], stopReason: 'aborted' })
      },
    }
  }
}

interface Harness {
  ctx: Context
  provider: StubProvider
  parent: Agent
}

const contexts: Context[] = []

async function setup(config: Config = {}, reply?: StubProvider['reply']): Promise<Harness> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SubagentRuntime)
  const provider = new StubProvider('stub', reply ?? ((_request, index) => textResult(`answer-${index + 1}`)))
  ctx.subagents.registerProvider(provider)
  await ctx.plugin(IsolatedWorkflowEngine, {
    provider: 'stub',
    maxConcurrentAgents: 4,
    disposeGraceMs: 500,
    ...config,
  })
  return { ctx, provider, parent: fakeParent() }
}

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

describe('IsolatedWorkflowEngine', () => {
  it('runs parallel children through the real host/worker bridge with paired events', async () => {
    const { ctx, provider, parent } = await setup()
    const order: string[] = []
    const ends: WorkflowAgentEndInfo[] = []
    ctx.on('workflow/start', () => { order.push('start') })
    ctx.on('workflow/phase', (_info, title) => { order.push(`phase:${title}`) })
    ctx.on('workflow/log', (_info, message) => { order.push(`log:${message}`) })
    ctx.on('workflow/agent-start', (_info, agent) => { order.push(`agent-start:${agent.seq}`) })
    ctx.on('workflow/agent-end', (_info, agent) => {
      ends.push(agent)
      order.push(`agent-end:${agent.seq}`)
    })
    ctx.on('workflow/end', () => { order.push('end') })

    const run = ctx.workflowEngine.start({
      meta: {
        name: 'repo-audit',
        description: 'Audit files in parallel',
        phases: [{ title: 'Inspect' }],
      },
      script: `
phase('Inspect')
log('files=' + args.files.length)
const answers = await parallel(args.files.map(file => () => agent('inspect ' + file, { label: file })))
return { answers, ticket: args.ticket }
`,
      args: { files: ['a.ts', 'b.ts'], ticket: 42 },
      parent,
    })
    const result = await run.result
    const metrics = await (run as typeof run & { metrics: Promise<{ termination: string }> }).metrics

    expect(result).toEqual({
      value: { answers: ['answer-1', 'answer-2'], ticket: 42 },
      stopReason: 'completed',
      agentsStarted: 2,
    })
    expect(metrics.termination).toBe('completed')
    expect(provider.runs).toHaveLength(2)
    expect(provider.runs.every(record => record.disposeCalls === 1)).toBe(true)
    expect(ends.map(end => ({ seq: end.seq, outcome: end.outcome }))).toEqual([
      { seq: 1, outcome: 'completed' },
      { seq: 2, outcome: 'completed' },
    ])
    expect(order[0]).toBe('start')
    expect(order.at(-1)).toBe('end')
    expect(order.indexOf('agent-end:1')).toBeLessThan(order.indexOf('end'))
    expect(order.indexOf('agent-end:2')).toBeLessThan(order.indexOf('end'))

    await run.dispose()
  })

  it('cancels an in-flight child and emits exactly one cancelled end', async () => {
    const { ctx, provider, parent } = await setup({}, undefined)
    const providerWithoutReply = new StubProvider('manual')
    ctx.subagents.registerProvider(providerWithoutReply)
    const order: string[] = []
    const childStarted = deferred<undefined>()
    ctx.on('workflow/agent-start', () => {
      order.push('agent-start')
      childStarted.resolve(undefined)
    })
    ctx.on('workflow/agent-end', (_info, agent) => { order.push(`agent-end:${agent.outcome}`) })
    ctx.on('workflow/end', () => { order.push('end') })

    const run = ctx.workflowEngine.start({
      meta: { name: 'cancel-test', description: 'Wait for cancellation' },
      script: "return await agent('wait forever')",
      subagentProvider: 'manual',
      parent,
    })
    await childStarted.promise
    run.cancel('operator stop')
    const result = await run.result
    const metrics = await (run as typeof run & { metrics: Promise<{ termination: string }> }).metrics

    expect(result).toMatchObject({
      value: null,
      stopReason: 'cancelled',
      error: 'workflow run cancelled: operator stop',
      agentsStarted: 1,
    })
    expect(metrics.termination).toBe('cancelled')
    expect(order).toEqual(['agent-start', 'agent-end:cancelled', 'end'])
    expect(provider.runs).toHaveLength(0)
    expect(providerWithoutReply.runs[0]?.request.signal.aborted).toBe(true)
    expect(providerWithoutReply.runs[0]?.disposeCalls).toBe(1)

    await run.dispose()
  })

  it('enforces the host wall deadline even when the guest spins synchronously', async () => {
    const { ctx, parent } = await setup({
      maxWallTimeMs: 100,
      maxInterruptTicks: 1_000_000_000,
      disposeGraceMs: 500,
    })
    const before = performance.now()
    const run = ctx.workflowEngine.start({
      meta: { name: 'deadline-test', description: 'Spin until the wall deadline' },
      script: 'while (true) {}',
      parent,
    })
    const result = await run.result
    const metrics = await (run as typeof run & { metrics: Promise<{ termination: string }> }).metrics

    expect(result.stopReason).toBe('error')
    expect(result.error).toContain('wall-time limit exceeded')
    expect(metrics.termination).toBe('deadline')
    expect(performance.now() - before).toBeLessThan(2_000)

    await run.dispose()
  })

  it('clears the losing disposal deadline after a completed run', async () => {
    const { ctx, parent } = await setup({ disposeGraceMs: 60_000 })
    const run = ctx.workflowEngine.start({
      meta: { name: 'dispose-timer', description: 'Complete before disposal grace' },
      script: 'return 1',
      parent,
    })
    await run.result
    const before = process.getActiveResourcesInfo().filter(resource => resource === 'Timeout').length

    await run.dispose()
    await new Promise<void>((resolve) => { setImmediate(resolve) })

    const after = process.getActiveResourcesInfo().filter(resource => resource === 'Timeout').length
    expect(after).toBeLessThanOrEqual(before)
  })

  it('rejects timer limits above the Node.js timeout range', () => {
    const aboveMaximum = 2_147_483_648

    expect(() => IsolatedWorkflowEngine.Config({ maxWallTimeMs: aboveMaximum })).toThrow()
    expect(() => IsolatedWorkflowEngine.Config({ disposeGraceMs: aboveMaximum })).toThrow()
    expect(IsolatedWorkflowEngine.Config({}).maxAgentRequestBytes).toBe(1_048_576)
  })

  it('rejects malformed requests synchronously without publishing workflow/start', async () => {
    const { ctx, parent } = await setup({ maxScriptBytes: 64 })
    let starts = 0
    ctx.on('workflow/start', () => { starts += 1 })

    expect(() => ctx.workflowEngine.start({
      meta: { name: 'bad', description: 'bad syntax' },
      script: 'return {',
      parent,
    })).toThrow(WorkflowError)
    expect(() => ctx.workflowEngine.start({
      meta: { name: 'not-string', description: 'runtime type guard' },
      script: 42 as unknown as string,
      parent,
    })).toThrow(/script must be a string/)
    expect(() => ctx.workflowEngine.start({
      meta: { name: 'inline-meta', description: 'meta belongs in request data' },
      script: 'export const meta = {}',
      parent,
    })).toThrow(/remove the export const meta statement/)
    expect(() => ctx.workflowEngine.start({
      meta: { name: 'arrow-context', description: 'match the official parser wrapper' },
      script: 'return new.target',
      parent,
    })).toThrow(/does not parse/)
    expect(() => ctx.workflowEngine.start({
      meta: { name: 'bad-provider', description: 'bad provider' },
      script: 'return null',
      subagentProvider: 'missing',
      parent,
    })).toThrow(/no subagent provider/)
    expect(() => ctx.workflowEngine.start({
      meta: { name: 'unnormalized-provider', description: 'bad provider spelling' },
      script: 'return null',
      subagentProvider: ' stub ',
      parent,
    })).toThrow(/non-empty normalized string/)
    expect(() => ctx.workflowEngine.start({
      meta: { name: 'zero-cap', description: 'invalid run cap' },
      script: 'return null',
      maxTotalAgents: 0,
      parent,
    })).toThrow(/positive safe integer/)
    expect(() => ctx.workflowEngine.start({
      meta: { name: 'raised-cap', description: 'cannot raise deployment policy' },
      script: 'return null',
      maxTotalAgents: 1_001,
      parent,
    })).toThrow(/exceeds the engine ceiling/)
    expect(() => ctx.workflowEngine.start({
      meta: { name: 'bad-args', description: 'bad args' },
      script: 'return null',
      args: { value: Number.NaN },
      parent,
    })).toThrow(/lossless plain JSON/)
    expect(() => ctx.workflowEngine.start({
      meta: { name: 'too-large', description: 'large script' },
      script: `return ${JSON.stringify('x'.repeat(80))}`,
      parent,
    })).toThrow(/over the 64-byte limit/)
    expect(starts).toBe(0)
  })

  it('surfaces provider startup failure without publishing an agent event pair', async () => {
    const { ctx, parent } = await setup()
    const rejecting: SubagentProvider = {
      name: 'rejecting',
      capabilities: {
        outputSchema: true,
        depthLimit: true,
        toolFilter: true,
        persona: false,
      },
      inheritsParentContext: false,
      start: async () => { throw new Error('provider unavailable') },
    }
    ctx.subagents.registerProvider(rejecting)
    const childEvents: string[] = []
    ctx.on('workflow/agent-start', () => { childEvents.push('start') })
    ctx.on('workflow/agent-end', () => { childEvents.push('end') })

    const run = ctx.workflowEngine.start({
      meta: { name: 'start-failure', description: 'Provider startup fails' },
      script: "return await agent('cannot start')",
      subagentProvider: 'rejecting',
      parent,
    })
    const result = await run.result

    expect(result.stopReason).toBe('error')
    expect(result.error).toContain('AGENT_START')
    expect(result.error).toContain('provider unavailable')
    expect(result.agentsStarted).toBe(1)
    expect(childEvents).toEqual([])
    await run.dispose()
  })

  it('pairs a published child whose infrastructure result rejects', async () => {
    const { ctx, parent } = await setup()
    const rejectingResult: SubagentProvider = {
      name: 'rejecting-result',
      capabilities: {
        outputSchema: true,
        depthLimit: true,
        toolFilter: true,
        persona: false,
      },
      inheritsParentContext: false,
      start: async () => ({
        id: 'rejecting-result-child' as SubagentRun['id'],
        localAgent: undefined,
        result: Promise.reject(new Error('result channel broke')),
        dispose: async () => undefined,
      }),
    }
    ctx.subagents.registerProvider(rejectingResult)
    const childEvents: string[] = []
    ctx.on('workflow/agent-start', () => { childEvents.push('start') })
    ctx.on('workflow/agent-end', (_info, agent) => { childEvents.push(`end:${agent.outcome}`) })

    const run = ctx.workflowEngine.start({
      meta: { name: 'result-failure', description: 'Child result rejects' },
      script: "return await agent('result rejects')",
      subagentProvider: 'rejecting-result',
      parent,
    })
    const result = await run.result

    expect(result.stopReason).toBe('error')
    expect(result.error).toContain('AGENT_RESULT')
    expect(result.error).toContain('result channel broke')
    expect(childEvents).toEqual(['start', 'end:failed'])
    await run.dispose()
  })

  it('converts premature worker death into a non-rejecting error result', async () => {
    const { ctx, parent } = await setup()
    const armed = deferred<undefined>()
    ctx.on('workflow/log', (_info, message) => {
      if (message === 'armed') armed.resolve(undefined)
    })
    const run = ctx.workflowEngine.start({
      meta: { name: 'worker-death', description: 'Worker exits early' },
      script: "log('armed'); await new Promise(() => {})",
      parent,
    })
    await armed.promise
    await (run as unknown as { worker: Worker }).worker.terminate()
    const result = await run.result
    const metrics = await (run as typeof run & { metrics: Promise<{ termination: string }> }).metrics

    expect(result.stopReason).toBe('error')
    expect(result.error).toContain('exited before the run settled')
    expect(metrics.termination).toBe('worker-error')
    await run.dispose()
  })

  it('honors a signal aborted before worker readiness without executing narration', async () => {
    const { ctx, parent } = await setup({ disposeGraceMs: 200 })
    const controller = new AbortController()
    controller.abort('already stopped')
    const logs: string[] = []
    ctx.on('workflow/log', (_info, message) => { logs.push(message) })

    const run = ctx.workflowEngine.start({
      meta: { name: 'pre-cancelled', description: 'Already cancelled' },
      script: "log('must not run'); return 1",
      parent,
      signal: controller.signal,
    })
    const result = await run.result

    expect(result.stopReason).toBe('cancelled')
    expect(result.error).toContain('start signal already aborted')
    expect(logs).toEqual([])
    await run.dispose()
  })

  it('builds a credential-free worker environment on each supported platform arm', () => {
    expect(workerSpawnEnv('linux')).toEqual({})
    expect(workerSpawnEnv('win32')).toEqual({ TMP: tmpdir(), TEMP: tmpdir() })
    expect(workerSpawnEnv('linux', 'C:/repo/tsconfig.json')).toEqual({
      TSX_TSCONFIG_PATH: 'C:/repo/tsconfig.json',
    })
  })

})
