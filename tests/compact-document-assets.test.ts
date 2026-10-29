import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { runInNewContext } from 'node:vm'
import { expect, it } from 'vitest'
import { compactDocumentAssets } from '../scripts/compact-document-assets.mjs'

it('compacts font and auth declarations without changing the managed stylesheet', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'compact-styles-'))
    try {
        await mkdir(path.join(root, 'dist'))
        const managed = '<style id="react-native-stylesheet">[stylesheet-group="0"]{}\n.example{color:red;}</style>'
        const font = '<style id="expo-generated-fonts">@font-face { font-family: "Outfit"; src: url("/assets/outfit.woff2"); font-display: optional; }</style>'
        const auth = '<style>html [data-auth-hero] { display: none; } html [data-auth-scroll] > div { padding: 12px 12px 12px 12px; }</style>'
        const html = managed + font + auth
        await writeFile(path.join(root, 'dist/index.html'), html)
        await compactDocumentAssets(root)
        const output = await readFile(path.join(root, 'dist/index.html'), 'utf8')
        expect(output.length).toBeLessThan(html.length)
        expect(output).toContain(managed)
        expect(output).toContain('id="expo-generated-fonts"')
        expect(output).toContain('/assets/outfit.woff2')
        expect(output).toContain('font-display:optional')
        expect(output).toContain('[data-auth-hero]')
        expect(output).toContain('padding:12px')
        await compactDocumentAssets(root)
        expect(await readFile(path.join(root, 'dist/index.html'), 'utf8')).toBe(output)
    } finally { await rm(root, { recursive: true, force: true }) }
})

it('shares boot code while preserving inline styles and route hydration', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'compact-documents-'))
    try {
        await mkdir(path.join(root, 'dist'))
        const source = `globalThis.answer = 42;${'\n'.repeat(1100)}`
        const css = `[stylesheet-group="0"]{}\n${'.example{color:red;}\n'.repeat(70)}`
        const hydration = '<script type="module">globalThis.__EXPO_ROUTER_HYDRATE__=true;</script>'
        const html = `<style id="react-native-stylesheet">${css}</style><script>${source}</script>${hydration}`
        for (const file of ['index.html', 'sign-in.html']) await writeFile(path.join(root, 'dist', file), html)
        await compactDocumentAssets(root)
        const output = await readFile(path.join(root, 'dist/index.html'), 'utf8')
        expect(output).toContain(`<style id="react-native-stylesheet">${css}</style>`)
        expect(output).toContain(hydration)
        expect(output).not.toContain(source)
        const urls = [...output.matchAll(/(?:src|href)="([^"]+)"/g)].map(match => match[1])
        expect(urls).toHaveLength(1)
        const context: { answer?: number } = {}
        runInNewContext(await readFile(path.join(root, 'dist', urls[0]), 'utf8'), context)
        expect(context.answer).toBe(42)
        await compactDocumentAssets(root)
        expect(await readFile(path.join(root, 'dist/index.html'), 'utf8')).toBe(output)
    } finally { await rm(root, { recursive: true, force: true }) }
})
