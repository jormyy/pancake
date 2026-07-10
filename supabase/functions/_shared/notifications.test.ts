import {
  createNotifyMember,
  NotificationDeliveryError,
  type NotificationDeliveryFailureCode,
  type NotificationDependencies,
} from './notificationDelivery.ts'

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
