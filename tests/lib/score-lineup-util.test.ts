import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

type Candidate = { points: number; eligible_positions: string[] }
type Solver = (candidates: Candidate[], slots: string[]) => number

function loadSolver(path: string): { solve: Solver; allowed: Record<string, string[]> } {
    const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true)
    const declarations = source.statements.filter((node) => (
        ts.isFunctionDeclaration(node) && ['canPlayStarterSlot', 'bestLineupPointsForDate'].includes(node.name?.text ?? '')
    ) || (ts.isVariableStatement(node) && node.declarationList.declarations.some((declaration) => (
        ts.isIdentifier(declaration.name) && declaration.name.text === 'SLOT_ALLOWED_POSITIONS'
    ))))
    const code = ts.transpileModule(declarations.map((node) => node.getText(source).replace(/^export /, '')).join('\n'), {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    }).outputText
    return runInNewContext(`${code}\n({ solve: bestLineupPointsForDate, allowed: SLOT_ALLOWED_POSITIONS })`)
}

const canonical = loadSolver('supabase/shared-src/sync/scoreLineups.ts')
const generated = loadSolver('supabase/functions/_shared/scoreLineups.ts')

// Preserve the original exhaustive recurrence as the independent numeric oracle.
const original: Solver = (candidates, slots) => {
    const memo = new Map<string, number>()
    function visit(slot: number, used: bigint): number {
        if (slot >= slots.length) return 0
        const key = `${slot}:${used.toString()}`
        const cached = memo.get(key)
        if (cached != null) return cached
        let best = visit(slot + 1, used)
        for (let index = 0; index < candidates.length; index += 1) {
            const bit = 1n << BigInt(index)
            if ((used & bit) !== 0n) continue
            const candidate = candidates[index]
            if (!candidate.eligible_positions.some((position) => canonical.allowed[slots[slot]]?.includes(position))) continue
            best = Math.max(best, candidate.points + visit(slot + 1, used | bit))
        }
        memo.set(key, best)
        return best
    }
    return visit(0, 0n)
}

function compare(candidates: Candidate[], slots: string[]) {
    const before = structuredClone(candidates)
    const references = [...candidates]
    const expected = original(candidates, slots)
    expect(canonical.solve(candidates, slots)).toBe(expected)
    expect(generated.solve(candidates, slots)).toBe(expected)
    expect(candidates).toEqual(before)
    candidates.forEach((candidate, index) => expect(candidate).toBe(references[index]))
}

const player = (points: number, eligible_positions = ['PG']): Candidate => ({ points, eligible_positions })

describe('all-UTIL maximum scoring preserves the original DFS', () => {
    it('keeps exact arithmetic across slots, ties, fractions, signs and finite overflow', () => {
        const values = [0, -0, -9, 0.005, 0.015, 0.1, 0.2, 1 / 3, 2 / 3, 2 ** 53, Number.MAX_VALUE]
        for (const value of values) {
            const candidates = [player(value), player(value), player(0.1), player(0.2), player(-1), player(99, [])]
            for (let count = 0; count <= 4; count += 1) compare(candidates, Array(count).fill('UTIL'))
        }
        compare([player(-3), player(-1), player(0)], ['UTIL', 'UTIL'])
        compare([], ['UTIL'])
    })

    it('preserves eligibility, duplicate entries and mixed/unknown/nonfinite paths', () => {
        const duplicate = player(17, ['PG', 'SG'])
        const candidates = [duplicate, duplicate, player(99, []), player(88, ['UNKNOWN']), player(4, ['C'])]
        for (const slots of [['UTIL'], ['UTIL', 'UTIL'], ['PG', 'UTIL'], ['UNKNOWN'], ['C', 'SG']]) compare(candidates, slots)
        for (const value of [NaN, Infinity, -Infinity]) compare([player(value), player(7), player(3)], ['UTIL', 'UTIL'])
        compare([player(4)], ['UTIL', 'UTIL'])
        compare([player(4), player(5)], ['UTIL', 'UTIL'])
    })

    it('preserves distinct entries above the Number mask boundary', () => {
        const candidates = Array.from({ length: 64 }, (_, index) => player(index + 1))
        compare(candidates, ['UTIL'])
        compare(candidates, ['UTIL', 'UTIL'])
        compare(candidates, ['PG', 'UTIL'])
    })

    it('matches deterministic generated domains without a tolerance or sum shortcut', () => {
        let seed = 8301
        const random = (bound: number) => {
            seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
            return seed % bound
        }
        const points = [-100, -0.1, 0, 0.005, 0.015, 0.1, 1 / 3, 7, 7, 100, 2 ** 53, Number.MAX_VALUE]
        const positions = [[], ['PG'], ['SG', 'C'], ['SF', 'PF'], ['INVALID']]
        for (let sample = 0; sample < 400; sample += 1) {
            const candidates = Array.from({ length: random(8) }, () => player(points[random(points.length)], positions[random(positions.length)]))
            const slots = Array.from({ length: random(5) }, () => sample % 3 ? 'UTIL' : ['UTIL', 'PG', 'C', 'UNKNOWN'][random(4)])
            compare(candidates, slots)
        }
    })

    it('distinguishes illegal eligibility and reassociated sums from the required result', () => {
        const legal = [player(10), player(20), player(1000, [])]
        expect(original(legal, ['UTIL', 'UTIL'])).toBe(30)
        expect(original(legal, ['UTIL', 'UTIL'])).not.toBe(1020)
        const cancellation = [player(2 ** 53), player(1), player(1)]
        expect(original(cancellation, ['UTIL', 'UTIL', 'UTIL'])).toBe(2 ** 53 + 2)
        expect(original(cancellation, ['UTIL', 'UTIL', 'UTIL'])).not.toBe(cancellation.reduce((sum, candidate) => sum + candidate.points, 0))
        expect(original(legal, ['UTIL', 'UTIL'])).not.toBe(original(legal.slice(1), ['UTIL', 'UTIL']))
    })
})
