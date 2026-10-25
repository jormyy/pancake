import { notificationEnabled, type NotificationCategory, type NotificationPreferenceRow } from './notificationsPreferences.ts'
import { runBounded } from './runBounded.ts'
import type { WebPushFanout, WebPushFanoutMessage } from './webPushDelivery.ts'

const PUSH_TIMEOUT_MS = 8000
const EXPO_BATCH_SIZE = 100
const EXPO_BATCH_CONCURRENCY = 2
const DISCARD_EXPO_ERRORS = new Set(['DeviceNotRegistered'])
const DEAD_LETTER_EXPO_ERRORS = new Set(['MessageTooBig', 'MismatchSenderId'])

type DeliveryCategory = NotificationCategory | 'activity'
type NotificationPreferences = NotificationPreferenceRow
type LookupError = { message: string; code?: string }
type LookupResult<Value> = { data: Value | null; error: LookupError | null }

type NotificationDeliveryFailureCode =
  | 'web_push'
  | 'member_lookup'
  | 'preferences_lookup'
  | 'profile_lookup'
  | 'expo_network'
  | 'expo_http'
  | 'expo_response'
  | 'expo_status'

type NotificationDeliveryResult =
  | { status: 'sent'; ticketId?: string; pushToken?: string; channel?: 'web' }
  | { status: 'skipped'; reason: 'preferences_disabled' | 'no_device' | 'missing_push_token' | 'durably_suppressed' | 'no_subscription' | 'gone' }
  | { status: 'failed'; retryable: boolean; error: string }

export type NotificationMessage = {
  memberId: string
  title: string
  body: string
  data?: Record<string, unknown>
  category?: DeliveryCategory
  delivery?: { id: string; claimToken: string }
}

type NotificationBatchResult = NotificationDeliveryResult & { memberId: string }

