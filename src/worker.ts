import { isMainThread, parentPort, workerData, type MessagePort } from 'node:worker_threads'
import { performance } from 'node:perf_hooks'
import { assertObjectJsonSchema, JsonSchemaError } from '@deepseek-ai/dsh-tools'
import {
  getQuickJS,
  isFail,
  type QuickJSContext,
  type QuickJSDeferredPromise,
  type QuickJSHandle,
  type QuickJSRuntime,
} from 'quickjs-emscripten'
import { jsonBytes, renderThrown, snapshotJson } from './json.ts'
import {
  CONTROL_STOP_INDEX,
  StopSignal,
  type ChildRequest,
  type ChildResult,
  type HostToWorkerMessage,
  type IsolateMetrics,
  type WorkerInit,
  type WorkerToHostMessage,
} from './protocol.ts'
import { workflowPrelude } from './runtime/prelude.ts'

const parseHostJson: (text: string) => unknown = JSON.parse
const stringifyHostJson: (value: unknown) => string | undefined = JSON.stringify

interface PendingAgent {
  callId: number
  deferred: QuickJSDeferredPromise
  info: {
    seq: number
    label: string
    phase?: string
  }
  request: ChildRequest
  state: 'queued' | 'active'
}

type GuestPromiseResult = { value: QuickJSHandle } | { error: QuickJSHandle }

class AgentCallError extends Error {
  constructor(
    readonly code: 'AGENT_CAP' | 'INVALID_ARGUMENT' | 'REQUEST_CAP' | 'UNSUPPORTED_OPTION' | 'UNSUPPORTED_SCHEMA',
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'AgentCallError'
  }
}

function requireParentPort(): MessagePort {
  if (parentPort === null) throw new Error('dsh-workflow-isolate worker requires a parent port')
  return parentPort
}

function isWorkerInit(value: unknown): value is WorkerInit {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return typeof record.body === 'string'
    && typeof record.meta === 'object'
    && record.meta !== null
    && typeof record.limits === 'object'
    && record.limits !== null
    && record.control instanceof SharedArrayBuffer
}

function guestError(value: unknown): string {
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>
    const name = typeof record.name === 'string' ? record.name : 'Error'
    const message = typeof record.message === 'string' ? record.message : String(value)
    const code = typeof record.code === 'string' ? ` [${record.code}]` : ''
    return `${name}${code}: ${message}`
  }
  return renderThrown(value)
}

function defaultLabel(prompt: string): string {
  const firstLine = prompt.split('\n', 1)[0] ?? prompt
  return firstLine.length <= 48 ? firstLine : `${firstLine.slice(0, 47)}\u2026`
}

export class QuickJsWorkflowExecution {
  private readonly control: Int32Array
  private readonly startedAt = performance.now()
  private runtime!: QuickJSRuntime
  private context!: QuickJSContext
  private fatalFactory!: QuickJSHandle
  private jsonParser!: QuickJSHandle
  private promiseObserver!: QuickJSHandle
  private snapshotFactory!: QuickJSHandle
  private interruptTicks = 0
  private fuelExhausted = false
  private cancelReason = 'workflow cancelled'
  private started = 0
  private active = 0
  private readonly queue: PendingAgent[] = []
  private readonly pending = new Map<number, PendingAgent>()
  private readonly deferreds = new Set<QuickJSDeferredPromise>()
  private resolveJobFailure!: (error: string) => void
  private readonly jobFailure = new Promise<string>((resolve) => { this.resolveJobFailure = resolve })
  private jobError: string | undefined
  private cancellationObserved = false
  private interruptsSuppressed = 0
  private disposed = false

  constructor(
    private readonly init: WorkerInit,
    private readonly emit: (message: WorkerToHostMessage) => void,
  ) {
    this.control = new Int32Array(init.control)
  }

