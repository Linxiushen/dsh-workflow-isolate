import { tmpdir } from 'node:os'
import { performance } from 'node:perf_hooks'
import { Worker, type WorkerOptions } from 'node:worker_threads'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type SubagentRuntime from '@deepseek-ai/dsh-subagent'
import type { SubagentRun } from '@deepseek-ai/dsh-subagent'
import type { ObjectJsonSchema } from '@deepseek-ai/dsh-tools'
import type {
  WorkflowAgentEndInfo,
  WorkflowAgentInfo,
  WorkflowMeta,
  WorkflowResult,
  WorkflowRun,
  WorkflowRunId,
} from '@deepseek-ai/dsh-workflow'
import { assistantText, renderThrown, snapshotJson } from './json.ts'
import {
  CONTROL_STOP_INDEX,
  StopSignal,
  type ChildRequest,
  type ChildResult,
  type HostToWorkerMessage,
  type IsolateMetrics,
  type IsolateRunMetrics,
  type WorkerInit,
  type WorkerToHostMessage,
} from './protocol.ts'

interface ChildRecord {
  readonly run: SubagentRun
  readonly info: WorkflowAgentInfo
  disposal?: Promise<void>
}

/** Host-only limits which cannot be enforced from inside QuickJS. */
export interface IsolatedRunOptions {
  maxWallTimeMs: number
  disposeGraceMs: number
  workerMemoryLimitMb: number
}

/** Lifecycle sink supplied by the engine so this class stays event-system agnostic. */
export interface IsolatedRunObserver {
  phase(title: string): void
  log(message: string): void
  agentStart(info: WorkflowAgentInfo): void
  agentEnd(info: WorkflowAgentEndInfo): void
}

/**
 * Build the deliberately sparse environment inherited by the worker. Windows
 * needs its real temp directory for tsx's transform cache; no credentials or
 * loader configuration cross the boundary.
 */
export function workerSpawnEnv(
  platform: NodeJS.Platform = process.platform,
  tsconfigPath?: string,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  if (platform === 'win32') {
    const temporaryDirectory = tmpdir()
    env.TMP = temporaryDirectory
    env.TEMP = temporaryDirectory
  }
  if (tsconfigPath !== undefined) env.TSX_TSCONFIG_PATH = tsconfigPath
  return env
}

function workerOptions(init: WorkerInit, limits: IsolatedRunOptions): WorkerOptions {
  return {
    workerData: init,
    env: workerSpawnEnv(),
    execArgv: [],
    resourceLimits: {
      maxOldGenerationSizeMb: Math.max(16, Math.floor(limits.workerMemoryLimitMb)),
    },
  }
}

/** Resolve the bundled worker or install tsx in an unbuilt test worker. */
function resolveWorkerSpawn(
  init: WorkerInit,
  limits: IsolatedRunOptions,
): { entry: string | URL; options: WorkerOptions } {
  if (!import.meta.url.endsWith('.ts')) {
    return {
      entry: fileURLToPath(new URL('./worker.js', import.meta.url)),
      options: workerOptions(init, limits),
    }
  }

  const workerEntry = new URL('./worker.ts', import.meta.url)
  const tsxEsmApiEntry = import.meta.resolve('tsx/esm/api')
  const tsxCjsApiEntry = import.meta.resolve('tsx/cjs/api')
  const bootstrap = [
    `import { register as registerEsm } from ${JSON.stringify(tsxEsmApiEntry)}`,
    `import { register as registerCjs } from ${JSON.stringify(tsxCjsApiEntry)}`,
    'registerCjs()',
    'registerEsm()',
    `await import(${JSON.stringify(workerEntry.href)})`,
  ].join('\n')
  return {
    entry: new URL(`data:text/javascript,${encodeURIComponent(bootstrap)}`),
    options: {
      ...workerOptions(init, limits),
      env: workerSpawnEnv(undefined, process.env.TSX_TSCONFIG_PATH),
    },
  }
}

function snapshotInit(init: WorkerInit): WorkerInit {
  const meta = snapshotJson(init.meta, 'workflow meta') as WorkflowMeta
  const limits = snapshotJson(init.limits, 'workflow limits') as WorkerInit['limits']
  return {
    meta,
    body: init.body,
    ...(init.args === undefined ? {} : { args: snapshotJson(init.args, 'workflow args') }),
    limits,
    control: init.control,
  }
}

