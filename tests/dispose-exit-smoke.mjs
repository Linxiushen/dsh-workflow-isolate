import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import IsolatedWorkflowEngine from '../dist/index.js'

const ctx = new Context()
await ctx.plugin(SubagentRuntime)
ctx.subagents.registerProvider({
  name: 'unused',
  capabilities: {
    outputSchema: true,
    depthLimit: true,
    toolFilter: true,
    persona: false,
  },
  inheritsParentContext: false,
  async start() {
    throw new Error('dispose exit smoke does not start children')
  },
})
await ctx.plugin(IsolatedWorkflowEngine, {
  provider: 'unused',
  disposeGraceMs: 60_000,
  maxWallTimeMs: 10_000,
})

const run = ctx.workflowEngine.start({
  meta: { name: 'dispose-exit', description: 'Ensure a losing grace timer is cleared' },
  script: 'return null',
  parent: { id: 'dispose-exit-parent', options: {} },
})
assert.equal((await run.result).stopReason, 'completed')
await run.dispose()
await ctx.fiber.dispose()
