import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { expect, it } from 'vitest'
import { stampReleaseProvenance } from '../scripts/stamp-release-provenance.mjs'
import { FRONTEND_DEPLOYMENT_INPUTS } from './e2e/release-provenance.mjs'
import { readPwaRelease } from './e2e/pwa-update-release.mjs'

it('binds the page, worker and immutable public URLs to one repeatable release', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'pwa-release-'))
    try {
        await mkdir(path.join(root, 'dist/_expo/static/js/web'), { recursive: true })
        for (const input of FRONTEND_DEPLOYMENT_INPUTS) await writeFile(path.join(root, input), '{}')
        const html = '<meta name="pancake-release" content="pancake-build"><link rel="manifest" href="/manifest.webmanifest"><img src="/boot-logo.png"><script src="/_expo/static/js/web/app.js"></script>'
        for (const file of ['index.html', 'sign-in.html']) await writeFile(path.join(root, 'dist', file), html)
        await writeFile(path.join(root, 'dist/_expo/static/js/web/app.js'), 'globalThis.release = true')
        await writeFile(path.join(root, 'dist/boot-logo.png'), 'logo')
        await writeFile(path.join(root, 'dist/pwa-192.png'), 'icon')
        await writeFile(path.join(root, 'dist/manifest.webmanifest'), JSON.stringify({ id: '/', scope: '/', start_url: '/', icons: [{ src: '/pwa-192.png' }] }))
        await writeFile(path.join(root, 'dist/sw.js'), await readFile('public/sw.js'))
        const first = await stampReleaseProvenance({ root, commitSha: 'a'.repeat(40) })
        const release = await readPwaRelease(path.join(root, 'dist'))
        const exported = await readFile(path.join(root, 'dist/index.html'), 'utf8')
        expect(exported).toContain(`content="${release.version}"`)
        const manifestUrl = /href="([^"]+)"/.exec(exported)![1]
        expect(manifestUrl).toMatch(/^\/assets\/pwa\/manifest\.[a-f0-9]{32}\.webmanifest$/)
        const manifest = JSON.parse(await readFile(path.join(root, 'dist', manifestUrl), 'utf8'))
        expect(manifest).toMatchObject({ id: '/', scope: '/', start_url: '/' })
        expect(manifest.icons[0].src).toMatch(/^\/assets\/pwa\/pwa-192\.[a-f0-9]{32}\.png$/)
        expect(Object.keys(release.bootHashes)).toEqual(expect.arrayContaining([manifestUrl, expect.stringMatching(/boot-logo\.[a-f0-9]{32}\.png$/)]))
        const second = await stampReleaseProvenance({ root, commitSha: 'a'.repeat(40) })
        expect(second.bundleDigest).toBe(first.bundleDigest)
        await writeFile(path.join(root, 'dist', manifestUrl), '{}')
        await expect(readPwaRelease(path.join(root, 'dist'))).rejects.toThrow(/bytes differ/)
        expect(createHash('sha256').update('{}').digest('hex')).not.toBe(release.bootHashes[manifestUrl])
    } finally { await rm(root, { recursive: true, force: true }) }
})

it('changes the boot entry URL when Metro changes its route map under the same filename', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'pwa-entry-'))
    try {
        await mkdir(path.join(root, 'dist/_expo/static/js/web'), { recursive: true })
        for (const input of FRONTEND_DEPLOYMENT_INPUTS) await writeFile(path.join(root, input), '{}')
        await writeFile(path.join(root, 'dist/manifest.webmanifest'), '{}')
        const html = '<link rel="manifest" href="/manifest.webmanifest"><script src="/_expo/static/js/web/entry-same.js"></script>'
        const entries: string[] = []
        for (const routeMap of ['old-chunk.js', 'new-chunk.js']) {
            await writeFile(path.join(root, 'dist/sw.js'), await readFile('public/sw.js'))
            for (const file of ['index.html', 'sign-in.html']) await writeFile(path.join(root, 'dist', file), html)
            await writeFile(path.join(root, 'dist/_expo/static/js/web/entry-same.js'), `globalThis.route = '${routeMap}'`)
            await stampReleaseProvenance({ root, commitSha: 'a'.repeat(40) })
            const exported = await readFile(path.join(root, 'dist/index.html'), 'utf8')
            entries.push(/src="([^"]+)"/.exec(exported)![1])
        }
        expect(entries[0]).not.toBe(entries[1])
    } finally { await rm(root, { recursive: true, force: true }) }
})

it('includes shared document code in the verified boot and retained asset manifests', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'pwa-document-'))
    try {
        await mkdir(path.join(root, 'dist/_expo/static/js/web'), { recursive: true })
        for (const input of FRONTEND_DEPLOYMENT_INPUTS) await writeFile(path.join(root, input), '{}')
        const css = '.shared{color:red;}\n'.repeat(80)
        const script = `globalThis.booted = true;${'\n'.repeat(1100)}`
        const html = `<meta name="pancake-release" content="pancake-build"><style id="react-native-stylesheet">${css}</style><script>${script}</script><script src="/_expo/static/js/web/app.js"></script>`
        for (const file of ['index.html', 'sign-in.html']) await writeFile(path.join(root, 'dist', file), html)
        await writeFile(path.join(root, 'dist/_expo/static/js/web/app.js'), 'globalThis.release = true')
        await writeFile(path.join(root, 'dist/sw.js'), await readFile('public/sw.js'))
        const first = await stampReleaseProvenance({ root, commitSha: 'a'.repeat(40) })
        const release = await readPwaRelease(path.join(root, 'dist'))
        expect(Object.keys(release.bootHashes).filter(url => url.startsWith('/assets/document/'))).toHaveLength(1)
        expect((await stampReleaseProvenance({ root, commitSha: 'a'.repeat(40) })).bundleDigest).toBe(first.bundleDigest)
        const exported = await readFile(path.join(root, 'dist/index.html'), 'utf8')
        expect(exported).toContain(`<style id="react-native-stylesheet">${css}</style>`)
        expect(exported).not.toContain(script)
    } finally { await rm(root, { recursive: true, force: true }) }
})