  async initialize(): Promise<void> {
    const quickJs = await getQuickJS()
    this.runtime = quickJs.newRuntime()
    this.runtime.setMemoryLimit(this.init.limits.memoryLimitBytes)
    this.runtime.setMaxStackSize(this.init.limits.maxStackBytes)
    this.runtime.setInterruptHandler(() => {
      if (this.interruptsSuppressed > 0) return false
      this.interruptTicks += 1
      if (Atomics.load(this.control, CONTROL_STOP_INDEX) !== StopSignal.Running) return true
      if (this.interruptTicks > this.init.limits.maxInterruptTicks) {
        this.fuelExhausted = true
        return true
      }
      return false
    })
    this.context = this.runtime.newContext()
    this.installNativeHooks()
    this.evaluateSetup(workflowPrelude(this.init.limits.maxItemsPerCall), 'dsh-workflow-isolate:prelude')
    this.fatalFactory = this.context.getProp(this.context.global, '__dshFatalFactory')
    this.jsonParser = this.context.getProp(this.context.global, '__dshJsonParser')
    this.promiseObserver = this.context.getProp(this.context.global, '__dshPromiseObserver')
    this.snapshotFactory = this.context.getProp(this.context.global, '__dshSnapshotFactory')
    this.evaluateSetup(
      'delete globalThis.__dshFatalFactory; delete globalThis.__dshJsonParser; delete globalThis.__dshPromiseObserver; delete globalThis.__dshSnapshotFactory',
      'dsh-workflow-isolate:seal',
    )
    this.installArgs()
  }

  onMessage(message: HostToWorkerMessage): void {
    switch (message.type) {
      case 'go':
        return
      case 'cancel': {
        if (this.cancellationObserved) return
        this.cancellationObserved = true
        const previous = Atomics.compareExchange(
          this.control,
          CONTROL_STOP_INDEX,
          StopSignal.Running,
          message.signal,
        )
        const signal = previous === StopSignal.Running ? message.signal : previous
        this.cancelReason = signal === StopSignal.Deadline ? 'wall-time limit exceeded' : message.reason
        this.rejectAll(
          signal === StopSignal.Deadline ? 'workflow wall-time limit exceeded' : `workflow run cancelled: ${message.reason}`,
          'CANCELLED',
        )
        return
      }
      case 'child-start-error':
        this.rejectAgent(message.callId, `agent() could not start a child: ${message.error}`, 'AGENT_START')
        return
      case 'child-failed':
        this.rejectAgent(message.callId, `child agent run failed: ${message.error}`, 'AGENT_RESULT')
        return
      case 'child-settled':
        this.resolveAgent(message.callId, message.result)
        return
      default:
        message satisfies never
    }
  }

