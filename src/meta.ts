import { WorkflowError } from '@deepseek-ai/dsh-workflow'
import type { WorkflowMeta, WorkflowPhase } from '@deepseek-ai/dsh-workflow'

const META_FIELDS = new Set(['name', 'description', 'whenToUse', 'phases'])
const PHASE_FIELDS = new Set(['title', 'detail', 'provider', 'model'])

function stringField(value: unknown, path: string, required: boolean): string | undefined {
  if (value === undefined && !required) return undefined
  if (typeof value !== 'string' || (required && value.length === 0)) {
    throw new WorkflowError(`${path} must be ${required ? 'a non-empty string' : 'a string'}`, 'META_INVALID')
  }
  return value
}

function validatePhase(value: unknown, index: number): WorkflowPhase {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new WorkflowError(`meta.phases[${index}] must be an object`, 'META_INVALID')
  }
  const record = value as Record<string, unknown>
  for (const field of Object.keys(record)) {
    if (!PHASE_FIELDS.has(field)) throw new WorkflowError(`meta.phases[${index}] contains unknown field "${field}"`, 'META_INVALID')
  }
  const title = stringField(record.title, `meta.phases[${index}].title`, true) as string
  const detail = stringField(record.detail, `meta.phases[${index}].detail`, false)
  const provider = stringField(record.provider, `meta.phases[${index}].provider`, false)
  const model = stringField(record.model, `meta.phases[${index}].model`, false)
  return {
    title,
    ...(detail === undefined ? {} : { detail }),
    ...(provider === undefined ? {} : { provider }),
    ...(model === undefined ? {} : { model }),
  }
}

export function validateMeta(value: unknown): WorkflowMeta {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new WorkflowError('workflow meta must be an object', 'META_INVALID')
  }
  const record = value as Record<string, unknown>
  for (const field of Object.keys(record)) {
    if (!META_FIELDS.has(field)) throw new WorkflowError(`workflow meta contains unknown field "${field}"`, 'META_INVALID')
  }
  const name = stringField(record.name, 'meta.name', true) as string
  const description = stringField(record.description, 'meta.description', true) as string
  const whenToUse = stringField(record.whenToUse, 'meta.whenToUse', false)
  let phases: WorkflowPhase[] | undefined
  if (record.phases !== undefined) {
    if (!Array.isArray(record.phases)) throw new WorkflowError('meta.phases must be an array', 'META_INVALID')
    phases = record.phases.map(validatePhase)
  }
  return {
    name,
    description,
    ...(whenToUse === undefined ? {} : { whenToUse }),
    ...(phases === undefined ? {} : { phases }),
  }
}