/**
 * One holder-owned QuickJS workflow. The first result, stop-grace expiry, or
 * worker death owns settlement; all later signals are cleanup-only.
 */
export class IsolatedRun implements WorkflowRun, IsolateRunMetrics {
  readonly result: Promise<WorkflowResult>
  readonly metrics: Promise<IsolateMetrics>

  private readonly startedAt = performance.now()
  private readonly worker: Worker
  private readonly control: Int32Array
  private readonly controller = new AbortController()
  private readonly children = new Map<number, ChildRecord>()
  private readonly pendingStarts = new Set<Promise<void>>()
  private readonly pendingForwards = new Set<Promise<void>>()
  private readonly liveAgents = new Map<number, WorkflowAgentInfo>()
  private readonly quiescenceWaiters: Array<() => void> = []
  private settleResultResolve!: (result: WorkflowResult) => void
  private settleMetricsResolve!: (metrics: IsolateMetrics) => void
  private settled = false
  private metricsSettled = false
  private terminalClaimed = false
  private workerDeathObserved = false
  private workerGone = false
  private hostStarted = 0
  private stopSignal: StopSignal.Cancelled | StopSignal.Deadline | undefined
  private stopReason: string | undefined
  private wallTimer: NodeJS.Timeout | undefined
  private graceTimer: NodeJS.Timeout | undefined
  private inputSignal: AbortSignal | undefined
  private inputSignalAbort: (() => void) | undefined
  private disposed: Promise<void> | undefined
  private termination: Promise<void> | undefined

  constructor(
    private readonly ctx: Context,
    private readonly subagents: SubagentRuntime,
    readonly id: WorkflowRunId,
    readonly meta: WorkflowMeta,
    private readonly parent: Agent,
    init: WorkerInit,
    private readonly provider: string,
    private readonly options: IsolatedRunOptions,
    private readonly observer: IsolatedRunObserver,
    signal: AbortSignal | undefined,
  ) {
    this.result = new Promise((resolve) => { this.settleResultResolve = resolve })
    this.metrics = new Promise((resolve) => { this.settleMetricsResolve = resolve })
    this.control = new Int32Array(init.control)
    if (this.control.length <= CONTROL_STOP_INDEX) {
      throw new TypeError('workflow control buffer is too small')
    }

    const spawn = resolveWorkerSpawn(snapshotInit(init), options)
    this.worker = new Worker(spawn.entry, spawn.options)
    this.worker.on('message', (message: WorkerToHostMessage) => { this.onMessage(message) })
    this.worker.on('error', (error) => {
      this.onWorkerDeath(`workflow isolate worker failed: ${renderThrown(error)}`, false)
    })
    this.worker.on('messageerror', (error) => {
      this.onWorkerDeath(`workflow isolate worker message failed to deserialize: ${renderThrown(error)}`, false)
    })
    this.worker.on('exit', (code) => {
      this.workerGone = true
      this.onWorkerDeath(`workflow isolate worker exited before the run settled (exit code ${code})`, true)
    })

    this.wallTimer = setTimeout(() => {
      this.requestStop(StopSignal.Deadline, 'workflow wall-time limit exceeded')
    }, options.maxWallTimeMs)
    this.wallTimer.unref()

    if (signal?.aborted) {
      this.cancel('workflow start signal already aborted')
    } else if (signal !== undefined) {
      const onAbort = (): void => {
        this.detachInputSignal()
        this.cancel('workflow signal aborted')
      }
      this.inputSignal = signal
      this.inputSignalAbort = onAbort
      signal.addEventListener('abort', onAbort, { once: true })
    }
  }

  cancel(reason?: string): void {
    this.requestStop(StopSignal.Cancelled, reason ?? 'workflow cancelled')
  }

  dispose(): Promise<void> {
    if (this.disposed !== undefined) return this.disposed
    let resolveDispose!: () => void
    let rejectDispose!: (error: unknown) => void
    const claimed = new Promise<void>((resolve, reject) => {
      resolveDispose = resolve
      rejectDispose = reject
    })
    this.disposed = claimed
    void (async () => {
      this.detachInputSignal()
      this.cancel('workflow disposed')
      this.reapChildren('workflow disposed')
      await waitAtMost((async () => {
        await this.result
        await this.childQuiescence()
      })(), this.options.disposeGraceMs)
      if (!this.settled) this.forceStop()
      await this.terminateWorker()
      this.reapChildren('workflow disposed')
      this.endStrandedAgents()
    })().then(resolveDispose, rejectDispose)
    return claimed
  }