  async run(): Promise<void> {
    let result: unknown = null
    let error: string | undefined
    let termination: IsolateMetrics['termination'] = 'completed'

    try {
      const source = `(async () => {\n${this.init.body}\n})()`
      const evaluated = this.context.evalCode(source, `workflow:${this.init.meta.name}`)
      if (isFail(evaluated)) {
        throw new Error(this.consumeGuestError(evaluated.error))
      }
      const promise = evaluated.value
      const hostPromise = this.observeGuestPromise(promise)
      promise.dispose()
      this.drainJobs()
      const outcome = await Promise.race([
        hostPromise.then(settled => ({ type: 'settled' as const, settled })),
        this.jobFailure.then(jobError => ({ type: 'job-error' as const, jobError })),
      ])
      if (outcome.type === 'job-error') throw new Error(outcome.jobError)
      const { settled } = outcome
      if (isFail(settled)) {
        throw new Error(this.consumeGuestError(settled.error))
      }
      result = this.materializeWorkflowResult(settled.value)
      // Pending calls here are necessarily detached: any agent promise the
      // workflow awaited had to settle before the body promise did. Match the
      // official engine by publishing the body result and letting the host
      // reap those detached children instead of extending the run lifetime.
      if (this.pending.size === 0) await this.flushDeferredSettlements()
      if (this.jobError !== undefined) throw new Error(this.jobError)

      const signal = Atomics.load(this.control, CONTROL_STOP_INDEX)
      if (signal !== StopSignal.Running) throw new Error(this.stopMessage(signal))
      result = result === undefined ? null : snapshotJson(result, 'workflow result')
      const resultBytes = jsonBytes(result)
      if (resultBytes > this.init.limits.maxResultBytes) {
        throw new Error(`workflow result is ${resultBytes} bytes, over the ${this.init.limits.maxResultBytes}-byte limit`)
      }
    } catch (caught: unknown) {
      const signal = Atomics.load(this.control, CONTROL_STOP_INDEX)
      if (signal === StopSignal.Cancelled) {
        termination = 'cancelled'
        error = `workflow run cancelled: ${this.cancelReason}`
      } else if (signal === StopSignal.Deadline) {
        termination = 'deadline'
        error = 'workflow wall-time limit exceeded'
      } else if (this.fuelExhausted) {
        termination = 'fuel'
        error = `workflow interrupt-fuel limit exceeded (${this.init.limits.maxInterruptTicks} ticks)`
      } else {
        error = this.jobError ?? renderThrown(caught)
        termination = /out of memory|allocation failed|memory limit/i.test(error) ? 'memory' : 'script-error'
      }
      result = null
      this.rejectAll(error, 'CANCELLED')
      await this.flushDeferredSettlements()
    }

    const memoryUsedBytes = this.memoryUsage()
    const metrics: IsolateMetrics = {
      runtime: 'quickjs-wasm',
      wallTimeMs: Math.max(0, performance.now() - this.startedAt),
      interruptTicks: this.interruptTicks,
      ...(memoryUsedBytes === undefined ? {} : { memoryUsedBytes }),
      termination,
    }
    const stopReason = termination === 'completed'
      ? 'completed'
      : termination === 'cancelled' ? 'cancelled' : 'error'
    this.emit({
      type: 'result',
      result: {
        value: result,
        stopReason,
        ...(error === undefined ? {} : { error }),
        agentsStarted: this.started,
      },
      metrics,
    })
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const deferred of this.deferreds) deferred.dispose()
    this.deferreds.clear()
    this.pending.clear()
    this.queue.length = 0
    if (this.fatalFactory?.alive) this.fatalFactory.dispose()
    if (this.jsonParser?.alive) this.jsonParser.dispose()
    if (this.promiseObserver?.alive) this.promiseObserver.dispose()
    if (this.snapshotFactory?.alive) this.snapshotFactory.dispose()
    if (this.context?.alive) this.context.dispose()
    if (this.runtime?.alive) this.runtime.dispose()
  }

  private installNativeHooks(): void {
    const agent = this.context.newFunction('__dshAgent', (promptHandle, optionsHandle, phaseHandle) => {
      const prompt = this.context.getString(promptHandle)
      const options = parseHostJson(this.context.getString(optionsHandle))
      const phase = this.context.typeof(phaseHandle) === 'undefined'
        ? undefined
        : this.context.getString(phaseHandle)
      return this.createAgentPromise(prompt, options, phase)
    })
    const phase = this.context.newFunction('__dshPhase', (titleHandle) => {
      this.emit({ type: 'phase', title: this.context.getString(titleHandle) })
    })
    const log = this.context.newFunction('__dshLog', (messageHandle) => {
      this.emit({ type: 'log', message: this.context.getString(messageHandle) })
    })
    this.context.setProp(this.context.global, '__dshAgent', agent)
    this.context.setProp(this.context.global, '__dshPhase', phase)
    this.context.setProp(this.context.global, '__dshLog', log)
    agent.dispose()
    phase.dispose()
    log.dispose()
  }

  private installArgs(): void {
    if (this.init.args === undefined) {
      this.context.setProp(this.context.global, 'args', this.context.undefined)
      return
    }
    const args = this.jsonHandle(this.init.args)
    this.context.setProp(this.context.global, 'args', args)
    args.dispose()
  }

  private evaluateSetup(source: string, filename: string): void {
    const result = this.context.evalCode(source, filename)
    if (isFail(result)) {
      throw new Error(`failed to initialize QuickJS workflow realm: ${this.consumeGuestError(result.error)}`)
    }
    result.value.dispose()
  }

  private createAgentPromise(rawPrompt: unknown, rawOptions: unknown, rawPhase: unknown): QuickJSHandle {
    const deferred = this.context.newPromise()
    this.trackDeferred(deferred)
    try {
      if (typeof rawPrompt !== 'string' || rawPrompt.length === 0) {
        throw new AgentCallError('INVALID_ARGUMENT', 'agent() requires a non-empty prompt string')
      }
      const options = rawOptions as Record<string, unknown>
      if (typeof options !== 'object' || options === null || Array.isArray(options)) {
        throw new AgentCallError('INVALID_ARGUMENT', 'agent() options must be an object')
      }
      for (const key of Object.keys(options)) {
        if (key !== 'label' && key !== 'phase' && key !== 'schema' && key !== 'provider' && key !== 'model') {
          throw new AgentCallError('UNSUPPORTED_OPTION', `agent() option "${key}" is not supported`)
        }
      }
      for (const key of ['label', 'phase', 'provider', 'model'] as const) {
        if (options[key] !== undefined && typeof options[key] !== 'string') {
          throw new AgentCallError('INVALID_ARGUMENT', `agent() option "${key}" must be a string`)
        }
      }
      let schema: unknown
      if (options.schema !== undefined) {
        try {
          assertObjectJsonSchema(options.schema)
          schema = snapshotJson(options.schema, 'agent() schema')
        } catch (error: unknown) {
          if (!(error instanceof JsonSchemaError)) throw error
          throw new AgentCallError(
            'UNSUPPORTED_SCHEMA',
            `agent() schema is outside the supported subset: ${error.message}`,
            { cause: error },
          )
        }
      }
      if (this.started >= this.init.limits.maxTotalAgents) {
        throw new AgentCallError(
          'AGENT_CAP',
          `this run reached its total agent cap (${this.init.limits.maxTotalAgents})`,
        )
      }
      const seq = this.started + 1
      const label = typeof options.label === 'string' ? options.label : defaultLabel(rawPrompt)
      const phase = typeof options.phase === 'string' ? options.phase : typeof rawPhase === 'string' ? rawPhase : undefined
      const info = { seq, label, ...(phase === undefined ? {} : { phase }) }
      const request: ChildRequest = {
        prompt: rawPrompt,
        ...(schema === undefined ? {} : { schema }),
        ...(typeof options.provider === 'string' ? { provider: options.provider } : {}),
        ...(typeof options.model === 'string' ? { model: options.model } : {}),
      }
      const requestBytes = jsonBytes({ type: 'child-start', callId: seq, info, request })
      if (requestBytes > this.init.limits.maxAgentRequestBytes) {
        throw new AgentCallError(
          'REQUEST_CAP',
          `agent() request is ${requestBytes} bytes, over the ${this.init.limits.maxAgentRequestBytes}-byte limit`,
        )
      }
      this.started = seq
      const record: PendingAgent = {
        callId: seq,
        deferred,
        info,
        request,
        state: 'queued',
      }
      this.pending.set(seq, record)
      this.queue.push(record)
      this.pump()
    } catch (error: unknown) {
      const code = error instanceof AgentCallError ? error.code : 'INVALID_ARGUMENT'
      this.rejectDeferred(deferred, error instanceof Error ? error.message : renderThrown(error), code)
    }
    return deferred.handle
  }

  private pump(): void {
    if (Atomics.load(this.control, CONTROL_STOP_INDEX) !== StopSignal.Running) return
    while (this.active < this.init.limits.maxConcurrentAgents && this.queue.length > 0) {
      const record = this.queue.shift()
      if (record === undefined || !this.pending.has(record.callId)) continue
      record.state = 'active'
      this.active += 1
      this.emit({ type: 'child-start', callId: record.callId, info: record.info, request: record.request })
    }
  }

  private resolveAgent(callId: number, result: ChildResult): void {
    const record = this.pending.get(callId)
    if (record === undefined) return
    try {
      let value: unknown = null
      if (result.stopReason === 'completed') {
        value = record.request.schema === undefined ? result.output : result.structured ?? null
      }
      const handle = this.jsonHandle(snapshotJson(value, 'child agent result'))
      record.deferred.resolve(handle)
      handle.dispose()
      this.finishAgent(record)
    } catch (error: unknown) {
      this.rejectAgent(callId, `child agent result could not cross the isolate boundary: ${renderThrown(error)}`, 'AGENT_RESULT')
    }
  }

  private rejectAgent(callId: number, message: string, code: string): void {
    const record = this.pending.get(callId)
    if (record === undefined) return
    this.rejectDeferred(record.deferred, message, code)
    this.finishAgent(record)
  }

  private rejectAll(message: string, code: string): void {
    for (const record of this.pending.values()) {
      this.rejectDeferred(record.deferred, message, code)
      this.finishAgent(record, false)
    }
    this.queue.length = 0
  }

  private finishAgent(record: PendingAgent, pump = true): void {
    if (!this.pending.delete(record.callId)) return
    if (record.state === 'active') this.active = Math.max(0, this.active - 1)
    if (pump) this.pump()
  }

  private rejectDeferred(deferred: QuickJSDeferredPromise, message: string, code: string): void {
    try {
      this.withInterruptsSuppressed(() => {
        if (!this.fatalFactory?.alive) {
          const error = this.context.newError(message)
          deferred.reject(error)
          error.dispose()
          return
        }
        const messageHandle = this.context.newString(message)
        const codeHandle = this.context.newString(code)
        const called = this.context.callFunction(this.fatalFactory, this.context.undefined, messageHandle, codeHandle)
        messageHandle.dispose()
        codeHandle.dispose()
        if (isFail(called)) {
          deferred.reject(called.error)
          called.error.dispose()
          return
        }
        deferred.reject(called.value)
        called.value.dispose()
      })
    } catch (error: unknown) {
      this.recordJobError(`QuickJS promise rejection failed: ${renderThrown(error)}`)
      try {
        this.withInterruptsSuppressed(() => {
          const fallback = this.context.newError(message)
          deferred.reject(fallback)
          fallback.dispose()
        })
      } catch {
        // The host owns forced termination if an already-failed realm cannot
        // accept its terminal rejection.
      }
    }
  }

  private jsonHandle(value: unknown): QuickJSHandle {
    const snapshot = snapshotJson(value, 'value entering QuickJS')
    const json = stringifyHostJson(snapshot)
    if (json === undefined) throw new TypeError('value is not JSON-serializable')
    const source = this.context.newString(json)
    try {
      const parsed = this.context.callFunction(this.jsonParser, this.context.undefined, source)
      if (isFail(parsed)) {
        throw new Error(`value could not enter QuickJS: ${this.consumeGuestError(parsed.error)}`)
      }
      return parsed.value
    } finally {
      source.dispose()
    }
  }

  private observeGuestPromise(promise: QuickJSHandle): Promise<GuestPromiseResult> {
    return new Promise((resolve) => {
      let completed = false
      const complete = (result: GuestPromiseResult): void => {
        if (!completed) {
          completed = true
          resolve(result)
          return
        }
        if ('value' in result) result.value.dispose()
        else result.error.dispose()
      }
      const onFulfilled = this.context.newFunction('__dshPromiseFulfilled', (value) => {
        complete({ value: value.dup() })
      })
      let onRejected: QuickJSHandle | undefined
      try {
        onRejected = this.context.newFunction('__dshPromiseRejected', (error) => {
          complete({ error: error.dup() })
        })
        const observed = this.context.callFunction(
          this.promiseObserver,
          this.context.undefined,
          promise,
          onFulfilled,
          onRejected,
        )
        if (isFail(observed)) complete({ error: observed.error })
        else observed.value.dispose()
      } finally {
        onFulfilled.dispose()
        onRejected?.dispose()
      }
    })
  }

  private drainJobs(): void {
    if (this.disposed || !this.runtime?.alive) return
    try {
      const result = this.runtime.executePendingJobs()
      if (isFail(result)) {
        this.recordJobError(this.consumeGuestError(result.error))
        return
      }
      result.dispose()
    } catch (error: unknown) {
      this.recordJobError(`QuickJS job drain failed: ${renderThrown(error)}`)
    }
  }

  private trackDeferred(deferred: QuickJSDeferredPromise): void {
    this.deferreds.add(deferred)
    void deferred.settled.then(() => {
      if (!this.disposed) this.drainJobs()
      deferred.dispose()
      this.deferreds.delete(deferred)
    })
  }

  private async flushDeferredSettlements(): Promise<void> {
    if (this.deferreds.size > 0) {
      // A terminally damaged realm may be unable to run a reject callback;
      // never let deferred cleanup hold the worker beyond one event-loop turn.
      await Promise.race([
        Promise.all([...this.deferreds].map(deferred => deferred.settled)),
        new Promise<void>(resolve => { setImmediate(resolve) }),
      ])
      await Promise.resolve()
    }
    this.drainJobs()
  }

  private withInterruptsSuppressed<T>(callback: () => T): T {
    this.interruptsSuppressed += 1
    try {
      return callback()
    } finally {
      this.interruptsSuppressed -= 1
    }
  }

  private recordJobError(error: string): void {
    if (this.jobError !== undefined) return
    this.jobError = error
    this.resolveJobFailure(error)
  }

  private consumeGuestError(error: QuickJSHandle): string {
    try {
      const type = this.context.typeof(error)
      if (type !== 'object' && type !== 'function') return guestError(this.context.dump(error))
      const name = this.guestStringProperty(error, 'name') ?? 'Error'
      const message = this.guestStringProperty(error, 'message') ?? 'QuickJS threw a non-standard error object'
      const code = this.guestStringProperty(error, 'code')
      return `${name}${code === undefined ? '' : ` [${code}]`}: ${message}`
    } catch (dumpError: unknown) {
      return `QuickJS exception could not be decoded: ${renderThrown(dumpError)}`
    } finally {
      error.dispose()
    }
  }

  private guestStringProperty(object: QuickJSHandle, key: string): string | undefined {
    const value = this.context.getProp(object, key)
    try {
      return this.context.typeof(value) === 'string' ? this.context.getString(value) : undefined
    } finally {
      value.dispose()
    }
  }

  private materializeWorkflowResult(value: QuickJSHandle): unknown {
    try {
      if (this.context.typeof(value) === 'undefined') return null
      const called = this.context.callFunction(this.snapshotFactory, this.context.undefined, value)
      if (isFail(called)) throw new Error(this.consumeGuestError(called.error))
      try {
        return parseHostJson(this.context.getString(called.value))
      } finally {
        called.value.dispose()
      }
    } finally {
      value.dispose()
    }
  }

  private stopMessage(signal: number): string {
    return signal === StopSignal.Deadline
      ? 'workflow wall-time limit exceeded'
      : `workflow run cancelled: ${this.cancelReason}`
  }

  private memoryUsage(): number | undefined {
    try {
      const usage = this.runtime.computeMemoryUsage()
      try {
        const memoryUsed = this.context.getProp(usage, 'memory_used_size')
        try {
          return this.context.typeof(memoryUsed) === 'number'
            ? this.context.getNumber(memoryUsed)
            : undefined
        } finally {
          memoryUsed.dispose()
        }
      } finally {
        usage.dispose()
      }
    } catch {
      return undefined
    }
  }
}

async function main(init: WorkerInit): Promise<void> {
  const port = requireParentPort()
  const execution = new QuickJsWorkflowExecution(init, message => { port.postMessage(message) })
  port.on('message', (message: HostToWorkerMessage) => { execution.onMessage(message) })
  try {
    await execution.initialize()
    port.postMessage({ type: 'ready' } satisfies WorkerToHostMessage)
    await new Promise<void>((resolve) => {
      const onGo = (message: HostToWorkerMessage): void => {
        if (message.type !== 'go' && message.type !== 'cancel') return
        port.off('message', onGo)
        resolve()
      }
      port.on('message', onGo)
    })
    await execution.run()
  } catch (error: unknown) {
    port.postMessage({
      type: 'result',
      result: { value: null, stopReason: 'error', error: renderThrown(error), agentsStarted: 0 },
      metrics: {
        runtime: 'quickjs-wasm',
        wallTimeMs: 0,
        interruptTicks: 0,
        termination: 'worker-error',
      },
    })
  } finally {
    try {
      execution.dispose()
    } finally {
      port.close()
    }
  }
}

if (!isMainThread && isWorkerInit(workerData)) void main(workerData)
