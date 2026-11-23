import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { dbSourceRuleFailures } from '../scripts/check-db-function-sources.mjs'

const directories: string[] = []
afterEach(async () => Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))))

const rules = async (files: Record<string, string>) => {
    const directory = await mkdtemp(path.join(tmpdir(), 'db-source-rules-'))
    directories.push(directory)
    await Promise.all(Object.entries(files).map(([name, source]) => writeFile(path.join(directory, name), source)))
    return directory
}

describe('database source rules', () => {
    it('reports every failure each rule module returns, prefixed by its file', async () => {
        const directory = await rules({
            'definer-search-path.mjs': `export default ({ definitions }) => [...definitions].filter(([, sql]) => /SECURITY DEFINER/.test(sql) && !/SET search_path/.test(sql)).map(([key]) => key + ' must set search_path')`,
            'notes.md': 'not a rule',
        })
        const definitions = new Map([
            ['public.unsafe', 'CREATE FUNCTION public.unsafe() RETURNS void LANGUAGE sql SECURITY DEFINER AS $$ select $$'],
            ['public.safe', "CREATE FUNCTION public.safe() RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $$ select $$"],
        ])

        expect(await dbSourceRuleFailures(definitions, directory)).toEqual(['definer-search-path.mjs: public.unsafe must set search_path'])
    })

    it('passes when the rule directory does not exist', async () => {
        expect(await dbSourceRuleFailures(new Map(), path.join(tmpdir(), 'pancake-no-db-source-rules'))).toEqual([])
    })
})

const definition = (body: string) => `CREATE OR REPLACE FUNCTION private.job(p_now timestamptz DEFAULT now())
RETURNS void LANGUAGE plpgsql AS $$
DECLARE v_now timestamp := timezone('America/New_York', p_now); v_min integer:=extract(minute FROM p_now)::int;
BEGIN
${body}
END;
$$;`

describe('exact-time cron gate rule', () => {
    it.each([
        ['an hour inequality', 'IF EXTRACT(HOUR FROM v_now)::int <> 9 THEN RETURN; END IF;'],
        ['an hour and minute equality', 'IF EXTRACT(HOUR FROM v_now)::int = p_hour\n AND EXTRACT(MINUTE FROM v_now)::int = p_minute THEN RETURN; END IF;'],
        ['a minute modulo through a variable', 'IF v_min%15=0 THEN RETURN; END IF;'],
        ['a minute equality through a variable', 'IF v_min=17 THEN RETURN; END IF;'],
        ['a nested minute modulo', "IF (extract(minute FROM (p_now AT TIME ZONE 'UTC'))::int)%5=0 THEN RETURN; END IF;"],
        ['a weekday comparison', 'IF 1 = extract(isodow FROM v_now) THEN RETURN; END IF;'],
        ['a date_part equality', "IF date_part('hour', v_now) = 8 THEN RETURN; END IF;"],
    ])('rejects %s and names the fix', async (_label, body) => {
        const { default: noExactTimeGates } = await import('../scripts/db-source-rules/no-exact-time-gates.mjs')

        const failures = noExactTimeGates({ definitions: new Map([['private.job', definition(body)]]) })

        expect(failures.length).toBeGreaterThan(0)
        expect(failures[0]).toMatch(/^private\.job line \d+ .*exact-time cron gate; add a private\.work_kinds row with a cadence$/)
    })

    it.each([
        ['a due-since time check', 'IF v_now::time < make_time(9,0,0) THEN RETURN; END IF;'],
        ['a minute threshold', 'IF v_min>=17 THEN RETURN; END IF;'],
        ['weekday arithmetic', "PERFORM substring('SMTWTFS', extract(dow FROM v_now)::integer + 1, 1);"],
        ['a bucket key', "PERFORM (extract(minute FROM p_now)::int/15)::text;"],
        ['a gate inside a comment or string', "-- IF v_min%15=0\nPERFORM 'extract(minute FROM now())=0';"],
    ])('accepts %s', async (_label, body) => {
        const { default: noExactTimeGates } = await import('../scripts/db-source-rules/no-exact-time-gates.mjs')

        expect(noExactTimeGates({ definitions: new Map([['private.job', definition(body)]]) })).toEqual([])
    })
})
