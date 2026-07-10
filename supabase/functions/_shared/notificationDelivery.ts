import { runBounded } from './runBounded.ts'

const PUSH_TIMEOUT_MS = 8000
const EXPO_BATCH_SIZE = 100
const EXPO_BATCH_CONCURRENCY = 2
const PERMANENT_EXPO_ERRORS = new Set(['DeviceNotRegistered', 'InvalidCredentials', 'MessageTooBig'])

type NotificationCategory = 'trade' | 'waiver' | 'draft' | 'activity'
type NotificationPreferenceColumn = 'trade_enabled' | 'waiver_enabled' | 'draft_enabled' | 'activity_enabled'
type NotificationPreferences = Record<NotificationPreferenceColumn, boolean>
type LookupError = { message: string; code?: string }
type LookupResult<Value> = { data: Value | null; error: LookupError | null }

export type NotificationDeliveryFailureCode =
  | 'member_lookup'
  | 'preferences_lookup'
  | 'profile_lookup'
  | 'expo_network'
  | 'expo_http'
  | 'expo_response'
  | 'expo_status'

type NotificationDeliveryResult =
  | { status: 'sent' }
  | { status: 'skipped'; reason: 'preferences_disabled' | 'missing_push_token' }

export type NotificationMessage = {
  memberId: string
  title: string
  body: string
  data?: Record<string, unknown>
  category?: NotificationCategory
}

type NotificationBatchResult = NotificationDeliveryResult & { memberId: string }

export class NotificationDeliveryError extends Error {
  readonly code: NotificationDeliveryFailureCode
  readonly memberId: string
  readonly userId: string | null
  readonly retryable: boolean
  readonly expoError: string | null

  constructor({
    code,
    message,
    memberId,
    userId = null,
    cause,
    retryable = true,
    expoError = null,
  }: {
    code: NotificationDeliveryFailureCode
    message: string
    memberId: string
    userId?: string | null
    cause?: unknown
    retryable?: boolean
    expoError?: string | null
  }) {
    super(message, { cause })
    this.name = 'NotificationDeliveryError'
    this.code = code
    this.memberId = memberId
    this.userId = userId
    this.retryable = retryable
    this.expoError = expoError
  }
}

class NotificationBatchDeliveryError extends Error {
  readonly code: NotificationDeliveryFailureCode
  readonly memberIds: string[]

  constructor({
    code,
    message,
    memberIds,
    cause,
  }: {
    code: NotificationDeliveryFailureCode
    message: string
    memberIds: string[]
    cause?: unknown
  }) {
    super(message, { cause })
    this.name = 'NotificationBatchDeliveryError'
    this.code = code
    this.memberIds = memberIds
  }
}

export type NotificationDependencies = {
  member: (memberId: string) => Promise<LookupResult<{ user_id: string }>>
  preferences: (userId: string) => Promise<LookupResult<NotificationPreferences>>
  profile: (userId: string) => Promise<LookupResult<{ push_token: string | null }>>
  send: (url: string, init: RequestInit) => Promise<Response>
  pushUrl: string
}

export type NotifyMember = (
  memberId: string,
  title: string,
  body: string,
  data?: Record<string, unknown>,
  category?: NotificationCategory,
) => Promise<NotificationDeliveryResult>

export type NotifyMembers = (messages: NotificationMessage[]) => Promise<NotificationBatchResult[]>

export type NotificationBatchDependencies = {
  members: (memberIds: string[]) => Promise<LookupResult<Array<{ id: string; user_id: string }>>>
  preferences: (userIds: string[]) => Promise<LookupResult<Array<NotificationPreferences & { user_id: string }>>>
  profiles: (userIds: string[]) => Promise<LookupResult<Array<{ id: string; push_token: string | null }>>>
  invalidateToken?: (userId: string, token: string) => Promise<LookupResult<boolean>>
  send: (url: string, init: RequestInit) => Promise<Response>
  pushUrl: string
}

export function isPermanentNotificationFailure(error: unknown): boolean {
  if (error instanceof NotificationDeliveryError) return !error.retryable
  return error instanceof AggregateError && error.errors.length > 0 &&
    error.errors.every((failure) => isPermanentNotificationFailure(failure))
}

const preferenceColumns: Record<NotificationCategory, NotificationPreferenceColumn> = {
  trade: 'trade_enabled',
  waiver: 'waiver_enabled',
  draft: 'draft_enabled',
  activity: 'activity_enabled',
}

const record = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : null

