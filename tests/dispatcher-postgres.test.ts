import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const clientPath = '../supabase/functions/dispatcher/postgres.ts'
const { vacuumResponses } = await import(clientPath)
const databaseUrl = 'postgresql://postgres:local-test@127.0.0.1:58522/postgres?sslmode=disable'
const encoder = new TextEncoder()

class BadResource extends Error {
  name = 'BadResource'
}

function frame(type: string, body = new Uint8Array([73])) {
  const bytes = new Uint8Array(body.length + 5)
  bytes[0] = type.charCodeAt(0)
  new DataView(bytes.buffer).setInt32(1, body.length + 4)
  bytes.set(body, 5)
  return bytes
}

function fakeConnection({ failure, closeFailure, stall = false, alreadyClosed = false }: {
  failure?: Error
  closeFailure?: Error
  stall?: boolean
  alreadyClosed?: boolean
} = {}) {
  let closed = false
  let offset = 0
  let rejectRead: ((error: Error) => void) | undefined
  const ready = frame('Z')
  const result = failure ? frame('E', encoder.encode(`SERROR\0M${failure.message}\0\0`)) : frame('Z')
  const input = new Uint8Array([...ready, ...result])
  const writes: Uint8Array[] = []
  const close = vi.fn(() => {
    if (closed) throw new BadResource('Bad resource ID')
    closed = true
    rejectRead?.(new BadResource('Bad resource ID'))
    if (closeFailure) throw closeFailure
  })
  return {
    writes,
    close,
    read: vi.fn(async (bytes: Uint8Array) => {
      if (offset >= ready.length && stall) {
        return await new Promise<number>((_, reject) => { rejectRead = reject })
      }
      const count = Math.min(bytes.length, input.length - offset)
      bytes.set(input.subarray(offset, offset + count))
      offset += count
      if (alreadyClosed && offset === input.length) closed = true
      return count
    }),
    write: vi.fn(async (bytes: Uint8Array) => {
      writes.push(bytes.slice())
      return bytes.length
    }),
  }
}

let deadlines: Map<number, AbortController>

beforeEach(() => {
  vi.useFakeTimers()
  deadlines = new Map()
  vi.spyOn(AbortSignal, 'timeout').mockImplementation(ms => {
    const controller = new AbortController()
    deadlines.set(ms, controller)
    return controller.signal
  })
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

function useConnection(connection = fakeConnection()) {
  const connect = vi.fn().mockResolvedValue(connection)
  vi.stubGlobal('Deno', { connect, errors: { BadResource } })
  return connect
}

it('finishes the fixed VACUUM when the connection is already closed during cleanup', async () => {
  const connection = fakeConnection({ alreadyClosed: true })
  useConnection(connection)
  await expect(vacuumResponses(databaseUrl)).resolves.toBeUndefined()
  expect(new TextDecoder().decode(connection.writes[1].subarray(5))).toBe('VACUUM (ANALYZE, INDEX_CLEANUP ON) net._http_response\0')
})

it('preserves the server error when cleanup finds an already closed connection', async () => {
  useConnection(fakeConnection({ failure: new Error('canceling statement due to statement timeout'), alreadyClosed: true }))
  await expect(vacuumResponses(databaseUrl)).rejects.toThrow('PostgreSQL maintenance failed: canceling statement due to statement timeout')
})

it('preserves the body error when cleanup throws another error', async () => {
  useConnection(fakeConnection({ failure: new Error('permission denied'), closeFailure: new Error('cleanup failed') }))
  await expect(vacuumResponses(databaseUrl)).rejects.toThrow('PostgreSQL maintenance failed: permission denied')
})

it('reports unexpected cleanup failures after a successful body', async () => {
  useConnection(fakeConnection({ closeFailure: new Error('cleanup failed') }))
  await expect(vacuumResponses(databaseUrl)).rejects.toThrow('cleanup failed')
})

it('reports the real timeout and lets the next hourly invocation succeed', async () => {
  const connection = fakeConnection({ stall: true })
  const connect = useConnection(connection)
  const outcome = expect(vacuumResponses(databaseUrl)).rejects.toThrow('vacuum timed out after 20 s')
  await vi.advanceTimersByTimeAsync(20_000)
  expect(deadlines.has(20_000)).toBe(true)
  deadlines.get(20_000)!.abort()
  await outcome
  expect(connection.close).toHaveBeenCalledTimes(1)
  connect.mockResolvedValue(fakeConnection())
  await expect(vacuumResponses(databaseUrl)).resolves.toBeUndefined()
})

it('keeps the network deadline independent of accelerated business time', async () => {
  const connection = fakeConnection({ stall: true })
  useConnection(connection)
  let finished = false
  const result = vacuumResponses(databaseUrl).finally(() => { finished = true })
  const outcome = expect(result).rejects.toThrow('vacuum timed out after 20 s')
  await vi.advanceTimersByTimeAsync(3_600_000)
  expect(finished).toBe(false)
  expect(connection.close).not.toHaveBeenCalled()
  deadlines.get(20_000)!.abort()
  await outcome
})

it('rethrows the original read error even when close also fails', async () => {
  const connection = fakeConnection({ closeFailure: new Error('cleanup failed') })
  const original = new Error('connection reset by peer')
  connection.read.mockRejectedValueOnce(original)
  useConnection(connection)
  await expect(vacuumResponses(databaseUrl)).rejects.toBe(original)
})

it('reports a connection timeout and disposes of a late closed connection', async () => {
  let resolveConnection: (connection: ReturnType<typeof fakeConnection>) => void = () => {}
  const connect = vi.fn(() => new Promise(resolve => { resolveConnection = resolve }))
  vi.stubGlobal('Deno', { connect, errors: { BadResource } })
  const outcome = expect(vacuumResponses(databaseUrl)).rejects.toThrow('PostgreSQL connection timed out after 10 s')
  deadlines.get(10_000)!.abort()
  await outcome
  const connection = fakeConnection()
  connection.close()
  resolveConnection(connection)
  await vi.advanceTimersByTimeAsync(0)
  expect(connection.close).toHaveBeenCalledTimes(2)
})

it('removes the abort listener once the vacuum completes', async () => {
  const connection = fakeConnection()
  useConnection(connection)
  await vacuumResponses(databaseUrl)
  deadlines.get(20_000)!.abort()
  expect(connection.close).toHaveBeenCalledTimes(1)
})