  private requestStop(signal: StopSignal.Cancelled | StopSignal.Deadline, reason: string): void {
    if (this.settled || this.terminalClaimed || this.stopSignal !== undefined) return
    this.stopSignal = signal
    this.stopReason = reason
    Atomics.compareExchange(this.control, CONTROL_STOP_INDEX, StopSignal.Running, signal)
    this.post({ type: 'cancel', reason, signal })
    this.reapChildren(reason)
    this.graceTimer = setTimeout(() => { this.forceStop() }, this.options.disposeGraceMs)
    this.graceTimer.unref()
  }

  private forceStop(): void {
    if (this.terminalClaimed) return
    this.terminalClaimed = true
    this.workerDeathObserved = true
    this.reapChildren(this.stopReason ?? 'workflow isolate terminated')
    this.endStrandedAgents()
    this.abandonForwards()
    this.settleMetrics(this.syntheticMetrics(this.stopTermination()))
    this.settleResult(this.stoppedResult())
    void this.terminateWorker()
  }

  private post(message: HostToWorkerMessage): void {
    if (this.workerGone || this.workerDeathObserved) return
    try {
      this.worker.postMessage(message)
    } catch (error: unknown) {
      this.ctx.logger.warn(`dsh-workflow-isolate: worker postMessage failed: ${renderThrown(error)}`)
    }
  }

  private onMessage(message: WorkerToHostMessage): void {
    if (this.workerDeathObserved) return
    switch (message.type) {
      case 'ready':
        this.post({ type: 'go' })
        return
      case 'phase':
        if (this.stopSignal === undefined && !this.terminalClaimed) this.observer.phase(message.title)
        return
      case 'log':
        if (this.stopSignal === undefined && !this.terminalClaimed) this.observer.log(message.message)
        return
      case 'child-start':
        this.onChildStart(message.callId, message.info, message.request)
        return
      case 'result':
        this.onResult(message.result, message.metrics)
        return
      default:
        message satisfies never
    }
  }

  private admissionError(): string | undefined {
    if (this.stopSignal !== undefined) {
      return this.stopSignal === StopSignal.Deadline
        ? 'workflow wall-time limit exceeded'
        : `workflow run cancelled: ${this.stopReason ?? 'workflow cancelled'}`
    }
    if (this.workerDeathObserved || this.workerGone) return 'workflow isolate worker is no longer available'
    if (this.terminalClaimed) return 'workflow run already settled'
    return undefined
  }

  private onChildStart(
    callId: number,
    rawInfo: Omit<WorkflowAgentInfo, 'childId'>,
    rawRequest: ChildRequest,
  ): void {
    let info: Omit<WorkflowAgentInfo, 'childId'>
    let request: ChildRequest
    try {
      info = snapshotJson(rawInfo, 'worker agent info') as Omit<WorkflowAgentInfo, 'childId'>
      request = snapshotJson(rawRequest, 'worker child request') as ChildRequest
    } catch (error: unknown) {
      this.post({ type: 'child-start-error', callId, error: renderThrown(error) })
      return
    }

    this.hostStarted = Math.max(this.hostStarted, info.seq)
    const admissionError = this.admissionError()
    if (admissionError !== undefined) {
      this.post({ type: 'child-start-error', callId, error: admissionError })
      return
    }
    const task = this.startChild(callId, info, request)
    this.pendingStarts.add(task)
    const finish = (): void => {
      this.pendingStarts.delete(task)
      this.notifyChildQuiescence()
    }
    void task.then(finish, finish)
  }

