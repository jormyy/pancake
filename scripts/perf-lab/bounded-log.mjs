import assert from 'node:assert/strict'
import process from 'node:process'
import { Buffer } from 'node:buffer'
import { appendFileSync as append, statSync, writeFileSync, readdirSync, readFileSync, unlinkSync } from 'node:fs'
import path from 'node:path'
import { appendFile as appendAsync } from 'node:fs/promises'

export const captureFileLimit = 1024 * 1024 * 1024

export function createBoundedAppender(maximum = captureFileLimit) {
  assert.ok(Number.isSafeInteger(maximum) && maximum > 0)
  const sizes = new Map()
  const write = (file, data, options) => {
    let size = sizes.get(file)
    if (size === undefined) {
      try { size = statSync(file).size }
      catch (error) { if (error.code !== 'ENOENT') throw error; size = 0 }
    }
    const next = size + Buffer.byteLength(data)
    assert.ok(next <= maximum, `Capture file limit exceeded: ${path.basename(file)} (${maximum} bytes)`)
    append(file, data, options)
    sizes.set(file, next)
  }
  write.reset = () => sizes.clear()
  return write
}

const bounded = createBoundedAppender()
const dropped = new Map()
export const resetCaptureLimits = () => { bounded.reset(); dropped.clear() }
export function appendFileSync(file, data, options) {
  if (process.env.PERF_LAB_ON_MINI !== '1') { append(file, data, options); return }
  try { bounded(file, data, options) }
  catch (error) {
    if (!error.message.startsWith('Capture file limit exceeded:')) throw error
    const status = dropped.get(file) ?? { critical: true, limited: true, maximum: captureFileLimit, discardedBytes: 0, droppedWrites: 0 }
    status.discardedBytes += Buffer.byteLength(data)
    status.droppedWrites++
    dropped.set(file, status)
    appendMetadata(file, status)
  }
}
export async function appendFile(file, data, options) {
  if (process.env.PERF_LAB_ON_MINI === '1') appendFileSync(file, data, options)
  else await appendAsync(file, data, options)
}

function appendMetadata(file, status) {
  writeFileSync(`${file}.limit.json`, `${JSON.stringify(status)}\n`, { mode: 0o600 })
}

export function captureProcessOutput(child, file, maximum = 64 * 1024 * 1024) {
  const append = createBoundedAppender(maximum)
  let discardedBytes = 0, limited = false, error
  const write = bytes => {
    if (limited || error) { discardedBytes += bytes.length; return }
    try { append(file, bytes, { mode: 0o600 }) }
    catch (value) {
      discardedBytes += bytes.length
      if (value.message.startsWith('Capture file limit exceeded:')) limited = true
      else error = value
    }
  }
  child.stdout.on('data', write)
  child.stderr.on('data', write)
  return {
    close() {
      child.stdout.off('data', write)
      child.stderr.off('data', write)
      const status = { maximum, limited, discardedBytes }
      appendMetadata(file, status)
      if (error) throw error
      return status
    },
  }
}

export function captureConsole(maximum = 64 * 1024 * 1024, streams = [process.stdout, process.stderr]) {
  let bytes = 0, discardedBytes = 0
  const original = streams.map(stream => stream.write)
  streams.forEach((stream, index) => {
    Reflect.set(stream, 'write', function(chunk, encoding, callback) {
      const size = Buffer.byteLength(chunk, typeof encoding === 'string' ? encoding : undefined)
      if (discardedBytes || bytes + size > maximum) {
        discardedBytes += size
        const complete = typeof encoding === 'function' ? encoding : callback
        queueMicrotask(() => complete?.())
        return true
      }
      bytes += size
      return original[index].call(this, chunk, encoding, callback)
    })
  })
  return {
    close() {
      streams.forEach((stream, index) => { stream.write = original[index] })
      return { maximum, bytes, discardedBytes, limited: discardedBytes > 0 }
    },
  }
}


export function captureLimitMarkers(directories, clear = false) {
  const records = []
  for (const directory of directories) {
    let files
    try { files = readdirSync(directory) }
    catch (error) { if (error.code === 'ENOENT') continue; throw error }
    for (const name of files.filter(name => name.endsWith('.limit.json'))) {
      const file = path.join(directory, name)
      const record = JSON.parse(readFileSync(file, 'utf8'))
      if (record.critical !== true) continue
      if (clear) unlinkSync(file)
      else records.push({ file, ...record })
    }
  }
  return records
}
