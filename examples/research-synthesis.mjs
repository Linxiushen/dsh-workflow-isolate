/**
 * Importable fixture for the DSH workflow tool/engine. The value of `script`
 * is a JavaScript function body evaluated inside the QuickJS guest.
 */
export const request = Object.freeze({
  meta: {
    name: 'research-synthesis',
    description: 'Research several questions, challenge the evidence, and produce a concise synthesis.',
    whenToUse: 'Use for bounded research that benefits from independent evidence gathering and review.',
    phases: [
      { title: 'Research', detail: 'Gather evidence for each question.' },
      { title: 'Review', detail: 'Challenge findings from independent perspectives.' },
      { title: 'Synthesis', detail: 'Produce the final report.' },
    ],
  },
  args: {
    topic: 'Security boundaries for model-written orchestration code',
    audience: 'senior platform engineers',
    questions: [
      'Which capabilities should an orchestration script receive?',
      'Which resource limits matter beyond heap size?',
      'Which risks remain at the host RPC boundary?',
    ],
  },
  script: String.raw`
phase('Research')
log('Dispatching ' + args.questions.length + ' evidence requests')

const findingSchema = {
  type: 'object',
  properties: {
    question: { type: 'string' },
    answer: { type: 'string' },
    evidence: { type: 'array', items: { type: 'string' } },
    uncertainty: { type: 'string' },
  },
  required: ['question', 'answer', 'evidence', 'uncertainty'],
  additionalProperties: false,
}

const reviewSchema = {
  type: 'object',
  properties: {
    accepted: { type: 'boolean' },
    concern: { type: 'string' },
    correction: { type: 'string' },
  },
  required: ['accepted', 'concern', 'correction'],
  additionalProperties: false,
}

const reviewed = await pipeline(
  args.questions,
  async (question, original, index) => agent(
    'Research question ' + (index + 1) + ' about ' + args.topic + ': ' + question
      + '\nReturn concrete evidence and state uncertainty explicitly.',
    { label: 'Evidence: ' + question, phase: 'Research', schema: findingSchema },
  ),
  async finding => {
    if (finding === null) return null
    const review = await agent(
      'Audit this finding for unsupported claims and missing threat assumptions:\n'
        + JSON.stringify(finding),
      { label: 'Challenge evidence', phase: 'Review', schema: reviewSchema },
    )
    return review === null ? null : { finding, review }
  },
)

phase('Review')
const usable = reviewed.filter(Boolean)
const perspectives = await parallel([
  () => agent(
    'List the strongest security argument in this evidence:\n' + JSON.stringify(usable),
    { label: 'Security perspective', phase: 'Review' },
  ),
  () => agent(
    'List the strongest operability concern in this evidence:\n' + JSON.stringify(usable),
    { label: 'Operations perspective', phase: 'Review' },
  ),
])

phase('Synthesis')
const summary = await agent(
  'Write a concise report for ' + args.audience + ' on ' + args.topic + '.\n'
    + 'Reviewed evidence:\n' + JSON.stringify(usable) + '\n'
    + 'Independent perspectives:\n' + JSON.stringify(perspectives.filter(Boolean)),
  { label: 'Final synthesis', phase: 'Synthesis' },
)

return {
  topic: args.topic,
  findings: usable,
  perspectives: perspectives.filter(Boolean),
  summary,
}
`,
})

export default request