  private async startChild(
    callId: number,
    info: Omit<WorkflowAgentInfo, 'childId'>,
    request: ChildRequest,
  ): Promise<void> {
    let run: SubagentRun
    try {
      run = await this.subagents.start(this.provider, {
        prompt: [{ type: 'text', text: request.prompt }],
        parent: this.parent,
        signal: this.controller.signal,
        ...(request.schema === undefined ? {} : { outputSchema: request.schema as ObjectJsonSchema }),
        ...(request.provider === undefined && request.model === undefined
          ? {}
          : {
              agentOptions: {
                ...(request.provider === undefined ? {} : { provider: request.provider }),
                ...(request.model === undefined ? {} : { model: request.model }),
              },
            }),
      })
    } catch (error: unknown) {
      this.post({
        type: 'child-start-error',
        callId,
        error: this.admissionError() ?? renderThrown(error),
      })
      return
    }

    const admissionError = this.admissionError()
    if (admissionError !== undefined) {
      this.post({ type: 'child-start-error', callId, error: admissionError })
      await this.disposeRefusedChild(run)
      return
    }

    const publishedInfo: WorkflowAgentInfo = {
      seq: info.seq,
      label: info.label,
      ...(info.phase === undefined ? {} : { phase: info.phase }),
      childId: run.id,
    }
    const record: ChildRecord = { run, info: publishedInfo }
    this.children.set(callId, record)
    this.liveAgents.set(publishedInfo.seq, publishedInfo)
    const forwarding = this.forwardChild(callId, record, request.schema !== undefined)
    this.pendingForwards.add(forwarding)
    const finish = (): void => {
      this.pendingForwards.delete(forwarding)
      this.notifyChildQuiescence()
    }
    void forwarding.then(finish, finish)
    this.observer.agentStart(publishedInfo)
  }

  private async forwardChild(callId: number, record: ChildRecord, expectsStructured: boolean): Promise<void> {
    let response: HostToWorkerMessage
    try {
      const result = await record.run.result
      const childResult = snapshotJson({
        stopReason: result.stopReason,
        output: assistantText(result.output),
        ...(result.structured === undefined ? {} : { structured: result.structured }),
      }, 'child result') as ChildResult
      const outcome = this.stopSignal !== undefined
        ? 'cancelled'
        : childResult.stopReason === 'completed' && (!expectsStructured || childResult.structured !== undefined)
          ? 'completed'
          : 'failed'
      this.endAgent({ ...record.info, outcome })
      response = { type: 'child-settled', callId, result: childResult }
    } catch (error: unknown) {
      this.endAgent({
        ...record.info,
        outcome: this.stopSignal === undefined ? 'failed' : 'cancelled',
      })
      response = {
        type: 'child-failed',
        callId,
        error: `workflow child result could not cross the isolate boundary: ${renderThrown(error)}`,
      }
    }
    await this.disposeChild(callId, record)
    this.post(response)
  }

  private async disposeRefusedChild(run: SubagentRun): Promise<void> {
    try {
      await run.dispose()
    } catch (error: unknown) {
      this.ctx.logger.warn(`dsh-workflow-isolate: refused child dispose failed: ${renderThrown(error)}`)
    }
  }

  private disposeChild(callId: number, record: ChildRecord): Promise<void> {
    if (record.disposal !== undefined) return record.disposal
    record.disposal = Promise.resolve()
      .then(() => record.run.dispose())
      .catch((error: unknown) => {
        this.ctx.logger.warn(`dsh-workflow-isolate: child dispose failed: ${renderThrown(error)}`)
      })
      .then(() => {
        if (this.children.get(callId) === record) this.children.delete(callId)
        this.notifyChildQuiescence()
      })
    return record.disposal
  }

  private reapChildren(reason: string): void {
    if (!this.controller.signal.aborted) this.controller.abort(reason)
    for (const [callId, record] of this.children) void this.disposeChild(callId, record)
  }

  private childQuiescence(): Promise<void> {
    if (this.children.size === 0 && this.pendingStarts.size === 0 && this.pendingForwards.size === 0) {
      return Promise.resolve()
    }
    return new Promise((resolve) => { this.quiescenceWaiters.push(resolve) })
  }

  private notifyChildQuiescence(): void {
    if (this.children.size !== 0 || this.pendingStarts.size !== 0 || this.pendingForwards.size !== 0) return
    for (const resolve of this.quiescenceWaiters.splice(0)) resolve()
  }

  private onResult(rawResult: WorkflowResult, rawMetrics: IsolateMetrics): void {
    if (this.terminalClaimed) return
    let result: WorkflowResult
    let metrics: IsolateMetrics
    try {
      result = snapshotJson(rawResult, 'workflow result') as WorkflowResult
      metrics = snapshotJson(rawMetrics, 'isolate metrics') as IsolateMetrics
    } catch (error: unknown) {
      this.onWorkerDeath(`workflow isolate returned invalid boundary data: ${renderThrown(error)}`, false)
      return
    }

    const requestedStop = this.stopSignal
    this.terminalClaimed = true
    this.reapChildren('workflow settled')
    this.endStrandedAgents()
    this.abandonForwards()
    if (requestedStop !== undefined) {
      metrics = {
        ...metrics,
        wallTimeMs: Math.max(metrics.wallTimeMs, performance.now() - this.startedAt),
        termination: this.stopTermination(requestedStop),
      }
      result = this.stoppedResult(result.agentsStarted)
    }
    this.settleMetrics(metrics)
    this.settleResult(result)
  }

