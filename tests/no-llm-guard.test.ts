import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { ROOT } from './source-guard'

// The deterministic engines must stay LLM-free: no model SDK may appear in the
// dependency manifests, lockfile, or engine source trees. Nothing is
// whitelisted — any match is a failure.
const identifiers: { name: string; pattern: RegExp }[] = [
    { name: 'openai', pattern: /openai/i },
    { name: 'anthropic / @anthropic-ai', pattern: /anthropic/i },
    { name: 'langchain', pattern: /langchain/i },
    { name: 'cohere', pattern: /\bcohere\b/i },
    { name: 'mistralai', pattern: /mistralai/i },
    { name: 'google generativeai', pattern: /generativeai/i },
    { name: 'google genai', pattern: /\bgenai\b/i },
    { name: 'ollama', pattern: /\bollama\b/i },
]

const manifestFiles = ['package.json', 'core/package.json', 'deno.lock']
const sourceDirs = ['core/src', 'lib', 'supabase/functions']
const skipDirs = new Set(['node_modules', '.git'])

function sourceFiles(dir: string): string[] {
    const files: string[] = []
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
            if (!skipDirs.has(entry.name)) files.push(...sourceFiles(path.join(dir, entry.name)))
        } else if (entry.isFile()) {
            files.push(path.join(dir, entry.name))
        }
    }
    return files
}

describe('no-LLM guard', () => {
    it('finds zero model-SDK identifiers in manifests, lockfile, and engine source trees', () => {
        const files = [
            ...manifestFiles.map((rel) => path.join(ROOT, rel)),
            ...sourceDirs.flatMap((dir) => sourceFiles(path.join(ROOT, dir))),
        ]

        const matches: string[] = []
        for (const file of files) {
            const content = readFileSync(file, 'utf8')
            for (const { name, pattern } of identifiers) {
                if (pattern.test(content)) matches.push(`${path.relative(ROOT, file)}: ${name}`)
            }
        }

        expect(matches).toEqual([])
        expect(files.length).toBeGreaterThan(100)
    })
})
