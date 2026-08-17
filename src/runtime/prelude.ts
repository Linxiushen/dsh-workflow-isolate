export function workflowPrelude(maxItemsPerCall: number): string {
  return `
(() => {
  'use strict'

  // Capture every intrinsic used by the bridge before workflow code can
  // replace globals or mutate prototypes.
  const ErrorCtor = Error
  const PromiseCtor = Promise
  const WeakSetCtor = WeakSet
  const arrayIsArray = Array.isArray
  const jsonParse = JSON.parse
  const jsonStringify = JSON.stringify
  const numberIsFinite = Number.isFinite
  const numberIsSafeInteger = Number.isSafeInteger
  const objectCreate = Object.create
  const objectDefineProperty = Object.defineProperty
  const objectFreeze = Object.freeze
  const objectGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor
  const objectGetPrototypeOf = Object.getPrototypeOf
  const objectHasOwn = Object.hasOwn
  const objectPrototype = Object.prototype
  const objectSetPrototypeOf = Object.setPrototypeOf
  const promiseCatch = Function.prototype.call.bind(PromiseCtor.prototype.catch)
  const promiseThen = Function.prototype.call.bind(PromiseCtor.prototype.then)
  const reflectOwnKeys = Reflect.ownKeys
  const stringFrom = String
  const weakSetAdd = Function.prototype.call.bind(WeakSet.prototype.add)
  const weakSetDelete = Function.prototype.call.bind(WeakSet.prototype.delete)
  const weakSetHas = Function.prototype.call.bind(WeakSet.prototype.has)

  const allTasks = (tasks) => new PromiseCtor((resolve, reject) => {
    const results = []
    let remaining = tasks.length
    if (remaining === 0) {
      resolve(results)
      return
    }
    for (let index = 0; index < tasks.length; index += 1) {
      promiseThen(tasks[index], (value) => {
        results[index] = value
        remaining -= 1
        if (remaining === 0) resolve(results)
      }, reject)
    }
  })

  const rawAgent = globalThis.__dshAgent
  const rawPhase = globalThis.__dshPhase
  const rawLog = globalThis.__dshLog
  delete globalThis.__dshAgent
  delete globalThis.__dshPhase
  delete globalThis.__dshLog

  const fatalErrors = new WeakSetCtor()
  const fatal = (message, code) => {
    const error = new ErrorCtor(message)
    objectDefineProperty(error, 'name', { value: 'WorkflowError' })
    objectDefineProperty(error, 'code', { value: code, enumerable: true })
    weakSetAdd(fatalErrors, error)
    return error
  }
  objectDefineProperty(globalThis, '__dshFatalFactory', {
    configurable: true,
    value: fatal,
  })

  const fail = (message, code = 'INVALID_ARGUMENT') => { throw fatal(message, code) }
  const copyJson = (value, path = 'value', depth = 0, seen = new WeakSetCtor()) => {
    if (depth > 100) fail(path + ' exceeds the maximum JSON depth')
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
    if (typeof value === 'number') {
      if (!numberIsFinite(value)) fail(path + ' contains a non-finite number')
      return value
    }
    if (typeof value !== 'object') fail(path + ' contains non-JSON data')
    if (weakSetHas(seen, value)) fail(path + ' contains a cycle')
    weakSetAdd(seen, value)
    try {
      if (arrayIsArray(value)) {
        const length = value.length
        const output = []
        objectSetPrototypeOf(output, null)
        const keys = reflectOwnKeys(value)
        for (let keyIndex = 0; keyIndex < keys.length; keyIndex += 1) {
          const key = keys[keyIndex]
          if (typeof key === 'symbol') fail(path + ' contains a symbol-keyed property')
          if (key === 'length') continue
          const numericKey = +key
          if (!numberIsSafeInteger(numericKey) || numericKey < 0 || stringFrom(numericKey) !== key || numericKey >= length) {
            fail(path + ' contains non-index property "' + key + '"')
          }
        }
        for (let index = 0; index < length; index += 1) {
          const descriptor = objectGetOwnPropertyDescriptor(value, index)
          if (descriptor === undefined) fail(path + '[' + index + '] is sparse')
          if (!objectHasOwn(descriptor, 'value')) fail(path + '[' + index + '] is an accessor property')
          output[index] = copyJson(descriptor.value, path + '[' + index + ']', depth + 1, seen)
        }
        return output
      }
      const prototype = objectGetPrototypeOf(value)
      if (prototype !== objectPrototype && prototype !== null) fail(path + ' must be a plain object')
      const output = objectCreate(null)
      const keys = reflectOwnKeys(value)
      for (let index = 0; index < keys.length; index += 1) {
        const key = keys[index]
        if (typeof key === 'symbol') fail(path + ' contains a symbol-keyed property')
        const descriptor = objectGetOwnPropertyDescriptor(value, key)
        if (descriptor === undefined) fail(path + '.' + key + ' could not be inspected')
        if (!descriptor.enumerable) fail(path + '.' + key + ' is non-enumerable')
        if (!objectHasOwn(descriptor, 'value')) fail(path + '.' + key + ' is an accessor property')
        objectDefineProperty(output, key, {
          configurable: true,
          enumerable: true,
          value: copyJson(descriptor.value, path + '.' + key, depth + 1, seen),
          writable: true,
        })
      }
      return output
    } finally {
      weakSetDelete(seen, value)
    }
  }

  const snapshotWorkflowResult = (value) => {
    try {
      return jsonStringify(copyJson(value, 'workflow result'))
    } catch (error) {
      if (weakSetHas(fatalErrors, error)) {
        throw fatal(error.message, 'RESULT_UNSERIALIZABLE')
      }
      throw error
    }
  }
  objectDefineProperty(globalThis, '__dshSnapshotFactory', {
    configurable: true,
    value: snapshotWorkflowResult,
  })
  objectDefineProperty(globalThis, '__dshJsonParser', {
    configurable: true,
    value: jsonParse,
  })
  objectDefineProperty(globalThis, '__dshPromiseObserver', {
    configurable: true,
    value: (promise, onFulfilled, onRejected) => promiseThen(promise, onFulfilled, onRejected),
  })

  let currentPhase
  const agent = (prompt, options) => {
    if (typeof prompt !== 'string' || prompt.length === 0) fail('agent() requires a non-empty prompt string')
    if (options === undefined) options = {}
    if (typeof options !== 'object' || options === null || arrayIsArray(options)) {
      fail('agent() options must be an object')
    }
    const safeOptions = copyJson(options, 'agent() options')
    const optionKeys = reflectOwnKeys(safeOptions)
    for (let index = 0; index < optionKeys.length; index += 1) {
      const key = optionKeys[index]
      if (key !== 'label' && key !== 'phase' && key !== 'schema' && key !== 'provider' && key !== 'model') {
        fail('agent() option "' + key + '" is not supported', 'UNSUPPORTED_OPTION')
      }
    }
    const stringOptions = ['label', 'phase', 'provider', 'model']
    for (let index = 0; index < stringOptions.length; index += 1) {
      const key = stringOptions[index]
      if (safeOptions[key] !== undefined && typeof safeOptions[key] !== 'string') {
        fail('agent() option "' + key + '" must be a string')
      }
    }
    const task = rawAgent(prompt, jsonStringify(safeOptions), currentPhase)
    promiseCatch(task, () => {})
    return task
  }

  const parallel = async (thunks) => {
    if (!arrayIsArray(thunks)) fail('parallel() requires an array of zero-argument functions')
    if (thunks.length > ${maxItemsPerCall}) fail('parallel() exceeds the per-call item cap (${maxItemsPerCall})', 'ITEM_CAP')
    const tasks = []
    for (let index = 0; index < thunks.length; index += 1) {
      const thunk = thunks[index]
      if (typeof thunk !== 'function') fail('parallel() item ' + index + ' is not a function')
      tasks[index] = (async () => {
        try {
          return await thunk()
        } catch (error) {
          if (weakSetHas(fatalErrors, error)) throw error
          return null
        }
      })()
    }
    return allTasks(tasks)
  }

  const pipeline = async (items, ...stages) => {
    if (!arrayIsArray(items)) fail('pipeline() requires an items array')
    if (items.length > ${maxItemsPerCall}) fail('pipeline() exceeds the per-call item cap (${maxItemsPerCall})', 'ITEM_CAP')
    if (stages.length === 0) fail('pipeline() requires at least one stage function')
    for (let index = 0; index < stages.length; index += 1) {
      if (typeof stages[index] !== 'function') fail('pipeline() stage ' + index + ' is not a function')
    }
    const tasks = []
    for (let index = 0; index < items.length; index += 1) {
      const item = items[index]
      tasks[index] = (async () => {
        let value = item
        try {
          for (let stageIndex = 0; stageIndex < stages.length; stageIndex += 1) {
            value = await stages[stageIndex](value, item, index)
          }
          return value
        } catch (error) {
          if (weakSetHas(fatalErrors, error)) throw error
          return null
        }
      })()
    }
    return allTasks(tasks)
  }

  const phase = (title) => {
    if (typeof title !== 'string' || title.length === 0) fail('phase() requires a non-empty title string')
    currentPhase = title
    rawPhase(title)
  }
  const log = (message) => {
    if (typeof message !== 'string') fail('log() requires a message string')
    rawLog(message)
  }

  const expose = (name, value) => {
    objectDefineProperty(globalThis, name, {
      configurable: false,
      enumerable: true,
      value: objectFreeze(value),
      writable: false,
    })
  }
  expose('agent', agent)
  expose('parallel', parallel)
  expose('pipeline', pipeline)
  expose('phase', phase)
  expose('log', log)
})()
`
}