  private onWorkerDeath(message: string, isExit: boolean): void {
    if (!this.workerDeathObserved) {
      this.workerDeathObserved = true
      const outcomeWasClaimed = this.terminalClaimed
      if (!outcomeWasClaimed) this.terminalClaimed = true
      this.reapChildren('workflow isolate worker gone')
      this.endStrandedAgents()
      this.abandonForwards()
      if (!outcomeWasClaimed) {
        const termination = this.stopSignal === undefined
          ? workerFailureTermination(message)
          : this.stopTermination()
        this.settleMetrics(this.syntheticMetrics(termination))
        this.settleResult(this.stopSignal === undefined
          ? { value: null, stopReason: 'error', error: message, agentsStarted: this.hostStarted }
          : this.stoppedResult())
      }
    }
    if (isExit) {
      for (const [callId, record] of this.children) void this.disposeChild(callId, record)
      this.endStrandedAgents()
    } else {
      void this.terminateWorker()
    }
  }

  private endAgent(info: WorkflowAgentEndInfo): void {
    if (!this.liveAgents.delete(info.seq)) return
    this.observer.agentEnd(info)
  }

  private endStrandedAgents(): void {
    for (const info of this.liveAgents.values()) {
      this.endAgent({ ...info, outcome: 'cancelled' })
    }
  }

  /** Result forwarding is no longer observable after the worker's terminal boundary. */
  private abandonForwards(): void {
    this.pendingForwards.clear()
    this.notifyChildQuiescence()
  }

  private stoppedResult(agentsStarted = this.hostStarted): WorkflowResult {
    if (this.stopSignal === StopSignal.Deadline) {
      return {
        value: null,
        stopReason: 'error',
        error: 'workflow wall-time limit exceeded',
        agentsStarted,
      }
    }
    const reason = this.stopReason ?? 'workflow cancelled'
    return {
      value: null,
      stopReason: 'cancelled',
      error: `workflow run cancelled: ${reason}`,
      agentsStarted,
    }
  }

  private stopTermination(
    signal: StopSignal.Cancelled | StopSignal.Deadline | undefined = this.stopSignal,
  ): IsolateMetrics['termination'] {
    return signal === StopSignal.Deadline ? 'deadline' : 'cancelled'
  }

  private syntheticMetrics(termination: IsolateMetrics['termination']): IsolateMetrics {
    return {
      runtime: 'quickjs-wasm',
      wallTimeMs: Math.max(0, performance.now() - this.startedAt),
      interruptTicks: 0,
      termination,
    }
  }

  private settleResult(result: WorkflowResult): void {
    if (this.settled) return
    this.terminalClaimed = true
    this.settled = true
    this.detachInputSignal()
    clearTimeout(this.wallTimer)
    clearTimeout(this.graceTimer)
    this.settleResultResolve(result)
  }

  private settleMetrics(metrics: IsolateMetrics): void {
    if (this.metricsSettled) return
    this.metricsSettled = true
    this.settleMetricsResolve(metrics)
  }

  private detachInputSignal(): void {
    if (this.inputSignal === undefined || this.inputSignalAbort === undefined) return
    this.inputSignal.removeEventListener('abort', this.inputSignalAbort)
    this.inputSignal = undefined
    this.inputSignalAbort = undefined
  }

  private terminateWorker(): Promise<void> {
    if (this.termination !== undefined) return this.termination
    this.termination = this.worker.terminate()
      .then(() => undefined)
      .catch((error: unknown) => {
        this.ctx.logger.warn(`dsh-workflow-isolate: worker termination failed: ${renderThrown(error)}`)
      })
    return this.termination
  }
}

function workerFailureTermination(message: string): IsolateMetrics['termination'] {
  return /out of memory|memory limit|ERR_WORKER_OUT_OF_MEMORY/i.test(message) ? 'memory' : 'worker-error'
}

async function waitAtMost(task: Promise<void>, ms: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined
  try {
    await Promise.race([
      task,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, ms)
        timer.unref()
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}
