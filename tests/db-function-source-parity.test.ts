import { describe, expect, it } from 'vitest'

describe('canonical database function sources', () => {
    it('match the latest Supabase migration definitions', async () => {
        const { checkFunctionSources } = await import('../scripts/check-db-function-sources.mjs')

        expect(await checkFunctionSources()).toEqual([])
    })

    it('excludes functions whose latest migration event is a drop', async () => {
        const { latestFunctionDefinitions, latestFunctionDefinition } = await import('../scripts/check-db-function-sources.mjs')

        expect((await latestFunctionDefinitions()).has('public.is_username_available')).toBe(false)
        await expect(latestFunctionDefinition('public', 'is_username_available')).rejects.toThrow(/dropped after its latest definition/)
    })

    it('parses lifecycle DDL without treating comments, strings, or bodies as declarations', async () => {
        const { functionLifecycleEventsInSource } = await import('../scripts/check-db-function-sources.mjs')
        const events = functionLifecycleEventsInSource(`
            /* CREATE FUNCTION public.block_comment() RETURNS void AS $$ BEGIN END $$ LANGUAGE plpgsql; */
            CREATE FUNCTION "Custom"."QuotedName"(value text) RETURNS void AS $body$
            BEGIN
              PERFORM 'CREATE FUNCTION public.body_text()';
              -- DROP FUNCTION public.body_comment();
            END
            $body$ LANGUAGE plpgsql;
            CREATE OR REPLACE FUNCTION public.repeated(value int) RETURNS int AS $$ SELECT value $$ LANGUAGE sql;
            CREATE OR REPLACE FUNCTION public.repeated(value text) RETURNS text AS $$ SELECT value $$ LANGUAGE sql;
            DROP FUNCTION IF EXISTS "Custom"."QuotedName"(text);
        `)

        expect(events.map(({ type, key, identityKey }) => ({ type, key, identityKey }))).toEqual([
            { type: 'create', key: 'Custom.QuotedName', identityKey: 'Custom.QuotedName(text)' },
            { type: 'create', key: 'public.repeated', identityKey: 'public.repeated(integer)' },
            { type: 'create', key: 'public.repeated', identityKey: 'public.repeated(text)' },
            { type: 'drop', key: 'Custom.QuotedName', identityKey: 'Custom.QuotedName(text)' },
        ])
    })

    it('keeps overload identities distinct through canonical paths and parity checks', async () => {
        const {
            checkFunctionSourceText,
            latestFunctionDefinitionsInSource,
            sourcePathForFunctionKey,
        } = await import('../scripts/check-db-function-sources.mjs')
        const integerDefinition = 'CREATE FUNCTION public.repeated(value int) RETURNS int AS $$ SELECT value $$ LANGUAGE sql;'
        const textDefinition = 'CREATE FUNCTION public.repeated(value text) RETURNS text AS $$ SELECT value $$ LANGUAGE sql;'
        const definitions = latestFunctionDefinitionsInSource(`${integerDefinition}\n${textDefinition}`)

        expect([...definitions.keys()]).toEqual(['public.repeated(integer)', 'public.repeated(text)'])
        expect(sourcePathForFunctionKey('public.repeated(integer)')).toMatch(/public\/repeated__integer\.sql$/)
        expect(sourcePathForFunctionKey('public.repeated(text)')).toMatch(/public\/repeated__text\.sql$/)
        expect(checkFunctionSourceText('public.repeated(integer)', definitions.get('public.repeated(integer)')!, integerDefinition)).toEqual([])
        expect(checkFunctionSourceText('public.repeated(text)', definitions.get('public.repeated(text)')!, textDefinition)).toEqual([])
    })
})
