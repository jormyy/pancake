const PUSH_TIMEOUT_MS = 8000

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

export class NotificationDeliveryError extends Error {
  readonly code: NotificationDeliveryFailureCode
  readonly memberId: string
  readonly userId: string | null

  constructor({
    code,
    message,
    memberId,
    userId = null,
    cause,
  }: {
    code: NotificationDeliveryFailureCode
    message: string
    memberId: string
    userId?: string | null
    cause?: unknown
  }) {
    super(message, { cause })
    this.name = 'NotificationDeliveryError'
    this.code = code
    this.memberId = memberId
    this.userId = userId
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
