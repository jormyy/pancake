// backfillJobs reads the Supabase client configuration at import.
Deno.env.set('SUPABASE_URL', 'http://127.0.0.1:9')
Deno.env.set('PANCAKE_SUPABASE_SECRET_KEY', 'sb_secret_test')
const { BackfillAdmissionError, backfillJobAuthority } = await import('./backfillJobs.ts')

const job = (jobType: string, metadata: unknown) => ({ id: 'job', job_type: jobType, metadata: metadata as never })

function expectConflict(fn: () => unknown, label: string) {
  try {
    fn()
  } catch (error) {
    if (error instanceof BackfillAdmissionError && error.status === 409) return
    throw new Error(`${label}: wrong error ${error}`)
  }
  throw new Error(`${label}: accepted`)
}

Deno.test('backfill runs use the registered job source and season', () => {
  const stored = job('backfill_cdn_2025', { source: 'cdn', seasonYear: 2025 })
  const plain = backfillJobAuthority(stored, {})
  const restated = backfillJobAuthority(stored, { source: 'cdn', seasonYear: 2025 })
  for (const value of [plain, restated]) {
    if (value.source !== 'cdn' || value.seasonYear !== 2025 || value.retryBefore !== null) {
      throw new Error(`unexpected authority ${JSON.stringify(value)}`)
    }
  }
  const retry = backfillJobAuthority(job('backfill_bbref_2004', { source: 'bbref', seasonYear: 2004, retryBefore: '2026-10-10T00:00:00Z' }), {})
  if (retry.retryBefore !== '2026-10-10T00:00:00Z') throw new Error('retry cutoff lost')
})

Deno.test('backfill rejects requests that disagree with the registered job and unregistered jobs', () => {
  const stored = job('backfill_bbref_1946', { source: 'bbref', seasonYear: 1946 })
  expectConflict(() => backfillJobAuthority(stored, { source: 'cdn', seasonYear: 2025 }), 'supplied cdn 2025 against bbref 1946')
  expectConflict(() => backfillJobAuthority(stored, { seasonYear: 2025 }), 'season only')
  expectConflict(() => backfillJobAuthority(stored, { source: 'cdn' }), 'source only')
  expectConflict(() => backfillJobAuthority(job('backfill_cdn_2025', { source: 'bbref', seasonYear: 2025 }), {}), 'type/metadata mismatch')
  expectConflict(() => backfillJobAuthority(job('backfill_cdn_2025', null), {}), 'no metadata')
  expectConflict(() => backfillJobAuthority(job('backfill_espn_2025', { source: 'espn', seasonYear: 2025 }), {}), 'unknown source')
  expectConflict(() => backfillJobAuthority(job('backfill_cdn_2025.5', { source: 'cdn', seasonYear: 2025.5 }), {}), 'fractional season')
})
