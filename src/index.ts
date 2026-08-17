import { randomUUID } from 'node:crypto'
import { availableParallelism } from 'node:os'
import { Script } from 'node:vm'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import WorkflowEngine, {
  WorkflowError,
  WorkflowRunId,
  type WorkflowRun,
  type WorkflowRunInfo,
  type WorkflowStartRequest,
} from '@deepseek-ai/dsh-workflow'
import { IsolatedRun } from './host.ts'
import { renderThrown, snapshotJson } from './json.ts'
import { validateMeta } from './meta.ts'
import type { IsolateLimits, WorkerInit } from './protocol.ts'

export { IsolatedRun, workerSpawnEnv } from './host.ts'
export type { IsolatedRunObserver, IsolatedRunOptions } from './host.ts'
export { JsonBoundaryError, snapshotJson } from './json.ts'
export { validateMeta } from './meta.ts'
export type { IsolateLimits, IsolateMetrics, IsolateRunMetrics } from './protocol.ts'

export interface Config {
  /** Host-side subagent provider used by every agent() call. */
  provider?: string
  /** QuickJS heap ceiling for one run. */
  memoryLimitBytes?: number
  /** QuickJS interpreter stack ceiling for one run. */
  maxStackBytes?: number
  /** Maximum QuickJS interrupt-handler invocations before termination. */
  maxInterruptTicks?: number
  /** Maximum UTF-8 script body size. */
  maxScriptBytes?: number
  /** Maximum UTF-8 JSON result size. */
  maxResultBytes?: number
  /** Maximum UTF-8 JSON payload for one agent() request. */
  maxAgentRequestBytes?: number
  /** Worker wall-time deadline, including child-agent waits. */
  maxWallTimeMs?: number
  /** V8 old-generation ceiling for the worker host bridge. */
  workerMemoryLimitMb?: number
  /** Concurrent child calls; zero derives a conservative CPU-based value. */
  maxConcurrentAgents?: number
  /** Deployment ceiling for total child calls in one run. */
  maxTotalAgents?: number
  /** Items accepted by one parallel() or pipeline() call. */
  maxItemsPerCall?: number
  /** Cancellation grace before forced worker termination. */
  disposeGraceMs?: number
}

type ResolvedConfig = Required<Config>

const META_STATEMENT = /^\s*export\s+const\s+meta\b/
const MAX_TIMER_MS = 2_147_483_647

function assertScript(script: unknown, workflowName: string, maxScriptBytes: number): asserts script is string {
  if (typeof script !== 'string') {
    throw new WorkflowError('workflow script must be a string', 'SCRIPT_PARSE')
  }
  const bytes = Buffer.byteLength(script, 'utf8')
  if (bytes > maxScriptBytes) {
    throw new WorkflowError(
      `workflow script is ${bytes} bytes, over the ${maxScriptBytes}-byte limit`,
      'SCRIPT_PARSE',
    )
  }
  if (META_STATEMENT.test(script)) {
    throw new WorkflowError(
      'workflow meta belongs in the request meta field; remove the export const meta statement from the script',
      'SCRIPT_PARSE',
    )
  }
  try {
    // Construction parses the official engine's async-arrow body shape but never invokes it.
    void new Script(`(async () => {\n${script}\n})()`, { filename: `workflow:${workflowName}` })
  } catch (error: unknown) {
    throw new WorkflowError(
      `workflow "${workflowName}" script does not parse: ${renderThrown(error)}`,
      'SCRIPT_PARSE',
      { cause: error },
    )
  }
}

function resolveProvider(ctx: Context, configured: string, override: string | undefined): string {
  const provider = override ?? configured
  if (provider.length === 0 || provider !== provider.trim()) {
    throw new WorkflowError(
      'workflow subagentProvider must be a non-empty normalized string',
      'INVALID_ARGUMENT',
    )
  }
  if (ctx.subagents.getProvider(provider) === undefined) {
    throw new WorkflowError(`no subagent provider registered for "${provider}"`, 'AGENT_START')
  }
  return provider
}

function resolveMaxTotalAgents(requested: number | undefined, ceiling: number): number {
  if (requested === undefined) return ceiling
  if (!Number.isSafeInteger(requested) || requested < 1) {
    throw new WorkflowError('workflow maxTotalAgents must be a positive safe integer', 'INVALID_ARGUMENT')
  }
  if (requested > ceiling) {
    throw new WorkflowError(
      `workflow maxTotalAgents ${requested} exceeds the engine ceiling ${ceiling}`,
      'INVALID_ARGUMENT',
    )
  }
  return requested
}

