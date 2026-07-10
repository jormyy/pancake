import {
  createNotifyMember,
  createNotifyMembers,
  NotificationDeliveryError,
  type NotificationBatchDependencies,
  type NotificationDeliveryFailureCode,
  type NotificationDependencies,
} from './notificationDelivery.ts'

const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

const flush = () => new Promise<void>((resolve) => queueMicrotask(resolve))
const waitFor = async (predicate: () => boolean, message: string) => {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (predicate()) return
    await flush()
  }
  throw new Error(message)
}

const dependencies = (overrides: Partial<NotificationDependencies> = {}): NotificationDependencies => ({
  member: async () => ({ data: { user_id: 'user-a' }, error: null }),
  preferences: async () => ({
    data: { trade_enabled: true, waiver_enabled: true, draft_enabled: true, activity_enabled: true },
    error: null,
  }),
  profile: async () => ({ data: { push_token: 'ExponentPushToken[test]' }, error: null }),
  send: async () => Response.json({ data: { status: 'ok', id: 'push-a' } }),
  pushUrl: 'https://push.invalid/send',
  ...overrides,
})

const expectDeliveryError = async (
  expectedCode: NotificationDeliveryFailureCode,
  operation: () => Promise<unknown>,
) => {
  try {
    await operation()
  } catch (error) {
    if (!(error instanceof NotificationDeliveryError)) throw error
    if (error.code !== expectedCode) {
      throw new Error(`expected ${expectedCode}, found ${error.code}`)
    }
    if (error.memberId !== 'member-a') throw new Error('delivery error lost member identity')
    return
  }
  throw new Error(`expected ${expectedCode} delivery error`)
}

Deno.test('notification boundary reports typed lookup failures', async () => {
  await expectDeliveryError('member_lookup', () => createNotifyMember(dependencies({
    member: async () => ({ data: null, error: { message: 'database unavailable', code: '08006' } }),
  }))('member-a', 'Title', 'Body'))

  await expectDeliveryError('preferences_lookup', () => createNotifyMember(dependencies({
    preferences: async () => ({ data: null, error: { message: 'preference read failed' } }),
  }))('member-a', 'Title', 'Body'))

  await expectDeliveryError('profile_lookup', () => createNotifyMember(dependencies({
    profile: async () => ({ data: null, error: { message: 'profile read failed' } }),
  }))('member-a', 'Title', 'Body'))
})

Deno.test('notification boundary distinguishes network, HTTP, payload, and Expo status failures', async () => {
  await expectDeliveryError('expo_network', () => createNotifyMember(dependencies({
    send: async () => { throw new Error('connection reset') },
  }))('member-a', 'Title', 'Body'))

  await expectDeliveryError('expo_http', () => createNotifyMember(dependencies({
    send: async () => Response.json({ data: { message: 'upstream unavailable' } }, { status: 503 }),
  }))('member-a', 'Title', 'Body'))

  await expectDeliveryError('expo_http', () => createNotifyMember(dependencies({
    send: async () => new Response('unavailable', { status: 503 }),
  }))('member-a', 'Title', 'Body'))

  await expectDeliveryError('expo_response', () => createNotifyMember(dependencies({
    send: async () => new Response('not-json'),
  }))('member-a', 'Title', 'Body'))

  await expectDeliveryError('expo_status', () => createNotifyMember(dependencies({
    send: async () => Response.json({ data: { status: 'error', message: 'DeviceNotRegistered' } }),
  }))('member-a', 'Title', 'Body'))
})

Deno.test('notification boundary returns explicit sent and skipped outcomes', async () => {
  const sent = await createNotifyMember(dependencies())('member-a', 'Title', 'Body')
  if (sent.status !== 'sent') throw new Error(`expected sent outcome, found ${sent.status}`)

  const disabled = await createNotifyMember(dependencies({
    preferences: async () => ({
      data: { trade_enabled: false, waiver_enabled: true, draft_enabled: true, activity_enabled: true },
      error: null,
    }),
  }))('member-a', 'Title', 'Body', undefined, 'trade')
  if (disabled.status !== 'skipped' || disabled.reason !== 'preferences_disabled') {
    throw new Error('disabled preference did not return an explicit skip')
  }

  const missingToken = await createNotifyMember(dependencies({
    profile: async () => ({ data: { push_token: null }, error: null }),
  }))('member-a', 'Title', 'Body')
  if (missingToken.status !== 'skipped' || missingToken.reason !== 'missing_push_token') {
    throw new Error('missing push token did not return an explicit skip')
  }
})

Deno.test('bulk notification delivery bounds 600 delayed recipients to six Expo batches and three lookups', async () => {
  const memberIds = Array.from({ length: 600 }, (_, index) => `member-${index}`)
  const gates = Array.from({ length: 6 }, deferred)
  const lookupCalls = { members: 0, preferences: 0, profiles: 0 }
  const batchSizes: number[] = []
  let active = 0
  let maxActive = 0
  const batchDependencies: NotificationBatchDependencies = {
    members: async (ids) => {
      lookupCalls.members += 1
      return { data: ids.map((id) => ({ id, user_id: `user-${id}` })), error: null }
    },
    preferences: async (ids) => {
      lookupCalls.preferences += 1
      return {
        data: ids.map((user_id) => ({
          user_id,
          trade_enabled: true,
          waiver_enabled: true,
          draft_enabled: true,
          activity_enabled: true,
        })),
        error: null,
      }
    },
    profiles: async (ids) => {
      lookupCalls.profiles += 1
      return { data: ids.map((id) => ({ id, push_token: `ExponentPushToken[${id}]` })), error: null }
    },
    send: async (_url, init) => {
      const batchIndex = batchSizes.length
      const batch = JSON.parse(String(init.body)) as unknown[]
      batchSizes.push(batch.length)
      active += 1
      maxActive = Math.max(maxActive, active)
      await gates[batchIndex].promise
      active -= 1
      return Response.json({ data: batch.map(() => ({ status: 'ok' })) })
    },
    pushUrl: 'https://push.invalid/send',
  }

  let completed = false
  const pending = createNotifyMembers(batchDependencies)(memberIds.map((memberId) => ({
    memberId,
    title: 'Trade Completed',
    body: 'Assets moved.',
    category: 'trade',
  }))).then(() => { completed = true })

  await waitFor(() => batchSizes.length === 2, 'initial Expo batches did not start')
  if (completed || maxActive !== 2) throw new Error('bulk delivery did not await or bound its initial batches')
  for (let index = 0; index < gates.length; index += 1) {
    gates[index].resolve()
    if (index < gates.length - 2) {
      await waitFor(() => batchSizes.length === index + 3, `Expo batch ${index + 3} did not start`)
    }
  }
  await pending

  if (batchSizes.length !== 6 || batchSizes.some((size) => size !== 100)) {
    throw new Error(`expected six 100-message batches, found ${batchSizes.join(',')}`)
  }
  if (maxActive !== 2) throw new Error(`expected maximum batch concurrency 2, found ${maxActive}`)
  if (Object.values(lookupCalls).some((count) => count !== 1)) {
    throw new Error(`bulk delivery repeated lookups: ${JSON.stringify(lookupCalls)}`)
  }
})
