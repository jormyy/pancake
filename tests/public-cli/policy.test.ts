import { expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { checkModel } from '../../tools/verify/public-model.mjs'
import { generate } from '../../tools/verify/public-policy.mjs'
import { verifyInstalled } from '../e2e/public-cli-v2.mjs'
import { verifyLive } from '../e2e/public-cli.mjs'

it('checks the bounded visibility model',()=>{expect(checkModel().checks).toBeGreaterThan(15000)})
it('checks generated SQL and contracts against the policy',async()=>{await expect(generate(true)).resolves.toContain('supabase/migrations/20261214010700_public_projection_batch.sql')})
it('runs the installed executable for every resource',async()=>{await verifyInstalled()},15000)
it('requires explicit live-read authorization outside loopback',async()=>{
  await expect(verifyLive('https://example.invalid','11111111-1111-4111-8111-111111111111')).rejects.toThrow()
})

it('keeps database admission out of the read-only data function',async()=>{
  const read=await readFile('supabase/sql/functions/by-name/public/public_read_v2.sql','utf8')
  const admission=await readFile('supabase/sql/functions/by-name/public/public_admit_read.sql','utf8')
  expect(read).toContain('LANGUAGE plpgsql STABLE SECURITY DEFINER')
  expect(read).not.toMatch(/public_api_buckets|public_admit_read|INSERT INTO|UPDATE public|DELETE FROM/)
  expect(admission).not.toContain("VALUES('global'")
  expect(admission).toContain('reads<60')
})
