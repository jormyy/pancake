import type { WebPushFanout, WebPushFanoutMessage } from './webPushDelivery.ts'

type NotificationCategory = 'trade' | 'waiver' | 'draft' | 'activity'
type NotificationPreferenceColumn = 'trade_enabled' | 'waiver_enabled' | 'draft_enabled' | 'activity_enabled'
type NotificationPreferences = Record<NotificationPreferenceColumn, boolean>
type LookupError = { message: string; code?: string }
type LookupResult<Value> = { data: Value | null; error: LookupError | null }

export type NotificationDeliveryFailureCode = 'member_lookup' | 'preferences_lookup' | 'web_push'

type NotificationDeliveryResult =
  | { status: 'sent' }
  | { status: 'skipped'; reason: 'preferences_disabled' | 'no_subscription' | 'gone' }
  | { status: 'failed'; retryable: boolean; error: string }

export type NotificationMessage = {
  memberId: string
  title: string
  body: string
  data?: Record<string, unknown>
  category?: NotificationCategory
}

type NotificationBatchResult = NotificationDeliveryResult & { memberId: string }

export class NotificationDeliveryError extends Error {
  constructor(
    readonly code: NotificationDeliveryFailureCode,
    message: string,
    readonly memberId: string,
  ) {
    super(message)
    this.name = 'NotificationDeliveryError'
  }
}

export type NotificationDependencies = {
  member: (memberId: string) => Promise<LookupResult<{ user_id: string }>>
  preferences: (userId: string) => Promise<LookupResult<NotificationPreferences>>
  webPush: WebPushFanout
}

export type NotifyMembers = (messages: NotificationMessage[]) => Promise<NotificationBatchResult[]>

export type NotificationBatchDependencies = {
  members: (memberIds: string[]) => Promise<LookupResult<Array<{ id: string; user_id: string }>>>
  preferences: (userIds: string[]) => Promise<LookupResult<Array<NotificationPreferences & { user_id: string }>>>
  webPush: WebPushFanout
}

const preferenceColumns: Record<NotificationCategory, NotificationPreferenceColumn> = {
  trade: 'trade_enabled',
  waiver: 'waiver_enabled',
  draft: 'draft_enabled',
  activity: 'activity_enabled',
}

export function createNotifyMembers(dependencies: NotificationBatchDependencies): NotifyMembers {
  return async (messages) => {
    if (messages.length === 0) return []
    const memberIds = [...new Set(messages.map((message) => message.memberId))]
    const memberLookup = await dependencies.members(memberIds)
    if (memberLookup.error) throw new NotificationDeliveryError('member_lookup', memberLookup.error.message, memberIds[0])
    const memberById = new Map((memberLookup.data ?? []).map((member) => [member.id, member]))
    const missingMemberId = memberIds.find((memberId) => !memberById.has(memberId))
    if (missingMemberId) throw new NotificationDeliveryError('member_lookup', 'Notification member not found', missingMemberId)

    const userIds = [...new Set(memberIds.map((memberId) => memberById.get(memberId)!.user_id))]
    const preferenceLookup = await dependencies.preferences(userIds)
    if (preferenceLookup.error) throw new NotificationDeliveryError('preferences_lookup', preferenceLookup.error.message, memberIds[0])
    const preferencesByUserId = new Map((preferenceLookup.data ?? []).map((preference) => [preference.user_id, preference]))
    const results: NotificationBatchResult[] = []
    const webMessages: WebPushFanoutMessage[] = []
    const prepared: NotificationMessage[] = []

    for (const message of messages) {
      const userId = memberById.get(message.memberId)!.user_id
      const category = message.category ?? 'activity'
      if (preferencesByUserId.get(userId)?.[preferenceColumns[category]] === false) {
        results.push({ memberId: message.memberId, status: 'skipped', reason: 'preferences_disabled' })
        continue
      }
      prepared.push(message)
      webMessages.push({ userId, title: message.title, body: message.body, data: message.data, category })
    }
    if (webMessages.length === 0) return results
    const delivery = await dependencies.webPush(webMessages)
    for (const [index, message] of prepared.entries()) {
      const result = delivery.results[index]
      if (!result || result.userId !== webMessages[index].userId) {
        results.push({ memberId: message.memberId, status: 'failed', retryable: true, error: 'Web push delivery returned no matching outcome' })
      } else if (result.status === 'sent') {
        results.push({ memberId: message.memberId, status: 'sent' })
      } else if (result.status === 'failed') {
        results.push({ memberId: message.memberId, status: 'failed', retryable: result.retryable, error: result.error })
      } else {
        results.push({ memberId: message.memberId, status: 'skipped', reason: result.status })
      }
    }
    return results
  }
}

export function createNotifyMember(dependencies: NotificationDependencies) {
  return async (
    memberId: string,
    title: string,
    body: string,
    data?: Record<string, unknown>,
    category: NotificationCategory = 'activity',
  ): Promise<NotificationDeliveryResult> => {
    const notify = createNotifyMembers({
      members: async () => {
        const lookup = await dependencies.member(memberId)
        return { data: lookup.data ? [{ id: memberId, ...lookup.data }] : null, error: lookup.error }
      },
      preferences: async ([userId]) => {
        const lookup = await dependencies.preferences(userId)
        return { data: lookup.data ? [{ user_id: userId, ...lookup.data }] : null, error: lookup.error }
      },
      webPush: dependencies.webPush,
    })
    const [result] = await notify([{ memberId, title, body, data, category }])
    if (result.status === 'failed') throw new NotificationDeliveryError('web_push', result.error, memberId)
    return result
  }
}
