import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const migration = (version: string) => readFileSync(
    path.join(process.cwd(), 'supabase/migrations', version),
    'utf8',
)

const rollingTradeContract = (producer: string, consumer: string, canonical: string) =>
    producer.includes('CREATE TRIGGER seed_legacy_standard_trade_routes') &&
    producer.includes('CREATE TRIGGER route_legacy_standard_trade_item') &&
    !producer.includes('DROP FUNCTION IF EXISTS public.accept_trade_atomic') &&
    consumer.indexOf('INSERT INTO public.trade_participants') >= 0 &&
    consumer.indexOf('INSERT INTO public.trade_participants') <
        consumer.indexOf('DROP FUNCTION IF EXISTS public.accept_trade_atomic') &&
    canonical.indexOf('DROP TRIGGER IF EXISTS seed_legacy_standard_trade_routes') >= 0 &&
    canonical.indexOf('DROP TRIGGER IF EXISTS seed_legacy_standard_trade_routes') <
        canonical.indexOf('CREATE OR REPLACE FUNCTION private.create_trade_offer')

describe('rolling trade migration boundaries', () => {
    it('keeps the producer compatible before backfill and switches consumers atomically', () => {
        const producer = migration('20260709100014_trade_participant_acceptance.sql')
        const consumer = migration('20260709100015_trade_offer_entrypoints.sql')
        const canonical = migration('20260709100025_trade_page_refs_and_route_fks.sql')
        expect(rollingTradeContract(producer, consumer, canonical)).toBe(true)

        expect(rollingTradeContract(
            producer.replace('CREATE TRIGGER seed_legacy_standard_trade_routes', 'CREATE TRIGGER missing_seed'),
            consumer,
            canonical,
        )).toBe(false)
        expect(rollingTradeContract(
            producer,
            consumer
                .replace('DROP FUNCTION IF EXISTS public.accept_trade_atomic(uuid, uuid, uuid[]);', '')
                .replace(
                    "SET statement_timeout = '2min';",
                    "SET statement_timeout = '2min';\n" +
                    'DROP FUNCTION IF EXISTS public.accept_trade_atomic(uuid, uuid, uuid[]);',
                ),
            canonical,
        )).toBe(false)
        expect(rollingTradeContract(
            producer,
            consumer,
            canonical.replace(
                'DROP TRIGGER IF EXISTS seed_legacy_standard_trade_routes ON public.trades;',
                '',
            ),
        )).toBe(false)
    })
})
