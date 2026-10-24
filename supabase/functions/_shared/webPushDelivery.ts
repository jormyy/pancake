import { runBounded } from './runBounded.ts'
import { sendWebPush, type VapidKeys, type WebPushResult, type WebPushSubscription } from './webPush.ts'

const WEB_PUSH_CONCURRENCY = 6

type WebPushCategory = 'trade' | 'waiver' | 'draft' | 'activity'

export type WebPushFanoutMessage = {
  userId: string
  title: string
  body: string
  data?: Record<string, unknown>
  category: WebPushCategory
}

type WebPushUserResult = { userId: string } & (
  | { status: 'sent' | 'no_subscription' | 'gone' }
  | { status: 'failed'; retryable: boolean; error: string }
)

type WebPushFanoutSummary = { sent: number; pruned: number; failed: number; results: WebPushUserResult[] }

export type WebPushFanout = (messages: WebPushFanoutMessage[]) => Promise<WebPushFanoutSummary>

export type WebPushSnapshot = { endpoint: string; user_id: string; updated_at: string }
type StoredSubscription = WebPushSubscription & WebPushSnapshot
type LookupError = { message: string }

type WebPushFanoutDependencies = {
  vapid: () => VapidKeys | null
  subscriptions: (userIds: string[]) => Promise<{ data: StoredSubscription[] | null; error: LookupError | null }>
  prune: (subscriptions: WebPushSnapshot[]) => Promise<{ error: LookupError | null; count?: number }>
  send?: (subscription: WebPushSubscription, payload: unknown, keys: VapidKeys, options: Parameters<typeof sendWebPush>[3]) => Promise<WebPushResult>
}

// An endpoint can outlive account cleanup. Do not send account details to it.
export function webPushPayload() {
  return {
    title: 'Pancake',
    body: 'Open Pancake to check for updates.',
    url: '/',
  }
}

export function createWebPushFanout(dependencies: WebPushFanoutDependencies): WebPushFanout {
  const send = dependencies.send ?? ((subscription, payload, keys, options) => sendWebPush(subscription, payload, keys, options))

  return async (messages) => {
    const summary: WebPushFanoutSummary = { sent: 0, pruned: 0, failed: 0, results: [] }
    if (messages.length === 0) return summary
    const keys = dependencies.vapid()
    if (!keys) {
      summary.failed = messages.length
      summary.results = messages.map(({ userId }) => ({ userId, status: 'failed', retryable: true, error: 'Web push is not configured' }))
      return summary
    }

    const userIds = [...new Set(messages.map((message) => message.userId))]
    let subscriptions: StoredSubscription[]
    try {
      const lookup = await dependencies.subscriptions(userIds)
      if (lookup.error) throw new Error(lookup.error.message)
      subscriptions = lookup.data ?? []
    } catch (error) {
      console.error('Web push subscription lookup failed', error)
      summary.failed = messages.length
      summary.results = messages.map(({ userId }) => ({ userId, status: 'failed', retryable: true, error: 'Web push subscription lookup failed' }))
      return summary
    }

    const byUser = new Map<string, StoredSubscription[]>()
    for (const subscription of subscriptions) {
      const list = byUser.get(subscription.user_id) ?? []
      list.push(subscription)
      byUser.set(subscription.user_id, list)
    }

    const gone = new Map<string, WebPushSnapshot>()
    const attempts = messages.map(() => [] as WebPushResult[])
    const jobs = messages.flatMap((message, index) => (byUser.get(message.userId) ?? []).map((subscription) => async () => {
      if (gone.has(subscription.endpoint)) {
        attempts[index].push({ outcome: 'gone', status: 410 })
        return
      }
      let result: WebPushResult
      try {
        result = await send(subscription, webPushPayload(), keys, {
          urgency: message.category === 'draft' ? 'high' : 'normal',
        })
      } catch (error) {
        result = { outcome: 'failed', status: null, retryable: true,
          message: error instanceof Error ? error.message : 'Web push send failed' }
      }
      attempts[index].push(result)
      if (result.outcome === 'sent') summary.sent += 1
      else if (result.outcome === 'gone') gone.set(subscription.endpoint, subscription)
      else {
        summary.failed += 1
        console.error('Web push endpoint delivery failed', { endpoint: subscription.endpoint, ...result })
      }
    }))

    await runBounded(jobs, WEB_PUSH_CONCURRENCY)
    summary.results = messages.map(({ userId }, index): WebPushUserResult => {
      const results = attempts[index]
      if (results.some((result) => result.outcome === 'sent')) return { userId, status: 'sent' }
      const failures = results.filter((result) => result.outcome === 'failed')
      if (failures.length > 0) return { userId, status: 'failed',
        retryable: failures.some((result) => result.retryable), error: failures.map((result) => result.message).join('; ') }
      return { userId, status: results.length > 0 ? 'gone' : 'no_subscription' }
    })

    if (gone.size > 0) {
      try {
        const { error, count } = await dependencies.prune([...gone.values()])
        if (error) throw new Error(error.message)
        summary.pruned = count ?? gone.size
      } catch (error) {
        console.error('Web push subscription pruning failed', error)
      }
    }
    return summary
  }
}
