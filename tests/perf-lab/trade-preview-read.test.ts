import { afterEach, expect, it, vi } from 'vitest'
import { getTradeRosterPreview } from '@/lib/trades'
import { apiPost } from '@/lib/shared/api'

const calls = vi.hoisted(() => ({ invalidate: vi.fn(), refresh: vi.fn(async () => {}), mutation: vi.fn(async (_reason: string, write: () => Promise<unknown>) => write()) }))
vi.mock('@/lib/cache/screen-cache', () => ({ invalidateScreenViews: calls.invalidate, refreshScreenVersions: calls.refresh }))
vi.mock('@/lib/cache/mutation-queue', () => ({ configureMutationReplay: vi.fn(), pendingMutations: () => [], mutationRowIds: () => [] }))
vi.mock('@/lib/session-cache-registry', () => ({ sessionOwner: () => 'account', sessionGeneration: () => 1, onSessionCachesCleared: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ supabase: { auth: { getSession: async () => ({ data: { session: { access_token: 'fixture-token' } } }) } } }))
vi.mock('@/lib/shared/pwa-mutation', () => ({ withPwaMutation: calls.mutation }))
vi.mock('@/lib/shared/api-url', () => ({ API_URL: 'http://127.0.0.1:57281/functions/v1/api' }))
vi.mock('@/lib/roster-stats', () => ({ getRosterStatsMaps: vi.fn() }))

afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks() })

it('reads a trade preview without invalidating the view that requests it', async () => {
  const fetcher = vi.fn(async () => Response.json({ teams: [] }))
  vi.stubGlobal('fetch', fetcher)
  await getTradeRosterPreview('preview-trade')
  await getTradeRosterPreview('preview-trade')
  await Promise.resolve()
  expect(fetcher).toHaveBeenCalledTimes(2)
  expect(calls.invalidate).not.toHaveBeenCalled()
  expect(calls.refresh).not.toHaveBeenCalled()
  expect(calls.mutation).not.toHaveBeenCalled()
})

it('still refreshes trade views after a roster plan write', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ ok: true })))
  await apiPost('/trades/preview-trade/roster-plan', {})
  await Promise.resolve()
  expect(calls.invalidate).toHaveBeenCalledOnce()
  expect(calls.refresh).toHaveBeenCalledOnce()
  expect(calls.mutation).toHaveBeenCalledOnce()
})
