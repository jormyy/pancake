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

type WebPushFanoutSummary = { sent: number; pruned: number; failed: number }

/**
 * Best-effort PWA delivery. It never throws: the Expo path owns retry and
 * receipt semantics (the trade outbox acknowledges on Expo tickets), so a web
 * push failure must not re-queue a message that Expo already delivered.
 */
export type WebPushFanout = (messages: WebPushFanoutMessage[]) => Promise<WebPushFanoutSummary>

type StoredSubscription = WebPushSubscription & { user_id: string }
type LookupError = { message: string }

export type WebPushFanoutDependencies = {
  vapid: () => VapidKeys | null
  subscriptions: (userIds: string[]) => Promise<{ data: StoredSubscription[] | null; error: LookupError | null }>
  prune: (endpoints: string[]) => Promise<{ error: LookupError | null }>
  send?: (subscription: WebPushSubscription, payload: unknown, keys: VapidKeys, options: Parameters<typeof sendWebPush>[3]) => Promise<WebPushResult>
}

// Tap targets inside the app shell; the service worker only opens same-origin paths.
const CATEGORY_URLS: Record<WebPushCategory, string> = {
  trade: '/trades',
  waiver: '/roster',
  draft: '/draft-room',
  activity: '/',
}

export function webPushPayload(message: WebPushFanoutMessage) {
  return {
    title: message.title,
    body: message.body,
    url: CATEGORY_URLS[message.category],
    category: message.category,
    data: message.data ?? {},
  }
}

export function createWebPushFanout(dependencies: WebPushFanoutDependencies): WebPushFanout {
  const send = dependencies.send ?? ((subscription, payload, keys, options) => sendWebPush(subscription, payload, keys, options))

  return async (messages) => {
    const summary: WebPushFanoutSummary = { sent: 0, pruned: 0, failed: 0 }
    if (messages.length === 0) return summary
    const keys = dependencies.vapid()
    if (!keys) return summary

    const userIds = [...new Set(messages.map((message) => message.userId))]
    let subscriptions: StoredSubscription[]
    try {
      const lookup = await dependencies.subscriptions(userIds)
      if (lookup.error) throw new Error(lookup.error.message)
      subscriptions = lookup.data ?? []
    } catch (error) {
      console.error('Web push subscription lookup failed', error)
      summary.failed = messages.length
      return summary
    }
    if (subscriptions.length === 0) return summary

    const byUser = new Map<string, StoredSubscription[]>()
    for (const subscription of subscriptions) {
      const list = byUser.get(subscription.user_id) ?? []
      list.push(subscription)
      byUser.set(subscription.user_id, list)
    }

    const gone = new Set<string>()
    const jobs = messages.flatMap((message) => (byUser.get(message.userId) ?? []).map((subscription) => async () => {
      if (gone.has(subscription.endpoint)) return
      let result: WebPushResult
      try {
        result = await send(subscription, webPushPayload(message), keys, {
          urgency: message.category === 'draft' ? 'high' : 'normal',
        })
      } catch (error) {
        // e.g. an unusable VAPID key: a configuration fault, not a dead subscription.
        summary.failed += 1
        console.error('Web push send threw', { userId: message.userId, error })
        return
      }
      if (result.outcome === 'sent') {
        summary.sent += 1
      } else if (result.outcome === 'gone') {
        gone.add(subscription.endpoint)
      } else {
        summary.failed += 1
        console.error('Web push delivery failed', { userId: message.userId, status: result.status, message: result.message })
      }
    }))

    await runBounded(jobs, WEB_PUSH_CONCURRENCY)

    if (gone.size > 0) {
      try {
        const { error } = await dependencies.prune([...gone])
        if (error) throw new Error(error.message)
        summary.pruned = gone.size
      } catch (error) {
        console.error('Web push subscription pruning failed', error)
      }
    }
    return summary
  }
}
