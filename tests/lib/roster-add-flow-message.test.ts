import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

// addFreeAgentOrRequestDrop decides to open the drop picker by matching the
// server's message. Pin both halves so a reworded SQL message cannot turn the
// drop-picker flow into a generic alert without a test going red.
describe('roster-full error contract', () => {
    it('the RPC message and the client match on the same substring', async () => {
        const sql = await readFile('supabase/sql/functions/by-name/public/add_free_agent_atomic.sql', 'utf8')
        const client = await readFile('lib/roster-add-flow.ts', 'utf8')
        expect(sql).toContain("RAISE EXCEPTION 'Your active roster is full (% players).'")
        expect(client).toContain("getErrorMessage(error)?.includes('full')")
    })
})
