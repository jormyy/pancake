import { readFile } from 'node:fs/promises'
import { expect, it } from 'vitest'
import { repackPng } from '../scripts/repack-png.mjs'

it('preserves the PNG image and rejects corrupt input', async () => {
    const source = await readFile('public/boot-logo.png')
    const output = repackPng(source)
    expect(output.length).toBeLessThanOrEqual(source.length)
    expect(output.subarray(0, 33)).toEqual(source.subarray(0, 33))
    expect(repackPng(output)).toEqual(output)
    const corrupt = Buffer.from(source)
    corrupt[50] ^= 1
    expect(() => repackPng(corrupt)).toThrow()
})
