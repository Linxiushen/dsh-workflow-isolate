import { describe, expect, it } from 'vitest'
import { WorkflowError } from '@deepseek-ai/dsh-workflow'
import { assistantText, JsonBoundaryError, snapshotJson } from '../../src/json.ts'
import { validateMeta } from '../../src/meta.ts'

describe('snapshotJson', () => {
  it('creates a detached JSON snapshot', () => {
    const input = { nested: { value: 1 }, list: ['a', true, null] }
    const output = snapshotJson(input) as Record<string, unknown>

    expect(output).toEqual(input)
    expect(output).not.toBe(input)
    expect(output.nested).not.toBe(input.nested)
    expect(Object.getPrototypeOf(output)).toBe(Object.prototype)
    expect(Object.getPrototypeOf(output.nested as object)).toBe(Object.prototype)

    input.nested.value = 2
    expect(output).toEqual({ nested: { value: 1 }, list: ['a', true, null] })
  })

  it('preserves __proto__ as data without polluting host prototypes', () => {
    const input = JSON.parse('{"__proto__":{"polluted":true},"ok":1}') as unknown
    const output = snapshotJson(input) as Record<string, unknown>

    expect(Object.prototype.hasOwnProperty.call(output, '__proto__')).toBe(true)
    expect(Object.getPrototypeOf(output)).toBe(Object.prototype)
    expect((output.__proto__ as Record<string, unknown>).polluted).toBe(true)
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })

  it.each([
    ['non-finite number', { value: Number.NaN }],
    ['function', { value: () => undefined }],
    ['bigint', { value: 1n }],
    ['special prototype', new Date(0)],
  ])('rejects %s', (_label, value) => {
    expect(() => snapshotJson(value)).toThrow(JsonBoundaryError)
  })

  it('rejects cycles and sparse arrays', () => {
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    const sparse: unknown[] = []
    sparse.length = 2
    sparse[1] = 'present'

    expect(() => snapshotJson(cyclic)).toThrow(/cycle/)
    expect(() => snapshotJson(sparse)).toThrow(/sparse/)
  })

  it('rejects accessors and non-JSON own keys without invoking getters', () => {
    let reads = 0
    const accessor = Object.defineProperty({}, 'secret', {
      enumerable: true,
      get() {
        reads += 1
        return 'leaked'
      },
    })
    const symbolKeyed = { [Symbol('hidden')]: true }
    const arrayWithExtra = [1] as unknown[] & { extra?: string }
    arrayWithExtra.extra = 'not JSON array data'

    expect(() => snapshotJson(accessor)).toThrow(/accessor/)
    expect(reads).toBe(0)
    expect(() => snapshotJson(symbolKeyed)).toThrow(/symbol-keyed/)
    expect(() => snapshotJson(arrayWithExtra)).toThrow(/non-index property/)
  })
})

describe('assistantText', () => {
  it('concatenates DSH text blocks without adding separators', () => {
    expect(assistantText([
      { type: 'text', text: 'streamed ' },
      { type: 'tool-call', name: 'ignored' },
      { type: 'text', text: 'output' },
    ])).toBe('streamed output')
  })
})

describe('validateMeta', () => {
  it('copies the complete supported shape', () => {
    const input = {
      name: 'repo-audit',
      description: 'Audit a repository with isolated workers',
      whenToUse: 'When changes cross multiple modules',
      phases: [{ title: 'Inspect', detail: 'Map the code', provider: 'deepseek', model: 'deepseek-v4-pro' }],
    }
    const output = validateMeta(input)

    expect(output).toEqual(input)
    expect(output).not.toBe(input)
    expect(output.phases).not.toBe(input.phases)
    expect(output.phases?.[0]).not.toBe(input.phases[0])
  })

  it.each([
    [null, 'workflow meta must be an object'],
    [{ name: 'x', description: 'd', extra: true }, 'unknown field'],
    [{ name: '', description: 'd' }, 'non-empty string'],
    [{ name: 'x', description: 'd', phases: [{ title: '' }] }, 'non-empty string'],
  ])('rejects invalid metadata %#', (input, message) => {
    let thrown: unknown
    try {
      validateMeta(input)
    } catch (error: unknown) {
      thrown = error
    }

    expect(thrown).toBeInstanceOf(WorkflowError)
    expect((thrown as WorkflowError).code).toBe('META_INVALID')
    expect((thrown as WorkflowError).message).toContain(message)
  })

  it('preserves rc.7-compatible whitespace and empty optional strings', () => {
    expect(validateMeta({
      name: ' repo-audit ',
      description: ' Audit a repository ',
      whenToUse: '',
      phases: [{ title: ' Inspect ', detail: '', provider: '', model: '' }],
    })).toEqual({
      name: ' repo-audit ',
      description: ' Audit a repository ',
      whenToUse: '',
      phases: [{ title: ' Inspect ', detail: '', provider: '', model: '' }],
    })
  })
})
