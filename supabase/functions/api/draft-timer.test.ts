Deno.env.set('SUPABASE_URL', 'http://127.0.0.1:57921')
Deno.env.set('PANCAKE_SUPABASE_SECRET_KEY', 'sb_secret_synthetic_timer_test')
const { rookieDraftStartOptions, mockDraftRoomOptions } = await import('./draft.ts')

Deno.test('rookie timer accepts both bounds and every expiry choice', () => {
  for (const timerSeconds of [60, 604800]) {
    for (const timerExpiryBehavior of ['auto_pick', 'skip_pick', 'pause_draft', 'commissioner_pick']) {
      const options = rookieDraftStartOptions({ timerSeconds, timerExpiryBehavior })
      if (options.timerSeconds !== timerSeconds || options.timerExpiryBehavior !== timerExpiryBehavior) throw Error('Valid setting changes')
    }
  }
  if (rookieDraftStartOptions({}).timerSeconds !== 60) throw Error('Default must be one minute')
})

Deno.test('rookie timer rejects invalid bounds and fractional seconds', () => {
  for (const timerSeconds of [5, 15, 30, 59, 604801, 60.5, null, '60']) {
    let rejected = false
    try { rookieDraftStartOptions({ timerSeconds }) } catch (error) {
      rejected = error instanceof Error && error.message.includes('timerSeconds')
    }
    if (!rejected) throw Error(`Invalid timer accepted: ${timerSeconds}`)
  }
})

Deno.test('mock rookie validation uses the rookie range while auction keeps its range', () => {
  if (mockDraftRoomOptions({ draftType: 'snake' }).timerSeconds !== 60) throw Error('Mock rookie default is invalid')
  if (mockDraftRoomOptions({ draftType: 'snake', timerSeconds: 604800 }).timerSeconds !== 604800) throw Error('Mock rookie maximum is invalid')
  if (mockDraftRoomOptions({ draftType: 'auction', timerSeconds: 5 }).timerSeconds !== 5) throw Error('Auction minimum changes')
})
