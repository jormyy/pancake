import { supabase } from './supabase.ts'
import { errorMessage } from './responses.ts'

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': [
    'authorization',
    'apikey',
    'content-type',
    'x-client-info',
    'x-e2e-secret',
    'x-internal-function-token',
  ].join(', '),
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Max-Age': '86400',
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

class ApiError extends Error {
  status: number

  constructor(message: string, status = 500) {
    super(message)
    this.status = status
  }
}

export class ValidationError extends ApiError {
  constructor(message: string) {
    super(message, 400)
  }
}

export class NotFoundError extends ApiError {
  constructor(message = 'Not found') {
    super(message, 404)
  }
}

export class ServiceUnavailableError extends ApiError {
  constructor(message: string) {
    super(message, 503)
  }
}

export function withCors(response: Response): Response {
  const headers = new Headers(response.headers)
  for (const [key, value] of Object.entries(CORS_HEADERS)) headers.set(key, value)
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}

export function json(data: unknown, status = 200): Response {
  return withCors(Response.json(data, { status }))
}

function noContent(): Response {
  return withCors(new Response(null, { status: 204 }))
}

export function routePath(req: Request): string {
  const path = new URL(req.url).pathname.replace(/\/+$/, '') || '/'
  for (const prefix of ['/functions/v1/api', '/api']) {
    if (path === prefix) return '/'
    if (path.startsWith(`${prefix}/`)) return path.slice(prefix.length)
  }
  return path
}

export async function handleApiRequest(
  req: Request,
  scope: string,
  fn: () => Promise<Response>,
): Promise<Response> {
  if (req.method === 'OPTIONS') return noContent()

  try {
    return await fn()
  } catch (error) {
    return errorResponse(scope, error)
  }
}

function errorResponse(scope: string, error: unknown): Response {
  const status = error instanceof ApiError ? error.status : dbErrorStatus(error)
  const requestId = crypto.randomUUID()

  if (status >= 500) {
    console.error(`[${scope}]`, { requestId, error })
  }

  return json({
    ok: false,
    error: status >= 500 ? 'Internal server error' : errorMessage(error),
    requestId,
  }, status)
}

function dbErrorStatus(error: unknown): number {
  if (!error || typeof error !== 'object') return 500
  const code = (error as { code?: unknown }).code
  if (code === '42501') return 403
  if (code === 'P0002' || code === 'PGRST116') return 404
  if (code === 'P0001' || code === '23505' || code === '23514' || code === '22003' || code === '22023') return 400
  return 500
}

export function throwDb(error: unknown): never {
  throw new ApiError(errorMessage(error), dbErrorStatus(error))
}

const MAX_JSON_BODY_BYTES = 64 * 1024

export async function readJsonObject(req: Request): Promise<Record<string, unknown>> {
  const declaredLength = Number(req.headers.get('content-length'))
  if (Number.isFinite(declaredLength) && declaredLength > MAX_JSON_BODY_BYTES) {
    throw new ValidationError('Request body must not exceed 64 KB')
  }
  const text = await req.text()
  if (new TextEncoder().encode(text).byteLength > MAX_JSON_BODY_BYTES) {
    throw new ValidationError('Request body must not exceed 64 KB')
  }
  if (!text.trim()) return {}

  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw new ValidationError('Request body must be valid JSON')
  }

  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ValidationError('Request body must be a JSON object')
  }
  return value as Record<string, unknown>
}

export function stringField(body: Record<string, unknown>, key: string): string {
  const value = body[key]
  if (typeof value !== 'string' || !value.trim()) throw new ValidationError(`${key} is required`)
  return value
}

export function optionalStringField(
  body: Record<string, unknown>,
  key: string,
  { maxLength }: { maxLength?: number } = {},
): string | null {
  const value = body[key]
  if (value == null || value === '') return null
  if (typeof value !== 'string') throw new ValidationError(`${key} must be a string`)
  if (maxLength != null && value.length > maxLength) {
    throw new ValidationError(`${key} must contain at most ${maxLength} characters`)
  }
  return value
}

