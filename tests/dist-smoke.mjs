import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import IsolatedWorkflowEngine from '../dist/index.js'
import { StopSignal } from '../dist/protocol.js'

const parent = { id: 'dist-smoke-parent', options: {} }

async function createContext(config) {
  const ctx = new Context()
  await ctx.plugin(SubagentRuntime)
  ctx.subagents.registerProvider({
    name: 'smoke',
    capabilities: {
      outputSchema: true,
      depthLimit: true,
      toolFilter: true,
      persona: false,
    },
    inheritsParentContext: false,
    async start() {
      return {
        id: 'dist-smoke-child',
        localAgent: undefined,
        result: Promise.resolve({
          output: [{ type: 'text', text: 'dist-child-result' }],
          stopReason: 'completed',
        }),
        async dispose() {},
      }
    },
  })
  await ctx.plugin(IsolatedWorkflowEngine, {
    provider: 'smoke',
    maxConcurrentAgents: 1,
    disposeGraceMs: 500,
    ...config,
  })
  return ctx
}

assert.equal(StopSignal.Deadline, 2)

const completedContext = await createContext({ maxWallTimeMs: 10_000 })
try {
  const run = completedContext.workflowEngine.start({
    meta: { name: 'dist-smoke', description: 'Exercise the production bundle' },
    script: "return { child: await agent('smoke'), input: args.value }",
    args: { value: 42 },
    parent,
  })
  assert.deepEqual(await run.result, {
    value: { child: 'dist-child-result', input: 42 },
    stopReason: 'completed',
    agentsStarted: 1,
  })
  await run.dispose()
} finally {
  await completedContext.fiber.dispose()
}

const deadlineContext = await createContext({
  maxInterruptTicks: 1_000_000_000,
  maxWallTimeMs: 100,
})
try {
  const run = deadlineContext.workflowEngine.start({
    meta: { name: 'dist-deadline', description: 'Exercise host termination' },
    script: 'while (true) {}',
    parent,
  })
  const result = await run.result
  assert.equal(result.stopReason, 'error')
  assert.match(result.error, /wall-time limit exceeded/)
  await run.dispose()
} finally {
  await deadlineContext.fiber.dispose()
}

const disposeExit = spawnSync(
  process.execPath,
  [fileURLToPath(new URL('./dispose-exit-smoke.mjs', import.meta.url))],
  { encoding: 'utf8', timeout: 5_000 },
)
assert.equal(disposeExit.error, undefined, disposeExit.error?.message)
assert.equal(disposeExit.status, 0, disposeExit.stderr)

console.log('production bundle worker smoke: ok')
