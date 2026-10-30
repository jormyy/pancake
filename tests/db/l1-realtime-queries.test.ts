import { expect, it } from 'vitest'
import { realtimeQueryKind } from './l1-realtime-queries.mjs'

it.each([
    ['SELECT wal->>$5 AS type FROM realtime.list_changes($1,$2,$3,$4)', { realtime: true, walPoll: true, authorize: false }],
    ['SELECT * FROM pg_publication_tables WHERE pubname=$1', { realtime: true, catalog: true }],
    ['SELECT m0."id",m0."topic" FROM "realtime"."messages" AS m0 WHERE ((m0."topic"=$1) AND m0."id"=ANY($2))', { realtime: true, authorize: true, authorizationContext: false }],
    ['INSERT INTO "realtime"."messages" ("topic","extension") VALUES ($1,$2) RETURNING *', { realtime: true, authorize: false }],
    ["SELECT set_config('role',$1,true),set_config('realtime.topic',$2,true)", { realtime: true, authorize: false, authorizationContext: true }],
    ["SELECT set_config('request.jwt.claims',$1,true)", { realtime: false, authorize: false, authorizationContext: false }],
    ['SELECT realtime.authorize($1)', { realtime: true, authorize: true }],
])('classifies the recorded query %s', (query, expected) => {
    expect(realtimeQueryKind(query)).toMatchObject(expected)
})