class NotificationDeliveryError extends Error {
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

export type NotifyMembers = (messages: NotificationMessage[]) => Promise<NotificationBatchResult[]>

type ExpoNotificationBatchDependencies = {
  members: (memberIds: string[]) => Promise<LookupResult<Array<{ id: string; user_id: string }>>>
  preferences: (userIds: string[]) => Promise<LookupResult<Array<NotificationPreferences & { user_id: string }>>>
  profiles: (userIds: string[]) => Promise<LookupResult<Array<{ id: string; push_token: string | null }>>>
  persistExpoTicket: (message: NotificationMessage, ticketId: string, pushToken: string) => Promise<void>
  admitDelivery?: (message: NotificationMessage) => Promise<boolean>
  beginWebDelivery?: (message: NotificationMessage, userId: string) => Promise<'send' | 'delivered' | 'attempted' | 'no_device'>
  finishWebDelivery?: (message: NotificationMessage, sent: boolean) => Promise<void>
  invalidateToken?: (userId: string, token: string) => Promise<LookupResult<boolean>>
  send: (url: string, init: RequestInit) => Promise<Response>
  pushUrl: string
  webPush?: WebPushFanout
}

export type NotificationBatchDependencies = ExpoNotificationBatchDependencies

type NotificationFailureDisposition = 'discard' | 'dead_letter' | 'retry'

function deliveryErrors(error: unknown): NotificationDeliveryError[] {
  if (error instanceof NotificationDeliveryError) return [error]
  if (error instanceof AggregateError) return error.errors.flatMap(deliveryErrors)
  return []
}

export function notificationFailureDisposition(error: unknown): NotificationFailureDisposition {
  const failures = deliveryErrors(error)
  if (failures.length === 0) return 'retry'
  if (failures.every((failure) => failure.expoError && DISCARD_EXPO_ERRORS.has(failure.expoError))) {
    return 'discard'
  }
  if (failures.every((failure) => failure.expoError && DEAD_LETTER_EXPO_ERRORS.has(failure.expoError))) {
    return 'dead_letter'
  }
  return 'retry'
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
  dependencies: ExpoNotificationBatchDependencies,
  messages: PreparedNotification[],
): Promise<NotificationBatchResult[]> => {
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
  const results: NotificationBatchResult[] = []
  for (const [index, delivery] of deliveries.entries()) {
    const ticket = record(delivery)
    const message = messages[index]
    if (ticket?.status === 'ok') {
      if (typeof ticket.id !== 'string' || ticket.id.length === 0) {
        failures.push(new NotificationDeliveryError({
          code: 'expo_response',
          message: 'Expo accepted a push notification without returning a ticket id.',
          memberId: message.memberId,
          userId: message.userId,
        }))
      } else {
        if (message.delivery) await dependencies.persistExpoTicket(message, ticket.id, message.token)
        results.push({
          memberId: message.memberId,
          status: 'sent',
          ticketId: ticket.id,
          pushToken: message.token,
        })
      }
      continue
    }
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
      retryable: ticket?.status !== 'error' || !expoError ||
        (!DISCARD_EXPO_ERRORS.has(expoError) && !DEAD_LETTER_EXPO_ERRORS.has(expoError)),
      expoError,
    }))
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, `${failures.length} Expo push notification${failures.length === 1 ? '' : 's'} failed`)
  }
  return results
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
    const webMessages: (WebPushFanoutMessage & { message: NotificationMessage })[] = []

    for (const message of messages) {
      const userId = memberById.get(message.memberId)!.user_id
      const category = message.category ?? 'activity'
      if (message.delivery && dependencies.admitDelivery && !await dependencies.admitDelivery(message)) {
        results.push({ memberId: message.memberId, status: 'skipped', reason: 'durably_suppressed' })
        continue
      }
      if (!notificationEnabled(preferencesByUserId.get(userId), category, typeof message.data?.notificationEvent === 'string' ? message.data.notificationEvent : undefined)) {
        results.push({ memberId: message.memberId, status: 'skipped', reason: 'preferences_disabled' })
        continue
      }
      webMessages.push({ userId, title: message.title, body: message.body, data: message.data, category, message })
      const token = profileByUserId.get(userId)?.push_token
      if (!token) {
        results.push({ memberId: message.memberId, status: 'skipped', reason: 'missing_push_token' })
        continue
      }
      prepared.push({ ...message, userId, token })
    }

    const webReservations = await Promise.all(webMessages.map(async ({ message, ...webMessage }) => {
      if (!dependencies.webPush) return null
      try {
        const state = message.delivery && dependencies.beginWebDelivery
          ? await dependencies.beginWebDelivery(message, webMessage.userId) : 'send'
        return { message, webMessage, state }
      } catch (error) {
        console.error('Web notification reservation failed', error)
        const pending = results.find(item => item.memberId === message.memberId && item.status === 'skipped' && item.reason === 'missing_push_token')
        if (pending) results.splice(results.indexOf(pending), 1, { memberId: message.memberId, status: 'failed', retryable: true, error: error instanceof Error ? error.message : String(error) })
        return null
      }
    }))
    const webDelivery = Promise.all(webReservations.map(async reservation => {
      if (!reservation) return
      const { message, webMessage, state } = reservation
      try {
        if (state === 'no_device') {
          const pending = results.find(item => item.memberId === message.memberId && item.status === 'skipped' && item.reason === 'missing_push_token')
          if (pending) results.splice(results.indexOf(pending), 1, { memberId: message.memberId, status: 'skipped', reason: 'no_device' })
          return
        }
        let sent = state === 'delivered'
        let webOutcome: NotificationBatchResult = { memberId: message.memberId, status: 'failed', retryable: true, error: 'Web push delivery outcome is unknown' }
        if (state === 'send') {
          const summary = await dependencies.webPush!([webMessage])
          sent = summary.sent > 0
          const outcome = summary.results[0]
          if (outcome?.userId === webMessage.userId && outcome.status === 'failed') {
            webOutcome = { memberId: message.memberId, status: 'failed', retryable: outcome.retryable, error: outcome.error }
          } else if (outcome?.userId === webMessage.userId && (outcome.status === 'no_subscription' || outcome.status === 'gone')) {
            webOutcome = { memberId: message.memberId, status: 'skipped', reason: outcome.status }
          }
          if (message.delivery && dependencies.finishWebDelivery) await dependencies.finishWebDelivery(message, sent)
        }
        if (sent) {
          const result = results.find(item => item.memberId === message.memberId && item.status === 'skipped' && item.reason === 'missing_push_token')
          if (result) results.splice(results.indexOf(result), 1, { memberId: message.memberId, status: 'sent', channel: 'web' })
        }
        if (!sent) {
          const pending = results.find(item => item.memberId === message.memberId && item.status === 'skipped' && item.reason === 'missing_push_token')
          if (pending) {
            results.splice(results.indexOf(pending), 1, webOutcome)
          }
        }
      } catch (error) {
        console.error('Web notification delivery state failed', error)
      }
    }))
    const delivered: NotificationBatchResult[] = []
    try {
      await runBounded(
        chunks(prepared, batchSize).map((batch) => async () => {
          delivered.push(...await sendBatch(dependencies, batch))
        }),
        concurrency,
      )
    } finally {
      await webDelivery
    }
    results.push(...delivered)
    return results
  }
}
