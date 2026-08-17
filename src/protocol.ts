import type { WorkflowAgentInfo, WorkflowMeta, WorkflowResult } from '@deepseek-ai/dsh-workflow'

export const CONTROL_STOP_INDEX = 0

export enum StopSignal {
  Running = 0,
  Cancelled = 1,
  Deadline = 2,
}

export interface IsolateLimits {
  memoryLimitBytes: number
  maxStackBytes: number
  maxInterruptTicks: number
  maxScriptBytes: number
  maxResultBytes: number
  maxAgentRequestBytes: number
  maxConcurrentAgents: number
  maxTotalAgents: number
  maxItemsPerCall: number
}

export interface WorkerInit {
  meta: WorkflowMeta
  body: string
  args?: unknown
  limits: IsolateLimits
  control: SharedArrayBuffer
}

export interface ChildRequest {
  prompt: string
  schema?: unknown
  provider?: string
  model?: string
}

export interface ChildResult {
  stopReason: string
  output: string
  structured?: unknown
}

export interface IsolateMetrics {
  runtime: 'quickjs-wasm'
  wallTimeMs: number
  interruptTicks: number
  memoryUsedBytes?: number
  termination: 'completed' | 'script-error' | 'cancelled' | 'deadline' | 'fuel' | 'memory' | 'worker-error'
}

export type HostToWorkerMessage =
  | { type: 'go' }
  | { type: 'cancel'; reason: string; signal: StopSignal.Cancelled | StopSignal.Deadline }
  | { type: 'child-start-error'; callId: number; error: string }
  | { type: 'child-settled'; callId: number; result: ChildResult }
  | { type: 'child-failed'; callId: number; error: string }

export type WorkerToHostMessage =
  | { type: 'ready' }
  | { type: 'phase'; title: string }
  | { type: 'log'; message: string }
  | {
    type: 'child-start'
    callId: number
    info: Omit<WorkflowAgentInfo, 'childId'>
    request: ChildRequest
  }
  | { type: 'result'; result: WorkflowResult; metrics: IsolateMetrics }

export interface IsolateRunMetrics {
  readonly metrics: Promise<IsolateMetrics>
}
