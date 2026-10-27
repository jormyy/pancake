import { json, readJsonObject, requireOwnMember, requireUser, throwDb, uuidField, ValidationError } from '../../_shared/apiRuntime.ts'
import { supabase } from '../../_shared/supabase.ts'

const screens = new Set('matchup roster players league trades profile draft player draft-room rookie-draft-room lineup team-roster bracket claim-player propose-trade commissioner-settings notification-settings change-password create-league join-league'.split(' '))
const keys = 'screen useful_ms request_count transfer_bytes bytes_complete cold device_class connection_type app_version sample_n'.split(' ')

export function validateBeacon(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ValidationError('Invalid beacon')
  const row = value as Record<string, unknown>
  if (Object.keys(row).length !== keys.length || Object.keys(row).some(key => !keys.includes(key))) throw new ValidationError('Invalid beacon fields')
  const number = (key: string, maximum: number, minimum = 0) => {
    const n = row[key]
    if (typeof n !== 'number' || !Number.isInteger(n) || n < minimum || n > maximum) throw new ValidationError(`Invalid ${key}`)
    return n
  }
  const choice = (key: string, values: Set<string>) => {
    const text = row[key]
    if (typeof text !== 'string' || !values.has(text)) throw new ValidationError(`Invalid ${key}`)
    return text
  }
  if (typeof row.cold !== 'boolean' || typeof row.bytes_complete !== 'boolean') throw new ValidationError('Invalid boolean')
  if (typeof row.app_version !== 'string' || !/^[a-zA-Z0-9.+_-]{1,40}$/.test(row.app_version)) throw new ValidationError('Invalid app_version')
  return {
    screen: choice('screen', screens), useful_ms: number('useful_ms', 120_000), request_count: number('request_count', 10_000),
    transfer_bytes: number('transfer_bytes', 1_000_000_000), bytes_complete: row.bytes_complete, cold: row.cold,
    device_class: choice('device_class', new Set(['phone', 'tablet', 'desktop'])),
    connection_type: choice('connection_type', new Set(['slow-2g', '2g', '3g', '4g', 'unknown'])),
    app_version: row.app_version, sample_n: number('sample_n', 10_000, 1),
  }
}

async function boundedBody(req: Request) {
  if (!req.headers.get('content-type')?.toLowerCase().startsWith('application/json')) throw new ValidationError('Expected JSON')
  const reader = req.body?.getReader()
  if (!reader) throw new ValidationError('Missing body')
  const chunks: Uint8Array<ArrayBuffer>[] = []
  let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > 8192) { await reader.cancel(); throw new ValidationError('Beacon body exceeds 8 KB') }
      chunks.push(new Uint8Array(value))
    }
  } finally { reader.releaseLock() }
  return readJsonObject(new Request(req.url, { method: 'POST', body: new Blob(chunks) }))
}

export async function handleBeaconRoute(req: Request, path: string): Promise<Response | null> {
  if (path !== '/beacons') return null
  if (req.method !== 'POST') return json({ ok: false, error: 'Method not allowed' }, 405)
  const userId = await requireUser(req)
  const body = await boundedBody(req)
  if (Object.keys(body).some(key => key !== 'member_id' && key !== 'beacons')) throw new ValidationError('Invalid body fields')
  const memberId = uuidField(body, 'member_id')
  await requireOwnMember(userId, memberId)
  if (!Array.isArray(body.beacons) || body.beacons.length < 1 || body.beacons.length > 20) throw new ValidationError('Expected 1 to 20 beacons')
  const rows = body.beacons.map(value => ({ ...validateBeacon(value), member_id: memberId }))
  const { error } = await supabase.from('perf_beacons').insert(rows)
  if (error) throwDb(error)
  return json({ ok: true }, 202)
}
