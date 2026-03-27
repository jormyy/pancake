export const CONFIG = {
    /** Fastify server port */
    PORT: parseInt(process.env.PORT ?? '3000'),

    /** Max rows per Supabase upsert/insert call */
    UPSERT_CHUNK_SIZE: 500,

    /** Auction draft: seconds before a nomination expires */
    NOMINATION_COUNTDOWN_SECONDS: 30,

    /** How often (ms) to check for expired auction nominations */
    NOMINATION_POLL_INTERVAL_MS: 10_000,

    /** Minimum valid bid in an auction draft */
    MIN_BID: 1,

    /** Number of rounds in a rookie snake draft */
    ROOKIE_DRAFT_ROUNDS: 3,

    /** Hours a dropped player stays on waivers before clearing */
    WAIVER_CLEARANCE_HOURS: 48,

    /** Rolling average window (weeks) for projection calculation */
    PROJECTION_LOOKBACK_WEEKS: 4,

    /** Timezone for all cron jobs */
    CRON_TIMEZONE: 'America/New_York',
} as const
