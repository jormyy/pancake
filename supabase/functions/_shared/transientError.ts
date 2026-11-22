export const TRANSIENT_SQLSTATES = new Set(['55P03', '40001', '40P01', '57014'])

export const TRANSIENT_HTTP_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504])

const TRANSIENT_POSTGREST_CODES = new Set(['PGRST003'])

const TRANSIENT_RESPONSE_STATUSES = new Set([408, 425, 429, 502, 503, 504])

export class TransientHttpError extends Error {
  httpStatus: number

  constructor(httpStatus: number, message: string) {
    super(message)
    this.name = 'TransientHttpError'
    this.httpStatus = httpStatus
  }
}

const TRANSIENT_TRANSPORT_CODES = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'ECONNABORTED', 'ETIMEDOUT', 'EPIPE', 'ENOTFOUND',
  'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH', 'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_SOCKET', 'UND_ERR_CLOSED',
  'UND_ERR_ABORTED',
])

const TRANSIENT_NAMES = new Set(['TimeoutError', 'AbortError'])

// Only the client's own transport prefix counts. A database or application
// message that happens to contain a word such as "terminated" must not be
// reclassified as a retryable transport failure.
const TRANSPORT_MESSAGE = /^(?:TypeError: )?(?:fetch failed|Failed to fetch|network error|socket hang up|other side closed|Headers Timeout Error|The operation was aborted|This operation was aborted|FetchError: TimeoutError:|TimeoutError:|AbortError:)/i

export function isTransientError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const record = error as { code?: unknown; name?: unknown; message?: unknown; cause?: unknown; httpStatus?: unknown }
  const code = typeof record.code === 'string' ? record.code : ''
  if (TRANSIENT_SQLSTATES.has(code) || TRANSIENT_POSTGREST_CODES.has(code)) return true
  if (typeof record.httpStatus === 'number' && TRANSIENT_HTTP_STATUSES.has(record.httpStatus)) return true
  if (typeof record.name === 'string' && TRANSIENT_NAMES.has(record.name)) return true
  if (!code && typeof record.message === 'string' && TRANSPORT_MESSAGE.test(record.message)) return true
  return causeIsTransient(record.cause)
}

export function transientRpcError(error: unknown, status?: number): unknown {
  if (typeof status !== 'number' || !TRANSIENT_RESPONSE_STATUSES.has(status)) return error
  const message = error && typeof error === 'object' && typeof (error as { message?: unknown }).message === 'string'
    ? (error as { message: string }).message
    : String(error)
  return new TransientHttpError(status, message)
}

function causeIsTransient(cause: unknown): boolean {
  if (!cause || typeof cause !== 'object') return false
  const record = cause as { code?: unknown; name?: unknown; message?: unknown; cause?: unknown }
  if (typeof record.code === 'string' && TRANSIENT_TRANSPORT_CODES.has(record.code)) return true
  if (typeof record.name === 'string' && TRANSIENT_NAMES.has(record.name)) return true
  if (typeof record.message === 'string' && TRANSPORT_MESSAGE.test(record.message)) return true
  return causeIsTransient(record.cause)
}
