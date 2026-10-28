import { Buffer } from 'node:buffer'
import { createHash, createHmac, pbkdf2Sync, randomBytes, timingSafeEqual } from 'node:crypto'

const encoder = new TextEncoder()
const decoder = new TextDecoder()
const hash = (value: Uint8Array | string) => createHash('sha256').update(value).digest()
const hmac = (key: Uint8Array, value: Uint8Array | string) => createHmac('sha256', key).update(value).digest()

function closeConnection(connection: Deno.Conn): void {
  try {
    connection.close()
  } catch (error) {
    if (!(error instanceof Deno.errors.BadResource)) throw error
  }
}

async function connect(hostname: string, port: number): Promise<Deno.Conn> {
  const signal = AbortSignal.timeout(10_000)
  const error = new Error('PostgreSQL connection timed out after 10 s')
  let expire: () => void = () => {}
  const deadline = new Promise<never>((_, reject) => {
    expire = () => reject(error)
    signal.addEventListener('abort', expire, { once: true })
  })
  try {
    return await Promise.race([Deno.connect({ hostname, port }).then(connection => {
      if (signal.aborted) {
        try { closeConnection(connection) } catch { throw error }
        throw error
      }
      return connection
    }), deadline])
  } finally {
    signal.removeEventListener('abort', expire)
  }
}

export async function vacuumResponses(databaseUrl: string): Promise<void> {
  const url = new URL(databaseUrl)
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new Error('PostgreSQL URL required')
  const user = decodeURIComponent(url.username)
  const password = decodeURIComponent(url.password)
  const deadline = AbortSignal.timeout(20_000)
  let connection: Deno.Conn = await connect(url.hostname, Number(url.port || 5432))
  let closed = false
  let failed = false
  const close = () => {
    if (closed) return
    closed = true
    closeConnection(connection)
  }
  const expire = () => { try { close() } catch { return } }
  deadline.addEventListener('abort', expire, { once: true })
  const read = async (size: number) => {
    deadline.throwIfAborted()
    const bytes = new Uint8Array(size)
    let offset = 0
    while (offset < size) {
      const count = await connection.read(bytes.subarray(offset))
      if (count == null) throw new Error('PostgreSQL connection closed')
      offset += count
    }
    return bytes
  }
  const write = async (bytes: Uint8Array) => {
    deadline.throwIfAborted()
    let offset = 0
    while (offset < bytes.length) offset += await connection.write(bytes.subarray(offset))
  }
  const message = async (type: string, body: Uint8Array) => {
    const bytes = new Uint8Array(body.length + 5)
    bytes[0] = type.charCodeAt(0)
    new DataView(bytes.buffer).setInt32(1, body.length + 4)
    bytes.set(body, 5)
    await write(bytes)
  }
  try {
    if (url.searchParams.get('sslmode') !== 'disable') {
      await write(new Uint8Array([0, 0, 0, 8, 4, 210, 22, 47]))
      const response = (await read(1))[0]
      if (response === 83) connection = await Deno.startTls(connection as Deno.TcpConn, { hostname: url.hostname })
      else if (response !== 78 || ['require', 'verify-ca', 'verify-full'].includes(url.searchParams.get('sslmode') || '')) throw new Error('PostgreSQL TLS unavailable')
    }
    const parameters = encoder.encode(`user\0${user}\0database\0${decodeURIComponent(url.pathname.slice(1)) || 'postgres'}\0application_name\0pancake-work-maintenance\0\0`)
    const startup = new Uint8Array(parameters.length + 8)
    const startupView = new DataView(startup.buffer)
    startupView.setInt32(0, startup.length)
    startupView.setInt32(4, 196608)
    startup.set(parameters, 8)
    await write(startup)
    let clientFirst = ''
    let serverSignature = new Uint8Array()
    let querySent = false
    for (;;) {
      const header = await read(5)
      const length = new DataView(header.buffer).getInt32(1) - 4
      if (length < 0 || length > 16_777_216) throw new Error('Invalid PostgreSQL message')
      const body = await read(length)
      const type = String.fromCharCode(header[0])
      if (type === 'E') throw new Error('PostgreSQL maintenance failed: ' + decoder.decode(body).split('\0').find(field => field.startsWith('M'))?.slice(1))
      if (type === 'R') {
        const auth = new DataView(body.buffer).getInt32(0)
        if (auth === 3) await message('p', encoder.encode(password + '\0'))
        else if (auth === 5) {
          const first = createHash('md5').update(password + user).digest('hex')
          const result = createHash('md5').update(first).update(body.subarray(4)).digest('hex')
          await message('p', encoder.encode('md5' + result + '\0'))
        } else if (auth === 10) {
          if (!decoder.decode(body.subarray(4)).split('\0').includes('SCRAM-SHA-256')) throw new Error('Unsupported PostgreSQL SASL method')
          clientFirst = 'n=,r=' + randomBytes(24).toString('base64')
          const initial = encoder.encode('n,,' + clientFirst)
          const mechanism = encoder.encode('SCRAM-SHA-256\0')
          const response = new Uint8Array(mechanism.length + 4 + initial.length)
          response.set(mechanism)
          new DataView(response.buffer).setInt32(mechanism.length, initial.length)
          response.set(initial, mechanism.length + 4)
          await message('p', response)
        } else if (auth === 11) {
          const serverFirst = decoder.decode(body.subarray(4))
          const fields = Object.fromEntries(serverFirst.split(',').map(field => [field.slice(0, 1), field.slice(2)]))
          const iterations = Number(fields.i)
          if (!fields.r.startsWith(clientFirst.slice(5)) || fields.r.length <= clientFirst.slice(5).length || !Number.isInteger(iterations) || iterations < 1 || iterations > 1_000_000) throw new Error('Invalid PostgreSQL SCRAM challenge')
          const final = 'c=biws,r=' + fields.r
          const salted = pbkdf2Sync(password.normalize('NFKC'), Buffer.from(fields.s, 'base64'), iterations, 32, 'sha256')
          const clientKey = hmac(salted, 'Client Key')
          const transcript = clientFirst + ',' + serverFirst + ',' + final
          const signature = hmac(hash(clientKey), transcript)
          const proof = clientKey.map((value, index) => value ^ signature[index])
          serverSignature = hmac(hmac(salted, 'Server Key'), transcript)
          await message('p', encoder.encode(final + ',p=' + Buffer.from(proof).toString('base64')))
        } else if (auth === 12) {
          const signature = Buffer.from(decoder.decode(body.subarray(4)).slice(2), 'base64')
          if (signature.length !== serverSignature.length || !timingSafeEqual(signature, serverSignature)) throw new Error('Invalid PostgreSQL server signature')
        } else if (auth !== 0) throw new Error('Unsupported PostgreSQL authentication')
      }
      if (type === 'Z') {
        if (querySent) return
        await message('Q', encoder.encode('VACUUM (ANALYZE, INDEX_CLEANUP ON) net._http_response\0'))
        querySent = true
      }
    }
  } catch (error) {
    failed = true
    if (deadline.aborted) throw new Error('vacuum timed out after 20 s', { cause: error })
    throw error
  } finally {
    deadline.removeEventListener('abort', expire)
    try { close() } catch (error) { if (!failed) throw error }
  }
}