const lookupError = (
  code: Extract<NotificationDeliveryFailureCode, `${string}_lookup`>,
  error: LookupError | null,
  memberId: string,
  userId: string | null = null,
) => new NotificationDeliveryError({
  code,
  message: `${code.replace('_', ' ')} failed${error?.message ? `: ${error.message}` : ''}`,
  memberId,
  userId,
  cause: error,
})

const batchLookupError = (
  code: Extract<NotificationDeliveryFailureCode, `${string}_lookup`>,
  error: LookupError | null,
  memberIds: string[],
) => new NotificationBatchDeliveryError({
  code,
  message: `${code.replace('_', ' ')} failed${error?.message ? `: ${error.message}` : ''}`,
  memberIds,
  cause: error,
})

const chunks = <Value>(values: Value[], size: number): Value[][] => {
  const result: Value[][] = []
  for (let index = 0; index < values.length; index += size) result.push(values.slice(index, index + size))
  return result
}

type PreparedNotification = NotificationMessage & { userId: string; token: string }

const sendBatch = async (
  dependencies: NotificationBatchDependencies,
  messages: PreparedNotification[],
): Promise<void> => {
  const memberIds = messages.map((message) => message.memberId)
  let response: Response
  try {
    response = await dependencies.send(dependencies.pushUrl, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(messages.map((message) => ({
        to: message.token,
        title: message.title,
        body: message.body,
        data: message.data ?? {},
        sound: 'default',
      }))),
      signal: AbortSignal.timeout(PUSH_TIMEOUT_MS),
    })
  } catch (cause) {
    throw new NotificationBatchDeliveryError({
      code: 'expo_network',
      message: 'Expo push batch request failed.',
      memberIds,
      cause,
    })
  }

  let payload: unknown
  try {
    payload = await response.json()
  } catch (cause) {
    throw new NotificationBatchDeliveryError({
      code: response.ok ? 'expo_response' : 'expo_http',
      message: response.ok
        ? 'Expo push batch response was not valid JSON.'
        : `Expo push batch request returned HTTP ${response.status}.`,
      memberIds,
      cause,
    })
  }

  if (!response.ok) {
    throw new NotificationBatchDeliveryError({
      code: 'expo_http',
      message: `Expo push batch request returned HTTP ${response.status}.`,
      memberIds,
    })
  }

  const deliveries = record(payload)?.data
  if (!Array.isArray(deliveries) || deliveries.length !== messages.length) {
    throw new NotificationBatchDeliveryError({
      code: 'expo_response',
      message: 'Expo push batch response did not match the submitted messages.',
      memberIds,
    })
  }

  const failures: NotificationDeliveryError[] = []
  for (const [index, delivery] of deliveries.entries()) {
    const ticket = record(delivery)
    if (ticket?.status === 'ok') continue
    const message = messages[index]
    const details = record(ticket?.details)
    const expoError = typeof details?.error === 'string' ? details.error : null
    const invalidToken = expoError === 'DeviceNotRegistered'
    if (invalidToken && dependencies.invalidateToken) {
      const invalidation = await dependencies.invalidateToken(message.userId, message.token)
      if (invalidation.error) {
        failures.push(new NotificationDeliveryError({
          code: 'profile_lookup',
          message: `invalid push token cleanup failed: ${invalidation.error.message}`,
          memberId: message.memberId,
          userId: message.userId,
          cause: invalidation.error,
        }))
        continue
      }
    }
    failures.push(new NotificationDeliveryError({
      code: ticket?.status === 'error' ? 'expo_status' : 'expo_response',
      message: typeof ticket?.message === 'string' ? ticket.message : 'Expo rejected a push notification.',
      memberId: message.memberId,
      userId: message.userId,
      retryable: ticket?.status !== 'error' || !expoError || !PERMANENT_EXPO_ERRORS.has(expoError),
      expoError,
    }))
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, `${failures.length} Expo push notification${failures.length === 1 ? '' : 's'} failed`)
  }
}

