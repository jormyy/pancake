import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { byteSizes, documentAssets } from '../scripts/measure-web-bytes.mjs'

describe('web byte measurement', () => {
    it('counts each local document dependency once', () => {
        expect(documentAssets('<script src="/a.js"></script><script src="/a.js"></script><link rel="preload" href="/font.woff2" as="font"><img src="https://outside.invalid/image"><img src="/logo.png"><link rel="stylesheet" href="/a.css">'))
            .toEqual(['/a.css', '/a.js', '/font.woff2', '/logo.png'])
    })

    it('compresses actual bytes with both codecs', () => {
        const sizes = byteSizes(Buffer.from('pancake '.repeat(1000)))
        expect(sizes.raw).toBe(8000)
        expect(sizes.gzip).toBeLessThan(sizes.raw)
        expect(sizes.br).toBeLessThan(sizes.gzip)
        expect(byteSizes(Buffer.from('pancake '.repeat(1000)))).toEqual(sizes)
    })

    it('rejects a byte build outside the private mini environment', () => {
        const result = spawnSync(process.execPath, ['scripts/perf-lab/run.mjs', 'bytes', 'build'], {
            env: { ...process.env, PERF_LAB_ON_MINI: '0' }, encoding: 'utf8',
        })
        expect(result.status).not.toBe(0)
        expect(result.stderr).toContain('Run this command through perf:lab on the mini')
    })
})