export function uuidField(body: Record<string, unknown>, key: string): string {
  const value = stringField(body, key)
  assertUuid(value, key)
  return value
}

export function optionalUuidField(body: Record<string, unknown>, key: string): string | null {
  const value = optionalStringField(body, key)
  if (value == null) return null
  assertUuid(value, key)
  return value
}

export function booleanField(body: Record<string, unknown>, key: string): boolean {
  const value = body[key]
  if (typeof value !== 'boolean') throw new ValidationError(`${key} must be a boolean`)
  return value
}

export function optionalBooleanField(body: Record<string, unknown>, key: string): boolean | null {
  const value = body[key]
  if (value == null) return null
  return booleanField(body, key)
}

export function integerField(
  body: Record<string, unknown>,
  key: string,
  { min, max }: { min?: number; max?: number } = {},
): number {
  const value = body[key]
  if (!Number.isInteger(value)) throw new ValidationError(`${key} must be an integer`)
  const n = value as number
  if (min != null && n < min) throw new ValidationError(`${key} must be at least ${min}`)
  if (max != null && n > max) throw new ValidationError(`${key} must be at most ${max}`)
  return n
}

export function optionalIntegerField(
  body: Record<string, unknown>,
  key: string,
  { min, max }: { min?: number; max?: number } = {},
): number | null {
  const value = body[key]
  if (value == null) return null
  return integerField(body, key, { min, max })
}

function uuidArrayField(body: Record<string, unknown>, key: string): string[] {
  const value = body[key]
  if (!Array.isArray(value)) throw new ValidationError(`${key} must be an array`)
  if (value.length > 50) throw new ValidationError(`${key} must contain at most 50 items`)
  return value.map((item, index) => {
    if (typeof item !== 'string') throw new ValidationError(`${key}[${index}] must be a string`)
    assertUuid(item, `${key}[${index}]`)
    return item
  })
}

export function optionalUuidArrayField(body: Record<string, unknown>, key: string): string[] {
  const value = body[key]
  if (value == null) return []
  return uuidArrayField(body, key)
}

export function assertUuid(value: string, label = 'id'): void {
  if (!UUID_RE.test(value)) throw new ValidationError(`${label} must be a UUID`)
}

export async function requireUser(req: Request): Promise<string> {
  const header = req.headers.get('authorization')
  if (!header?.startsWith('Bearer ')) {
    throw new ApiError('Missing or invalid Authorization header', 401)
  }

  const token = header.slice('Bearer '.length).trim()
  if (!token) throw new ApiError('Missing or invalid Authorization header', 401)

  const { data, error } = await supabase.auth.getUser(token)
  if (error || !data.user) throw new ApiError('Invalid or expired token', 401)
  return data.user.id
}

export async function requireOwnMember(
  userId: string,
  memberId: string,
): Promise<{ leagueId: string }> {
  const { data, error } = await supabase
    .from('league_members')
    .select('league_id')
    .eq('id', memberId)
    .eq('user_id', userId)
    .maybeSingle()

  if (error) throwDb(error)
  if (!data) throw new NotFoundError('Member not found')
  return { leagueId: data.league_id }
}

export async function verifyOwnMember(userId: string, memberId: string): Promise<void> {
  await requireOwnMember(userId, memberId)
}

export async function requireCommissioner(userId: string, leagueId: string): Promise<void> {
  const { data, error } = await supabase
    .from('league_members')
    .select('role')
    .eq('league_id', leagueId)
    .eq('user_id', userId)
    .maybeSingle()

  if (error) throwDb(error)
  if (!data) throw new ApiError('Not authorized for this league', 403)
  if (data.role !== 'commissioner' && data.role !== 'co_commissioner') {
    throw new ApiError('Commissioner access required', 403)
  }
}

