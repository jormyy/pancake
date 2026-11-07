import { expect, it } from 'vitest'
import { checkModel } from '../../tools/verify/public-model.mjs'
import { generate } from '../../tools/verify/public-policy.mjs'
import { verifyInstalled } from '../e2e/public-cli-v2.mjs'
import { verifyLive } from '../e2e/public-cli.mjs'

it('checks the bounded visibility model',()=>{expect(checkModel().checks).toBeGreaterThan(15000)})
it('checks generated SQL and contracts against the policy',async()=>{await expect(generate(true)).resolves.toHaveLength(4)})
it('runs the installed executable for every resource',async()=>{await verifyInstalled()},15000)
it('requires explicit live-read authorization outside loopback',async()=>{
  await expect(verifyLive('https://example.invalid','11111111-1111-4111-8111-111111111111')).rejects.toThrow()
})
