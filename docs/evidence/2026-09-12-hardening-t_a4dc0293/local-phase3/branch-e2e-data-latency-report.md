{
  "status": "PASS",
  "generatedAt": "2026-09-12T22:38:09.018Z",
  "endpoint": "http://127.0.0.1:54321",
  "runId": "20260912223611",
  "leagueId": "8a19c56f-d902-4e59-93cb-242831459575",
  "user": "pancake-e2e-20260912223611-1@example.com",
  "provenance": {
    "commitSha": "40d94a3887a334fef4269161ecc89666e4014d39",
    "bundleDigest": "b3501d2a7e5e9c3e5b91ec6486d9715fbb8c911d0bc2ed5b200e93da723a1c94",
    "runId": "local-40d94a3887a3-b3501d2a7e5e"
  },
  "schemaVersion": "20260912000002",
  "repositorySchemaVersion": "20260912000002",
  "budgets": {
    "dataRequestMs": 100,
    "workflowTotalMs": 1000,
    "samples": 3
  },
  "context": {
    "memberId": "fc49ebb7-78ba-4948-befb-0cc684600651",
    "seasonId": "8952d702-927f-4c53-99b5-ad1a090699e9",
    "matchupId": "6651d334-3d45-4912-aaaf-2674f0360334",
    "playerId": "c5d4faf2-9218-4891-8546-55335f90bde9",
    "auctionDraftId": "34250c79-20dd-472a-8854-63196836115e",
    "rookieDraftId": "ca9dba0e-7983-4155-ab8c-1c590cf7be0a"
  },
  "workflows": [
    {
      "id": "home-live-lineup",
      "status": "PASS",
      "totalMedianMs": 21.6,
      "steps": [
        {
          "workflowId": "home-live-lineup",
          "label": "current matchup row",
          "samples": 3,
          "medianMs": 11,
          "maxMs": 13.4,
          "rowCount": 1,
          "status": "PASS",
          "key": "current-matchup"
        },
        {
          "workflowId": "home-live-lineup",
          "label": "league week matchup rows",
          "samples": 3,
          "medianMs": 3.2,
          "maxMs": 3.6,
          "rowCount": 1,
          "status": "PASS",
          "key": "week-matchups"
        },
        {
          "workflowId": "home-live-lineup",
          "label": "my roster for lineup render",
          "samples": 3,
          "medianMs": 3.1,
          "maxMs": 3.2,
          "rowCount": 1,
          "status": "PASS",
          "key": "my-roster"
        },
        {
          "workflowId": "home-live-lineup",
          "label": "opponent roster for lineup render",
          "samples": 3,
          "medianMs": 2.5,
          "maxMs": 2.6,
          "rowCount": 0,
          "status": "PASS",
          "key": "opponent-roster"
        },
        {
          "workflowId": "home-live-lineup",
          "label": "today NBA games",
          "samples": 3,
          "medianMs": 1.8,
          "maxMs": 2.1,
          "rowCount": 0,
          "status": "PASS",
          "key": "today-games"
        }
      ]
    },
    {
      "id": "lineup-day-change",
      "status": "PASS",
      "totalMedianMs": 10.7,
      "steps": [
        {
          "workflowId": "lineup-day-change",
          "label": "lineup slot templates",
          "samples": 3,
          "medianMs": 4.7,
          "maxMs": 10.4,
          "rowCount": 10,
          "status": "PASS",
          "key": "slot-templates"
        },
        {
          "workflowId": "lineup-day-change",
          "label": "weekly lineup assignment rows",
          "samples": 3,
          "medianMs": 2.7,
          "maxMs": 4,
          "rowCount": 0,
          "status": "PASS",
          "key": "lineup-assignments"
        },
        {
          "workflowId": "lineup-day-change",
          "label": "same-day lock context games",
          "samples": 3,
          "medianMs": 3.3,
          "maxMs": 3.4,
          "rowCount": 0,
          "status": "PASS",
          "key": "lock-context-games"
        }
      ]
    },
    {
      "id": "player-search-filter",
      "status": "PASS",
      "totalMedianMs": 14.8,
      "steps": [
        {
          "workflowId": "player-search-filter",
          "label": "search_players first page RPC",
          "samples": 3,
          "medianMs": 10.3,
          "maxMs": 23.1,
          "rowCount": 20,
          "status": "PASS",
          "key": "search-page"
        },
        {
          "workflowId": "player-search-filter",
          "label": "availability owned players",
          "samples": 3,
          "medianMs": 2.4,
          "maxMs": 2.6,
          "rowCount": 1,
          "status": "PASS",
          "key": "owned-players"
        },
        {
          "workflowId": "player-search-filter",
          "label": "availability waiver players",
          "samples": 3,
          "medianMs": 2.1,
          "maxMs": 2.4,
          "rowCount": 0,
          "status": "PASS",
          "key": "waiver-players"
        }
      ]
    },
    {
      "id": "player-detail-open",
      "status": "PASS",
      "totalMedianMs": 20.5,
      "steps": [
        {
          "workflowId": "player-detail-open",
          "label": "player row",
          "samples": 3,
          "medianMs": 4.8,
          "maxMs": 9.3,
          "rowCount": 1,
          "status": "PASS",
          "key": "player"
        },
        {
          "workflowId": "player-detail-open",
          "label": "available seasons",
          "samples": 3,
          "medianMs": 2.3,
          "maxMs": 18.4,
          "rowCount": 0,
          "status": "PASS",
          "key": "seasons"
        },
        {
          "workflowId": "player-detail-open",
          "label": "season averages view",
          "samples": 3,
          "medianMs": 2.9,
          "maxMs": 3,
          "rowCount": 0,
          "status": "PASS",
          "key": "season-averages"
        },
        {
          "workflowId": "player-detail-open",
          "label": "game log first page",
          "samples": 3,
          "medianMs": 2,
          "maxMs": 2.6,
          "rowCount": 0,
          "status": "PASS",
          "key": "game-log"
        },
        {
          "workflowId": "player-detail-open",
          "label": "projection row RPC",
          "samples": 3,
          "medianMs": 8.5,
          "maxMs": 8.9,
          "rowCount": 0,
          "status": "PASS",
          "key": "projection"
        }
      ]
    },
    {
      "id": "roster-review-manage",
      "status": "PASS",
      "totalMedianMs": 13.4,
      "steps": [
        {
          "workflowId": "roster-review-manage",
          "label": "roster players with player rows",
          "samples": 3,
          "medianMs": 4.5,
          "maxMs": 10.1,
          "rowCount": 1,
          "status": "PASS",
          "key": "roster"
        },
        {
          "workflowId": "roster-review-manage",
          "label": "member draft picks",
          "samples": 3,
          "medianMs": 3.4,
          "maxMs": 3.6,
          "rowCount": 15,
          "status": "PASS",
          "key": "draft-picks"
        },
        {
          "workflowId": "roster-review-manage",
          "label": "my waiver claims",
          "samples": 3,
          "medianMs": 3.2,
          "maxMs": 3.6,
          "rowCount": 0,
          "status": "PASS",
          "key": "waiver-claims"
        },
        {
          "workflowId": "roster-review-manage",
          "label": "my waiver priority",
          "samples": 3,
          "medianMs": 2.3,
          "maxMs": 3,
          "rowCount": 0,
          "status": "PASS",
          "key": "waiver-priority"
        }
      ]
    },
    {
      "id": "waiver-add-claim",
      "status": "PASS",
      "totalMedianMs": 20.7,
      "steps": [
        {
          "workflowId": "waiver-add-claim",
          "label": "active waiver wire entries",
          "samples": 3,
          "medianMs": 13.4,
          "maxMs": 19.7,
          "rowCount": 0,
          "status": "PASS",
          "key": "waiver-wire"
        },
        {
          "workflowId": "waiver-add-claim",
          "label": "member transaction state",
          "samples": 3,
          "medianMs": 5.3,
          "maxMs": 5.4,
          "rowCount": 1,
          "status": "PASS",
          "key": "transaction-state"
        },
        {
          "workflowId": "waiver-add-claim",
          "label": "claim modal roster choices",
          "samples": 3,
          "medianMs": 2,
          "maxMs": 2.2,
          "rowCount": 1,
          "status": "PASS",
          "key": "roster-choices"
        }
      ]
    },
    {
      "id": "trade-review-act",
      "status": "PASS",
      "totalMedianMs": 11.8,
      "steps": [
        {
          "workflowId": "trade-review-act",
          "label": "trades involving member",
          "samples": 3,
          "medianMs": 5.2,
          "maxMs": 11.8,
          "rowCount": 0,
          "status": "PASS",
          "key": "trades"
        },
        {
          "workflowId": "trade-review-act",
          "label": "tradeable roster players",
          "samples": 3,
          "medianMs": 3.9,
          "maxMs": 4.6,
          "rowCount": 1,
          "status": "PASS",
          "key": "roster-assets"
        },
        {
          "workflowId": "trade-review-act",
          "label": "tradeable draft picks",
          "samples": 3,
          "medianMs": 2.7,
          "maxMs": 3.5,
          "rowCount": 15,
          "status": "PASS",
          "key": "pick-assets"
        }
      ]
    },
    {
      "id": "auction-draft-room",
      "status": "PASS",
      "totalMedianMs": 14.8,
      "steps": [
        {
          "workflowId": "auction-draft-room",
          "label": "auction draft row",
          "samples": 3,
          "medianMs": 5.5,
          "maxMs": 9.7,
          "rowCount": 1,
          "status": "PASS",
          "key": "draft"
        },
        {
          "workflowId": "auction-draft-room",
          "label": "auction draft order",
          "samples": 3,
          "medianMs": 3.7,
          "maxMs": 5.1,
          "rowCount": 10,
          "status": "PASS",
          "key": "order"
        },
        {
          "workflowId": "auction-draft-room",
          "label": "auction budgets",
          "samples": 3,
          "medianMs": 2.9,
          "maxMs": 5.1,
          "rowCount": 10,
          "status": "PASS",
          "key": "budgets"
        },
        {
          "workflowId": "auction-draft-room",
          "label": "auction nominations",
          "samples": 3,
          "medianMs": 2.7,
          "maxMs": 3.2,
          "rowCount": 0,
          "status": "PASS",
          "key": "nominations"
        }
      ]
    },
    {
      "id": "rookie-draft-room",
      "status": "PASS",
      "totalMedianMs": 12.1,
      "steps": [
        {
          "workflowId": "rookie-draft-room",
          "label": "rookie draft row",
          "samples": 3,
          "medianMs": 4,
          "maxMs": 12.2,
          "rowCount": 1,
          "status": "PASS",
          "key": "draft"
        },
        {
          "workflowId": "rookie-draft-room",
          "label": "snake pick board",
          "samples": 3,
          "medianMs": 4.9,
          "maxMs": 5.5,
          "rowCount": 30,
          "status": "PASS",
          "key": "pick-board"
        },
        {
          "workflowId": "rookie-draft-room",
          "label": "rookie player board",
          "samples": 3,
          "medianMs": 3.2,
          "maxMs": 3.5,
          "rowCount": 100,
          "status": "PASS",
          "key": "player-board"
        }
      ]
    },
    {
      "id": "dynasty-hub",
      "status": "PASS",
      "totalMedianMs": 11.2,
      "steps": [
        {
          "workflowId": "dynasty-hub",
          "label": "dynasty rankings first page",
          "samples": 3,
          "medianMs": 5.1,
          "maxMs": 10.3,
          "rowCount": 0,
          "status": "PASS",
          "key": "rankings"
        },
        {
          "workflowId": "dynasty-hub",
          "label": "dynasty news first page",
          "samples": 3,
          "medianMs": 2.9,
          "maxMs": 3.3,
          "rowCount": 0,
          "status": "PASS",
          "key": "news"
        },
        {
          "workflowId": "dynasty-hub",
          "label": "my roster news scope",
          "samples": 3,
          "medianMs": 3.2,
          "maxMs": 3.3,
          "rowCount": 1,
          "status": "PASS",
          "key": "roster-news-scope"
        }
      ]
    }
  ],
  "failures": []
}
