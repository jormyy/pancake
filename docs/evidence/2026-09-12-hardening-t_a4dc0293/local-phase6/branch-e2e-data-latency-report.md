{
  "status": "PASS",
  "generatedAt": "2026-09-13T00:34:53.631Z",
  "endpoint": "http://127.0.0.1:54321",
  "runId": "20260913003254",
  "leagueId": "e8a0c50e-f5e9-4675-ae3d-db5a832338a7",
  "user": "pancake-e2e-20260913003254-1@example.com",
  "provenance": {
    "commitSha": "c34c33cc7df12aa1ea16a35d0a6ef44e1decb2b8",
    "bundleDigest": "55a9a8d45baaf69314c052a9070f1dac86962b48e1d53a1292f158645ba77d35",
    "runId": "local-c34c33cc7df1-55a9a8d45baa"
  },
  "schemaVersion": "20260912000003",
  "repositorySchemaVersion": "20260912000003",
  "budgets": {
    "dataRequestMs": 100,
    "workflowTotalMs": 1000,
    "samples": 3
  },
  "context": {
    "memberId": "2a25346f-53ae-46ff-83f7-eeb2ef7f2ae7",
    "seasonId": "24fb8de3-7a69-4654-b662-ae62806ffc92",
    "matchupId": "28ab48ab-6034-471a-b1c0-87c43d8c4aef",
    "playerId": "4a608e74-62ee-4cc6-b7d4-b22b72644ba4",
    "auctionDraftId": "110be9c9-9a40-4d6c-b9d7-f64e0c62ef9f",
    "rookieDraftId": "f11206cc-e05e-4191-be66-5c9cba119dc8"
  },
  "workflows": [
    {
      "id": "home-live-lineup",
      "status": "PASS",
      "totalMedianMs": 11.1,
      "steps": [
        {
          "workflowId": "home-live-lineup",
          "label": "current matchup row",
          "samples": 3,
          "medianMs": 2.7,
          "maxMs": 34,
          "rowCount": 1,
          "status": "PASS",
          "key": "current-matchup"
        },
        {
          "workflowId": "home-live-lineup",
          "label": "league week matchup rows",
          "samples": 3,
          "medianMs": 2.8,
          "maxMs": 6.6,
          "rowCount": 1,
          "status": "PASS",
          "key": "week-matchups"
        },
        {
          "workflowId": "home-live-lineup",
          "label": "my roster for lineup render",
          "samples": 3,
          "medianMs": 2.1,
          "maxMs": 3,
          "rowCount": 1,
          "status": "PASS",
          "key": "my-roster"
        },
        {
          "workflowId": "home-live-lineup",
          "label": "opponent roster for lineup render",
          "samples": 3,
          "medianMs": 1.9,
          "maxMs": 2,
          "rowCount": 0,
          "status": "PASS",
          "key": "opponent-roster"
        },
        {
          "workflowId": "home-live-lineup",
          "label": "today NBA games",
          "samples": 3,
          "medianMs": 1.6,
          "maxMs": 1.6,
          "rowCount": 0,
          "status": "PASS",
          "key": "today-games"
        }
      ]
    },
    {
      "id": "lineup-day-change",
      "status": "PASS",
      "totalMedianMs": 13.1,
      "steps": [
        {
          "workflowId": "lineup-day-change",
          "label": "lineup slot templates",
          "samples": 3,
          "medianMs": 7,
          "maxMs": 9.2,
          "rowCount": 10,
          "status": "PASS",
          "key": "slot-templates"
        },
        {
          "workflowId": "lineup-day-change",
          "label": "weekly lineup assignment rows",
          "samples": 3,
          "medianMs": 3.5,
          "maxMs": 4,
          "rowCount": 0,
          "status": "PASS",
          "key": "lineup-assignments"
        },
        {
          "workflowId": "lineup-day-change",
          "label": "same-day lock context games",
          "samples": 3,
          "medianMs": 2.6,
          "maxMs": 3.1,
          "rowCount": 0,
          "status": "PASS",
          "key": "lock-context-games"
        }
      ]
    },
    {
      "id": "player-search-filter",
      "status": "PASS",
      "totalMedianMs": 16.9,
      "steps": [
        {
          "workflowId": "player-search-filter",
          "label": "search_players first page RPC",
          "samples": 3,
          "medianMs": 12.7,
          "maxMs": 19.5,
          "rowCount": 20,
          "status": "PASS",
          "key": "search-page"
        },
        {
          "workflowId": "player-search-filter",
          "label": "availability owned players",
          "samples": 3,
          "medianMs": 2.2,
          "maxMs": 4.8,
          "rowCount": 1,
          "status": "PASS",
          "key": "owned-players"
        },
        {
          "workflowId": "player-search-filter",
          "label": "availability waiver players",
          "samples": 3,
          "medianMs": 2,
          "maxMs": 2.2,
          "rowCount": 0,
          "status": "PASS",
          "key": "waiver-players"
        }
      ]
    },
    {
      "id": "player-detail-open",
      "status": "PASS",
      "totalMedianMs": 25,
      "steps": [
        {
          "workflowId": "player-detail-open",
          "label": "player row",
          "samples": 3,
          "medianMs": 9.7,
          "maxMs": 23,
          "rowCount": 1,
          "status": "PASS",
          "key": "player"
        },
        {
          "workflowId": "player-detail-open",
          "label": "available seasons",
          "samples": 3,
          "medianMs": 2.5,
          "maxMs": 2.9,
          "rowCount": 0,
          "status": "PASS",
          "key": "seasons"
        },
        {
          "workflowId": "player-detail-open",
          "label": "season averages view",
          "samples": 3,
          "medianMs": 2,
          "maxMs": 5.1,
          "rowCount": 0,
          "status": "PASS",
          "key": "season-averages"
        },
        {
          "workflowId": "player-detail-open",
          "label": "game log first page",
          "samples": 3,
          "medianMs": 2.1,
          "maxMs": 2.7,
          "rowCount": 0,
          "status": "PASS",
          "key": "game-log"
        },
        {
          "workflowId": "player-detail-open",
          "label": "projection row RPC",
          "samples": 3,
          "medianMs": 8.7,
          "maxMs": 8.7,
          "rowCount": 0,
          "status": "PASS",
          "key": "projection"
        }
      ]
    },
    {
      "id": "roster-review-manage",
      "status": "PASS",
      "totalMedianMs": 17.2,
      "steps": [
        {
          "workflowId": "roster-review-manage",
          "label": "roster players with player rows",
          "samples": 3,
          "medianMs": 10.1,
          "maxMs": 28.2,
          "rowCount": 1,
          "status": "PASS",
          "key": "roster"
        },
        {
          "workflowId": "roster-review-manage",
          "label": "member draft picks",
          "samples": 3,
          "medianMs": 2.9,
          "maxMs": 8.1,
          "rowCount": 15,
          "status": "PASS",
          "key": "draft-picks"
        },
        {
          "workflowId": "roster-review-manage",
          "label": "my waiver claims",
          "samples": 3,
          "medianMs": 2.6,
          "maxMs": 3.2,
          "rowCount": 0,
          "status": "PASS",
          "key": "waiver-claims"
        },
        {
          "workflowId": "roster-review-manage",
          "label": "my waiver priority",
          "samples": 3,
          "medianMs": 1.6,
          "maxMs": 1.7,
          "rowCount": 0,
          "status": "PASS",
          "key": "waiver-priority"
        }
      ]
    },
    {
      "id": "waiver-add-claim",
      "status": "PASS",
      "totalMedianMs": 10,
      "steps": [
        {
          "workflowId": "waiver-add-claim",
          "label": "active waiver wire entries",
          "samples": 3,
          "medianMs": 4,
          "maxMs": 10.4,
          "rowCount": 0,
          "status": "PASS",
          "key": "waiver-wire"
        },
        {
          "workflowId": "waiver-add-claim",
          "label": "member transaction state",
          "samples": 3,
          "medianMs": 3.7,
          "maxMs": 5,
          "rowCount": 1,
          "status": "PASS",
          "key": "transaction-state"
        },
        {
          "workflowId": "waiver-add-claim",
          "label": "claim modal roster choices",
          "samples": 3,
          "medianMs": 2.3,
          "maxMs": 2.6,
          "rowCount": 1,
          "status": "PASS",
          "key": "roster-choices"
        }
      ]
    },
    {
      "id": "trade-review-act",
      "status": "PASS",
      "totalMedianMs": 11.7,
      "steps": [
        {
          "workflowId": "trade-review-act",
          "label": "trades involving member",
          "samples": 3,
          "medianMs": 5.4,
          "maxMs": 9.8,
          "rowCount": 0,
          "status": "PASS",
          "key": "trades"
        },
        {
          "workflowId": "trade-review-act",
          "label": "tradeable roster players",
          "samples": 3,
          "medianMs": 3.6,
          "maxMs": 3.7,
          "rowCount": 1,
          "status": "PASS",
          "key": "roster-assets"
        },
        {
          "workflowId": "trade-review-act",
          "label": "tradeable draft picks",
          "samples": 3,
          "medianMs": 2.7,
          "maxMs": 3.1,
          "rowCount": 15,
          "status": "PASS",
          "key": "pick-assets"
        }
      ]
    },
    {
      "id": "auction-draft-room",
      "status": "PASS",
      "totalMedianMs": 13.5,
      "steps": [
        {
          "workflowId": "auction-draft-room",
          "label": "auction draft row",
          "samples": 3,
          "medianMs": 4.1,
          "maxMs": 10.9,
          "rowCount": 1,
          "status": "PASS",
          "key": "draft"
        },
        {
          "workflowId": "auction-draft-room",
          "label": "auction draft order",
          "samples": 3,
          "medianMs": 3.5,
          "maxMs": 5,
          "rowCount": 10,
          "status": "PASS",
          "key": "order"
        },
        {
          "workflowId": "auction-draft-room",
          "label": "auction budgets",
          "samples": 3,
          "medianMs": 2.9,
          "maxMs": 4.5,
          "rowCount": 10,
          "status": "PASS",
          "key": "budgets"
        },
        {
          "workflowId": "auction-draft-room",
          "label": "auction nominations",
          "samples": 3,
          "medianMs": 3,
          "maxMs": 6.1,
          "rowCount": 0,
          "status": "PASS",
          "key": "nominations"
        }
      ]
    },
    {
      "id": "rookie-draft-room",
      "status": "PASS",
      "totalMedianMs": 8.3,
      "steps": [
        {
          "workflowId": "rookie-draft-room",
          "label": "rookie draft row",
          "samples": 3,
          "medianMs": 2.9,
          "maxMs": 30.9,
          "rowCount": 1,
          "status": "PASS",
          "key": "draft"
        },
        {
          "workflowId": "rookie-draft-room",
          "label": "snake pick board",
          "samples": 3,
          "medianMs": 3.3,
          "maxMs": 6.4,
          "rowCount": 30,
          "status": "PASS",
          "key": "pick-board"
        },
        {
          "workflowId": "rookie-draft-room",
          "label": "rookie player board",
          "samples": 3,
          "medianMs": 2.1,
          "maxMs": 2.7,
          "rowCount": 100,
          "status": "PASS",
          "key": "player-board"
        }
      ]
    },
    {
      "id": "dynasty-hub",
      "status": "PASS",
      "totalMedianMs": 11,
      "steps": [
        {
          "workflowId": "dynasty-hub",
          "label": "dynasty rankings first page",
          "samples": 3,
          "medianMs": 5.7,
          "maxMs": 14.7,
          "rowCount": 51,
          "status": "PASS",
          "key": "rankings"
        },
        {
          "workflowId": "dynasty-hub",
          "label": "dynasty news first page",
          "samples": 3,
          "medianMs": 2.4,
          "maxMs": 2.9,
          "rowCount": 0,
          "status": "PASS",
          "key": "news"
        },
        {
          "workflowId": "dynasty-hub",
          "label": "my roster news scope",
          "samples": 3,
          "medianMs": 2.9,
          "maxMs": 3.4,
          "rowCount": 1,
          "status": "PASS",
          "key": "roster-news-scope"
        }
      ]
    }
  ],
  "failures": []
}
