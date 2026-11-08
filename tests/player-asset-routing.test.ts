import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'

type Route = { src?: string; dest?: string; handle?: string; status?: number; headers?: Record<string, string>; continue?: boolean }
const config = JSON.parse(readFileSync('vercel.json', 'utf8'))
const routes: Route[] = config.routes ?? []
const assetPaths = ['/_expo/static/js/web/[id]-old.js', '/_expo/unknown', '/assets/missing.woff2', '/missing.js', '/missing.css', '/sw.js', '/release-provenance.json']

it.each(assetPaths)('returns an uncached plain-text 404 for missing %s before an HTML fallback', pathname => {
    expect(config.rewrites).toBeUndefined()
    expect(config.headers).toBeUndefined()
    const filesystem = routes.findIndex(route => route.handle === 'filesystem')
    expect(filesystem).toBeGreaterThanOrEqual(0)
    const miss = routes.slice(filesystem + 1).find(route => route.src && new RegExp(route.src).test(pathname))
    expect(miss).toMatchObject({ status: 404, dest: '/asset-not-found.txt', headers: { 'Cache-Control': 'no-store', 'Content-Type': 'text/plain; charset=utf-8' } })
    expect(readFileSync(`public${miss!.dest}`, 'utf8')).not.toMatch(/<html/i)
})

it.each(['/_expo/static/js/web/current.js', '/assets/current.woff2'])('keeps existing %s immutable before checking the filesystem', pathname => {
    const filesystem = routes.findIndex(route => route.handle === 'filesystem')
    const match = routes.slice(0, filesystem).find(route => route.src && new RegExp(route.src).test(pathname))
    expect(match).toMatchObject({ continue: true, headers: { 'Cache-Control': 'public, max-age=31536000, immutable' } })
})

it.each(['/player/abc', '/settings'])('keeps HTML routing for %s', pathname => {
    const filesystem = routes.findIndex(route => route.handle === 'filesystem')
    const match = routes.slice(filesystem + 1).find(route => route.src && new RegExp(route.src).test(pathname))
    expect(match?.dest).toBe(pathname.startsWith('/player/') ? '/player/[id].html' : '/+not-found.html')
    expect(match?.status ?? 200).toBe(200)
})

it.each([
    ['/llms.txt', 'text/plain; charset=utf-8'],
    ['/agents.md', 'text/markdown; charset=utf-8'],
])('serves %s as text before the HTML fallback', (pathname, contentType) => {
    const filesystem = routes.findIndex(route => route.handle === 'filesystem')
    const match = routes.slice(0, filesystem).find(route => route.src && new RegExp(route.src).test(pathname))
    expect(match).toMatchObject({ continue: true, headers: { 'Content-Type': contentType } })
    expect(readFileSync(`public${pathname}`, 'utf8')).toMatch(/^# /)
    expect(readFileSync(`public${pathname}`, 'utf8')).not.toMatch(/<!doctype html|<html/i)
})

it('links discovery to the public Markdown guide on the production site', () => {
    const discovery = readFileSync('public/llms.txt', 'utf8')
    expect(discovery).toMatch(/^# .+\n\n> .+\n/)
    const links = [...discovery.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)].map(match => new URL(match[1]))
    expect(links.length).toBeGreaterThan(0)
    expect(links.map(link => link.href)).toContain('https://pancakedynasty.vercel.app/agents.md')
    for (const link of links) {
        expect(link.origin).toBe('https://pancakedynasty.vercel.app')
        expect(readFileSync(`public${link.pathname}`, 'utf8')).toMatch(/^# /)
    }
})
