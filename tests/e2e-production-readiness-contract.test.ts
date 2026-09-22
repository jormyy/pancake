import { describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
    evaluateLegacyKeyReadiness,
    probeLegacyKeyDisabled,
    validInternalEdgeAuthProbe,
    validateHostedReleaseProvenance,
    validateHostedTargetIdentity,
} from './e2e/production-readiness-contract.mjs'
import { probeHostedReleaseProvenance, runHostedReleaseProvenance } from './e2e/hosted-release-provenance.mjs'

describe('production readiness contracts', () => {
    it('accepts retained legacy records only with disabled state and exact live denials', () => {
        expect(evaluateLegacyKeyReadiness({
            legacyState: { ok: true, enabled: false, evidence: 'disabled' },
            legacyKeys: ['anon', 'service_role'],
            legacyKeyDenials: [
                { name: 'anon', disabled: true },
                { name: 'service_role', disabled: true },
            ],
            manualVerified: false,
        })).toMatchObject({ pass: true, source: 'authoritative' })
    })

    it.each([
        ['missing', []],
        ['partial', [{ name: 'anon', disabled: true }]],
        ['accepted key', [{ name: 'anon', disabled: true }, { name: 'service_role', disabled: false }]],
        ['different key', [{ name: 'anon', disabled: true }, { name: 'unknown', disabled: true }]],
        ['duplicate', [{ name: 'anon', disabled: true }, { name: 'anon', disabled: true }]],
        ['extra', [{ name: 'anon', disabled: true }, { name: 'service_role', disabled: true }, { name: 'unknown', disabled: true }]],
    ])('rejects %s live legacy-key denial evidence', (_label, legacyKeyDenials) => {
        expect(evaluateLegacyKeyReadiness({
            legacyState: { ok: true, enabled: false, evidence: 'disabled' },
            legacyKeys: ['anon', 'service_role'],
            legacyKeyDenials,
            manualVerified: true,
        })).toMatchObject({ pass: false, source: 'authoritative' })
    })

    it('rejects duplicate legacy metadata even when each entry has a denial', () => {
        expect(evaluateLegacyKeyReadiness({
            legacyState: { ok: true, enabled: false, evidence: 'disabled' },
            legacyKeys: ['anon', 'anon'],
            legacyKeyDenials: [{ name: 'anon', disabled: true }, { name: 'anon', disabled: true }],
            manualVerified: true,
        })).toMatchObject({ pass: false, source: 'authoritative' })
    })

    it.each([true, null])('does not replace management state %s with denial probes', (enabled) => {
        expect(evaluateLegacyKeyReadiness({
            legacyState: { ok: enabled !== null, enabled, evidence: 'not verified disabled' },
            legacyKeys: ['anon'],
            legacyKeyDenials: [{ name: 'anon', disabled: true }],
            manualVerified: true,
        })).toMatchObject({ pass: false, source: 'authoritative' })
    })

    it('accepts authoritative absence of legacy records', () => {
        expect(evaluateLegacyKeyReadiness({
            legacyState: { ok: false, enabled: null, evidence: 'unavailable' },
            legacyKeys: [],
            manualVerified: false,
        })).toMatchObject({ pass: true, source: 'authoritative' })
    })

    it('uses a read-only, zero-row probe on the exact linked project', async () => {
        const projectRef = 'a'.repeat(20)
        const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ message: 'Legacy API keys are disabled' }), { status: 401 }))
        expect(await probeLegacyKeyDisabled({
            projectRef, supabaseUrl: `https://${projectRef}.supabase.co`, apiKey: 'fixture-legacy-key', fetchImpl,
        })).toBe(true)
        expect(fetchImpl).toHaveBeenCalledOnce()
        expect(fetchImpl).toHaveBeenCalledWith(new URL(`https://${projectRef}.supabase.co/rest/v1/leagues?select=id&limit=0`), expect.objectContaining({
            method: 'GET', redirect: 'error', headers: { apikey: 'fixture-legacy-key' }, signal: expect.any(AbortSignal),
        }))
    })

    it.each([
        [200, { message: 'Legacy API keys are disabled' }],
        [401, { message: 'Invalid API key' }],
        [403, { message: 'Legacy API keys are disabled' }],
        [500, { message: 'Legacy API keys are disabled' }],
        [401, {}],
    ])('rejects an unrelated legacy-key response: HTTP %s, %j', async (status, body) => {
        const projectRef = 'a'.repeat(20)
        expect(await probeLegacyKeyDisabled({
            projectRef, supabaseUrl: `https://${projectRef}.supabase.co`, apiKey: 'fixture-legacy-key',
            fetchImpl: async () => new Response(JSON.stringify(body), { status }),
        })).toBe(false)
    })

    it.each(['network failure', 'invalid JSON'])('fails closed on %s', async (failure) => {
        const projectRef = 'a'.repeat(20)
        expect(await probeLegacyKeyDisabled({
            projectRef, supabaseUrl: `https://${projectRef}.supabase.co`, apiKey: 'fixture-legacy-key',
            fetchImpl: async () => {
                if (failure === 'network failure') throw new Error('synthetic network failure')
                return new Response('invalid JSON', { status: 401 })
            },
        })).toBe(false)
    })

    it.each([
        'https://wrong.supabase.co', 'http://aaaaaaaaaaaaaaaaaaaa.supabase.co',
        'https://aaaaaaaaaaaaaaaaaaaa.supabase.co/unexpected',
        'https://aaaaaaaaaaaaaaaaaaaa.supabase.co?unexpected=1',
    ])('does not send credentials to an unexpected target %s', async (supabaseUrl) => {
        const fetchImpl = vi.fn()
        expect(await probeLegacyKeyDisabled({ projectRef: 'a'.repeat(20), supabaseUrl, apiKey: 'fixture-legacy-key', fetchImpl })).toBe(false)
        expect(fetchImpl).not.toHaveBeenCalled()
    })

    it('does not query with a missing key', async () => {
        const projectRef = 'a'.repeat(20)
        const fetchImpl = vi.fn()
        expect(await probeLegacyKeyDisabled({ projectRef, supabaseUrl: `https://${projectRef}.supabase.co`, apiKey: '', fetchImpl })).toBe(false)
        expect(fetchImpl).not.toHaveBeenCalled()
    })

    it('never lets manual legacy-key evidence override an authoritative enabled state', () => {
        expect(evaluateLegacyKeyReadiness({
            legacyState: { ok: true, enabled: true, evidence: 'enabled' },
            legacyKeys: ['anon', 'service_role'],
            manualVerified: true,
        })).toMatchObject({ pass: false, source: 'authoritative' })
        expect(evaluateLegacyKeyReadiness({
            legacyState: { ok: true, enabled: true, evidence: 'enabled' },
            legacyKeys: [],
            manualVerified: true,
        })).toMatchObject({ pass: false, source: 'authoritative' })
    })

    it('accepts manual legacy-key evidence only when authoritative sources are unavailable', () => {
        expect(evaluateLegacyKeyReadiness({
            legacyState: { ok: false, enabled: null, evidence: 'unavailable' },
            legacyKeys: null,
            manualVerified: true,
        })).toMatchObject({ pass: true, source: 'manual' })
        expect(evaluateLegacyKeyReadiness({
            legacyState: { ok: false, enabled: null, evidence: 'unavailable' },
            legacyKeys: ['legacy'],
            manualVerified: true,
        })).toMatchObject({ pass: false, source: 'authoritative' })
    })

    it('requires both deployed surfaces to match the intended release', () => {
        const expected = {
            frontendCommitSha: 'a'.repeat(40),
            edgeCommitSha: 'd'.repeat(40),
            frontendBundleDigest: 'b'.repeat(64),
            edgeArtifactDigest: 'c'.repeat(64),
        }
        const edge = { commitSha: expected.edgeCommitSha, edgeArtifactDigest: expected.edgeArtifactDigest }
        const frontend = { commitSha: expected.frontendCommitSha, bundleDigest: expected.frontendBundleDigest }
        expect(validateHostedReleaseProvenance(expected, edge, frontend)).toEqual([])
        expect(validateHostedReleaseProvenance(
            expected,
            { ...edge, commitSha: 'e'.repeat(40) },
            { ...frontend, bundleDigest: 'e'.repeat(64) },
        )).toEqual(expect.arrayContaining([
            expect.stringContaining('Edge commitSha'),
            expect.stringContaining('frontend bundleDigest'),
        ]))
    })

    it('rejects malformed or missing expected release identifiers', () => {
        expect(validateHostedReleaseProvenance(
            { frontendCommitSha: 'main', edgeCommitSha: '', frontendBundleDigest: '', edgeArtifactDigest: '' },
            {},
            {},
        )).toEqual(expect.arrayContaining([
            'expected frontendCommitSha must be a full Git SHA',
            'expected edgeCommitSha must be a full Git SHA',
            'expected frontendBundleDigest must be a SHA-256 digest',
            'expected edgeArtifactDigest must be a SHA-256 digest',
        ]))
    })

    it('fails a stale Edge artifact even when mutable environment values claim the new release', async () => {
        const expected = {
            frontendCommitSha: 'a'.repeat(40),
            edgeCommitSha: 'a'.repeat(40),
            frontendBundleDigest: 'b'.repeat(64),
            edgeArtifactDigest: 'c'.repeat(64),
        }
        const fetchImpl = async (url: string | URL | Request) => new Response(JSON.stringify(
            String(url).includes('/health')
                ? {
                    ok: true,
                    service: 'pancake-supabase-api',
                    runtime: 'supabase-edge',
                    commitSha: expected.edgeCommitSha,
                    edgeArtifactDigest: 'd'.repeat(64),
                    environmentReleaseSha: expected.edgeCommitSha,
                }
                : { commitSha: expected.frontendCommitSha, bundleDigest: expected.frontendBundleDigest },
        ))

        const result = await probeHostedReleaseProvenance({
            expected,
            edgeApiUrl: 'https://api.example.test',
            frontendUrl: 'https://app.example.test',
            fetchImpl: fetchImpl as typeof fetch,
        })

        expect(result.failures).toContain(`Edge edgeArtifactDigest ${'d'.repeat(64)} does not match ${'c'.repeat(64)}`)
    })

    it('binds every hosted surface to the pinned production identity', () => {
        const projectRef = 'ceeytbfmwsnzalxlkalc'
        const valid = {
            expectedProjectRef: projectRef,
            linkedProjectRef: projectRef,
            supabaseUrl: `https://${projectRef}.supabase.co`,
            edgeApiUrl: `https://${projectRef}.supabase.co/functions/v1/api`,
            frontendUrl: 'https://pancake.example.com',
            expectedFrontendHost: 'pancake.example.com',
        }
        expect(validateHostedTargetIdentity(valid)).toEqual([])
        expect(validateHostedTargetIdentity({ ...valid, linkedProjectRef: 'a'.repeat(20) })).toContain(
            'linked Supabase project does not match the pinned production project',
        )
        expect(validateHostedTargetIdentity({ ...valid, edgeApiUrl: 'https://staging.supabase.co/functions/v1/api' })).toContain(
            'Edge API URL does not match the pinned production project',
        )
        expect(validateHostedTargetIdentity({ ...valid, frontendUrl: 'https://preview.example.com' })).toContain(
            'frontend URL does not match the pinned production host',
        )
        expect(validateHostedTargetIdentity({ ...valid, frontendUrl: 'https://preview.example.com', allowCandidateFrontend: true })).toEqual([])
    })

    it('requires the positive Edge auth probe response contract', () => {
        expect(validInternalEdgeAuthProbe({
            status: 200,
            text: JSON.stringify({ ok: true, action: '__edge_auth_probe__' }),
        })).toBe(true)
        expect(validInternalEdgeAuthProbe({ status: 404, text: '{}' })).toBe(false)
        expect(validInternalEdgeAuthProbe({ status: 200, text: JSON.stringify({ ok: true }) })).toBe(false)
        expect(validInternalEdgeAuthProbe({ status: 200, text: 'not-json' })).toBe(false)
    })

    it('retains a BLOCKED hosted report when probes fail', async () => {
        const root = await mkdtemp(path.join(os.tmpdir(), 'pancake-hosted-provenance-'))
        const reportPath = path.join(root, 'report.md')
        const projectRef = 'ceeytbfmwsnzalxlkalc'
        try {
            const result = await runHostedReleaseProvenance({
                expected: {
                    frontendCommitSha: 'a'.repeat(40),
                    edgeCommitSha: 'a'.repeat(40),
                    frontendBundleDigest: 'b'.repeat(64),
                    edgeArtifactDigest: 'c'.repeat(64),
                },
                edgeApiUrl: `https://${projectRef}.supabase.co/functions/v1/api`,
                frontendUrl: 'https://pancake.example.com',
                target: {
                    expectedProjectRef: projectRef,
                    linkedProjectRef: projectRef,
                    supabaseUrl: `https://${projectRef}.supabase.co`,
                    edgeApiUrl: `https://${projectRef}.supabase.co/functions/v1/api`,
                    frontendUrl: 'https://pancake.example.com',
                    expectedFrontendHost: 'pancake.example.com',
                },
                fetchImpl: async () => { throw new Error('connection refused') },
                reportPath,
            })
            expect(result.failures).toEqual(expect.arrayContaining([
                expect.stringContaining('Edge probe failed'),
                expect.stringContaining('frontend probe failed'),
            ]))
            expect(await readFile(reportPath, 'utf8')).toContain('| Edge | BLOCKED |')
        } finally {
            await rm(root, { recursive: true, force: true })
        }
    })
})
