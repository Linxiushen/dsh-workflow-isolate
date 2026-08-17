const MAX_DEPTH = 100

export class JsonBoundaryError extends TypeError {
  constructor(message: string) {
    super(message)
    this.name = 'JsonBoundaryError'
  }
}

function cloneValue(value: unknown, path: string, depth: number, seen: WeakSet<object>): unknown {
  if (depth > MAX_DEPTH) throw new JsonBoundaryError(`${path} exceeds the maximum JSON depth (${MAX_DEPTH})`)
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new JsonBoundaryError(`${path} contains a non-finite number`)
    return value
  }
  if (typeof value !== 'object') throw new JsonBoundaryError(`${path} contains ${typeof value}, which is not JSON data`)

  if (seen.has(value)) throw new JsonBoundaryError(`${path} contains a cycle`)
  seen.add(value)
  try {
    if (Array.isArray(value)) {
      const output: unknown[] = []
      for (const key of Reflect.ownKeys(value)) {
        if (typeof key === 'symbol') throw new JsonBoundaryError(`${path} contains a symbol-keyed property`)
        if (key === 'length') continue
        const index = Number(key)
        if (!Number.isSafeInteger(index) || index < 0 || String(index) !== key || index >= value.length) {
          throw new JsonBoundaryError(`${path} contains non-index property ${JSON.stringify(key)}`)
        }
      }
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, index)
        if (descriptor === undefined) throw new JsonBoundaryError(`${path}[${index}] is a sparse array slot`)
        if (!('value' in descriptor)) throw new JsonBoundaryError(`${path}[${index}] is an accessor property`)
        output.push(cloneValue(descriptor.value, `${path}[${index}]`, depth + 1, seen))
      }
      return output
    }

    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) {
      throw new JsonBoundaryError(`${path} has a non-plain prototype`)
    }
    const output: Record<string, unknown> = {}
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key === 'symbol') throw new JsonBoundaryError(`${path} contains a symbol-keyed property`)
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (descriptor === undefined) throw new JsonBoundaryError(`${path}.${key} could not be inspected`)
      if (!descriptor.enumerable) throw new JsonBoundaryError(`${path}.${key} is non-enumerable`)
      if (!('value' in descriptor)) throw new JsonBoundaryError(`${path}.${key} is an accessor property`)
      Object.defineProperty(output, key, {
        configurable: true,
        enumerable: true,
        value: cloneValue(descriptor.value, `${path}.${key}`, depth + 1, seen),
        writable: true,
      })
    }
    return output
  } finally {
    seen.delete(value)
  }
}

export function snapshotJson(value: unknown, label = 'value'): unknown {
  return cloneValue(value, label, 0, new WeakSet())
}

export function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8')
}

export function renderThrown(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`
  try {
    return String(error)
  } catch {
    return '[unrenderable thrown value]'
  }
}

export function assistantText(blocks: readonly unknown[]): string {
  const parts: string[] = []
  for (const block of blocks) {
    if (typeof block !== 'object' || block === null) continue
    const record = block as Record<string, unknown>
    if (record.type === 'text' && typeof record.text === 'string') parts.push(record.text)
  }
  return parts.join('')
}