function snapshotArgs(args: unknown): unknown {
  try {
    return snapshotJson(args, 'workflow args')
  } catch (error: unknown) {
    throw new WorkflowError(
      `workflow args must be lossless plain JSON data: ${renderThrown(error)}`,
      'INVALID_ARGUMENT',
      { cause: error },
    )
  }
}

/** QuickJS/WASM WorkflowEngine for model-written orchestration scripts. */
class IsolatedWorkflowEngine extends WorkflowEngine {
  static inject = ['subagents']

  static Config: z<Config> = z.object({
    provider: z.string().default('spawn'),
    memoryLimitBytes: z.natural().min(1_048_576).default(67_108_864),
    maxStackBytes: z.natural().min(65_536).default(1_048_576),
    maxInterruptTicks: z.natural().min(1).default(250_000),
    maxScriptBytes: z.natural().min(1).default(262_144),
    maxResultBytes: z.natural().min(1).default(1_048_576),
    maxAgentRequestBytes: z.natural().min(1).default(1_048_576),
    maxWallTimeMs: z.natural().min(1).max(MAX_TIMER_MS).default(600_000),
    workerMemoryLimitMb: z.natural().min(16).default(128),
    maxConcurrentAgents: z.natural().default(0),
    maxTotalAgents: z.natural().min(1).default(1_000),
    maxItemsPerCall: z.natural().min(1).default(4_096),
    disposeGraceMs: z.natural().max(MAX_TIMER_MS).default(3_000),
  })

  private readonly config: ResolvedConfig

  constructor(ctx: Context, config: Config) {
    super(ctx)
    this.config = config as ResolvedConfig
  }

  start(request: WorkflowStartRequest): WorkflowRun {
    const meta = validateMeta(request.meta)
    assertScript(request.script, meta.name, this.config.maxScriptBytes)
    const provider = resolveProvider(this.ctx, this.config.provider, request.subagentProvider)
    const maxTotalAgents = resolveMaxTotalAgents(request.maxTotalAgents, this.config.maxTotalAgents)
    const args = request.args === undefined ? undefined : snapshotArgs(request.args)
    const id = WorkflowRunId(randomUUID())
    const info: WorkflowRunInfo = { id, meta }
    const control = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT)
    const limits: IsolateLimits = {
      memoryLimitBytes: this.config.memoryLimitBytes,
      maxStackBytes: this.config.maxStackBytes,
      maxInterruptTicks: this.config.maxInterruptTicks,
      maxScriptBytes: this.config.maxScriptBytes,
      maxResultBytes: this.config.maxResultBytes,
      maxAgentRequestBytes: this.config.maxAgentRequestBytes,
      maxConcurrentAgents: this.config.maxConcurrentAgents === 0
        ? Math.min(16, Math.max(1, availableParallelism() - 2))
        : this.config.maxConcurrentAgents,
      maxTotalAgents,
      maxItemsPerCall: this.config.maxItemsPerCall,
    }
    const init: WorkerInit = {
      meta,
      body: request.script,
      ...(args === undefined ? {} : { args }),
      limits,
      control,
    }

    const run = new IsolatedRun(
      this.ctx,
      this.ctx.subagents,
      id,
      meta,
      request.parent,
      init,
      provider,
      {
        maxWallTimeMs: this.config.maxWallTimeMs,
        disposeGraceMs: this.config.disposeGraceMs,
        workerMemoryLimitMb: this.config.workerMemoryLimitMb,
      },
      {
        phase: title => { this.emitWorkflowEvent('workflow/phase', info, title) },
        log: message => { this.emitWorkflowEvent('workflow/log', info, message) },
        agentStart: agent => { this.emitWorkflowEvent('workflow/agent-start', info, agent) },
        agentEnd: agent => { this.emitWorkflowEvent('workflow/agent-end', info, agent) },
      },
      request.signal,
    )

    this.emitWorkflowEvent('workflow/start', info)
    void run.result.then((result) => {
      this.emitWorkflowEvent('workflow/end', info, {
        stopReason: result.stopReason,
        ...(result.error === undefined ? {} : { error: result.error }),
        agentsStarted: result.agentsStarted,
      })
    })
    return run
  }
}

export default IsolatedWorkflowEngine