export function createNotifyMembers(
  dependencies: NotificationBatchDependencies,
  options: { batchSize?: number; concurrency?: number } = {},
): NotifyMembers {
  const batchSize = options.batchSize ?? EXPO_BATCH_SIZE
  const concurrency = options.concurrency ?? EXPO_BATCH_CONCURRENCY
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > EXPO_BATCH_SIZE) {
    throw new RangeError(`batchSize must be an integer between 1 and ${EXPO_BATCH_SIZE}`)
  }

  return async (messages) => {
    if (messages.length === 0) return []
    const memberIds = [...new Set(messages.map((message) => message.memberId))]
    const memberLookup = await dependencies.members(memberIds)
    if (memberLookup.error) throw batchLookupError('member_lookup', memberLookup.error, memberIds)
    const memberById = new Map((memberLookup.data ?? []).map((member) => [member.id, member]))
    const missingMemberId = memberIds.find((memberId) => !memberById.has(memberId))
    if (missingMemberId) throw lookupError('member_lookup', null, missingMemberId)

    const userIds = [...new Set(memberIds.map((memberId) => memberById.get(memberId)!.user_id))]
    const [preferenceLookup, profileLookup] = await Promise.all([
      dependencies.preferences(userIds),
      dependencies.profiles(userIds),
    ])
    if (preferenceLookup.error) throw batchLookupError('preferences_lookup', preferenceLookup.error, memberIds)
    if (profileLookup.error) throw batchLookupError('profile_lookup', profileLookup.error, memberIds)

    const preferencesByUserId = new Map((preferenceLookup.data ?? []).map((preference) => [preference.user_id, preference]))
    const profileByUserId = new Map((profileLookup.data ?? []).map((profile) => [profile.id, profile]))
    const results: NotificationBatchResult[] = []
    const prepared: PreparedNotification[] = []

    for (const message of messages) {
      const userId = memberById.get(message.memberId)!.user_id
      const category = message.category ?? 'activity'
      if (preferencesByUserId.get(userId)?.[preferenceColumns[category]] === false) {
        results.push({ memberId: message.memberId, status: 'skipped', reason: 'preferences_disabled' })
        continue
      }
      const token = profileByUserId.get(userId)?.push_token
      if (!token) {
        results.push({ memberId: message.memberId, status: 'skipped', reason: 'missing_push_token' })
        continue
      }
      prepared.push({ ...message, userId, token })
    }

    await runBounded(
      chunks(prepared, batchSize).map((batch) => () => sendBatch(dependencies, batch)),
      concurrency,
    )
    results.push(...prepared.map((message) => ({ memberId: message.memberId, status: 'sent' as const })))
    return results
  }
}

export function createNotifyMember(dependencies: NotificationDependencies): NotifyMember {
  return async (
    memberId,
    title,
    body,
    data,
    category = 'activity',
  ) => {
    const memberLookup = await dependencies.member(memberId)
    if (memberLookup.error || !memberLookup.data) {
      throw lookupError('member_lookup', memberLookup.error, memberId)
    }
    const userId = memberLookup.data.user_id

    const preferenceLookup = await dependencies.preferences(userId)
    if (preferenceLookup.error) {
      throw lookupError('preferences_lookup', preferenceLookup.error, memberId, userId)
    }
    if (preferenceLookup.data?.[preferenceColumns[category]] === false) {
      return { status: 'skipped', reason: 'preferences_disabled' }
    }

    const profileLookup = await dependencies.profile(userId)
    if (profileLookup.error) {
      throw lookupError('profile_lookup', profileLookup.error, memberId, userId)
    }
    const token = profileLookup.data?.push_token
    if (!token) return { status: 'skipped', reason: 'missing_push_token' }

    let response: Response
    try {
      response = await dependencies.send(dependencies.pushUrl, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ to: token, title, body, data: data ?? {}, sound: 'default' }),
        signal: AbortSignal.timeout(PUSH_TIMEOUT_MS),
      })
    } catch (cause) {
      throw new NotificationDeliveryError({
        code: 'expo_network',
        message: 'Expo push request failed.',
        memberId,
        userId,
        cause,
      })
    }

    let payload: unknown
    try {
      payload = await response.json()
    } catch (cause) {
      throw new NotificationDeliveryError({
        code: response.ok ? 'expo_response' : 'expo_http',
        message: response.ok
          ? 'Expo push response was not valid JSON.'
          : `Expo push request returned HTTP ${response.status}.`,
        memberId,
        userId,
        cause,
      })
    }
    const payloadRecord = record(payload)
    const delivery = record(payloadRecord?.data)
    const deliveryMessage = typeof delivery?.message === 'string' ? delivery.message : null

    if (!response.ok) {
      throw new NotificationDeliveryError({
        code: 'expo_http',
        message: `Expo push request returned HTTP ${response.status}${deliveryMessage ? `: ${deliveryMessage}` : ''}.`,
        memberId,
        userId,
      })
    }
    if (delivery?.status === 'error') {
      throw new NotificationDeliveryError({
        code: 'expo_status',
        message: deliveryMessage ?? 'Expo rejected the push notification.',
        memberId,
        userId,
      })
    }
    if (delivery?.status !== 'ok') {
      throw new NotificationDeliveryError({
        code: 'expo_response',
        message: 'Expo push response did not include a valid delivery status.',
        memberId,
        userId,
      })
    }
    return { status: 'sent' }
  }
}