export async function requireCommissionerForDraft(userId: string, draftId: string): Promise<void> {
  const { data: commissionerRows, error: commissionerError } = await supabase
    .from('league_members')
    .select('league_id')
    .eq('user_id', userId)
    .in('role', ['commissioner', 'co_commissioner'])

  if (commissionerError) throwDb(commissionerError)

  const commissionerLeagueIds = (commissionerRows ?? []).map((row) => row.league_id)
  if (commissionerLeagueIds.length === 0) throw new NotFoundError('Draft not found')

  const { data, error } = await supabase
    .from('drafts')
    .select('id')
    .eq('id', draftId)
    .in('league_id', commissionerLeagueIds)
    .maybeSingle()

  if (error) throwDb(error)
  if (!data) throw new NotFoundError('Draft not found')
}

function adminUserIds(): string[] {
  return (Deno.env.get('ADMIN_USER_IDS') ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
}

export function requireAdmin(userId: string): void {
  const allowlist = adminUserIds()
  if (allowlist.length === 0) throw new ApiError('Admin access not configured', 503)
  if (!allowlist.includes(userId)) throw new ApiError('Admin access required', 403)
}

export function isAdmin(userId: string): boolean {
  return adminUserIds().includes(userId)
}

export function requireE2eSecret(req: Request): void {
  const expected = Deno.env.get('E2E_ADMIN_SECRET')
  if (!expected || req.headers.get('x-e2e-secret') !== expected) {
    throw new ApiError('Missing or invalid E2E admin secret', 401)
  }
}

function internalToken(): string {
  const token = Deno.env.get('PANCAKE_EDGE_INTERNAL_TOKEN') ?? Deno.env.get('EDGE_FUNCTION_INTERNAL_TOKEN')
  if (!token) throw new ApiError('Internal function authorization is not configured', 500)
  return token
}

function defaultSecretKey(): string | undefined {
  const raw = Deno.env.get('SUPABASE_SECRET_KEYS')
  if (!raw) return undefined

  try {
    const keys = JSON.parse(raw) as Record<string, string | undefined>
    return keys.default
  } catch {
    return undefined
  }
}

function serviceKey(): string | null {
  return Deno.env.get('PANCAKE_SUPABASE_SECRET_KEY') ??
    Deno.env.get('SUPABASE_SECRET_KEY') ??
    defaultSecretKey() ??
    null
}

export async function invokeInternalFunction(
  functionName: string,
  body: Record<string, unknown> = {},
  options: { method?: 'GET' | 'POST'; query?: Record<string, string | number | null | undefined> } = {},
): Promise<unknown> {
  const baseUrl = Deno.env.get('SUPABASE_URL')
  if (!baseUrl) throw new ApiError('SUPABASE_URL is not configured', 500)

  const url = new URL(`/functions/v1/${functionName}`, baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`)
  for (const [key, value] of Object.entries(options.query ?? {})) {
    if (value != null) url.searchParams.set(key, String(value))
  }

  const method = options.method ?? 'POST'
  const key = serviceKey()
  const response = await fetch(url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'x-internal-function-token': internalToken(),
      ...(key ? { Authorization: `Bearer ${key}`, apikey: key } : {}),
    },
    body: method === 'POST' ? JSON.stringify(body) : undefined,
  })

  const text = await response.text()
  let payload: unknown = null
  if (text.trim()) {
    try {
      payload = JSON.parse(text)
    } catch {
      payload = { ok: false, error: text }
    }
  }

  if (!response.ok || (payload && typeof payload === 'object' && (payload as { ok?: unknown }).ok === false)) {
    const message = payload && typeof payload === 'object' && 'error' in payload
      ? String((payload as { error?: unknown }).error ?? 'Internal function failed')
      : `Internal function ${functionName} failed`
    throw new ApiError(message, response.status >= 400 ? response.status : 500)
  }

  return payload ?? { ok: true }
}
