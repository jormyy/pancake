{
  "status": "PASS",
  "generatedAt": "2026-09-13T00:02:59.838Z",
  "endpoint": "http://127.0.0.1:54321",
  "runId": "20260912235936",
  "leagueId": "28ff7298-e459-4237-923f-0f663a0074cf",
  "user": "pancake-e2e-20260912235936-1@example.com",
  "provenance": {
    "commitSha": "09676e4bd048eff9a5ad4b139f0f2a405aeaaf5b",
    "bundleDigest": "26d386ac3a09912812e91b1a335a476fa651551221e3137a1916473755fae0d4",
    "runId": "local-09676e4bd048-26d386ac3a09"
  },
  "schemaVersion": "20260912000003",
  "repositorySchemaVersion": "20260912000003",
  "budgets": {
    "dataRequestMs": 100,
    "workflowTotalMs": 1000,
    "samples": 3
  },
  "context": {
    "memberId": "a1c7081f-a9ad-4692-8736-fd77ce344c0b",
    "seasonId": "a4558fb6-d10e-4ce6-999b-12ef8a0b2bfb",
    "matchupId": "98ceb7f6-9d63-49a6-b5f6-1c6cf16deb5a",
    "playerId": "45c6e877-3236-4585-b85b-080fa95b53e8",
    "auctionDraftId": "ddfc3c61-0877-4797-b7ee-7d4d434ac3a9",
    "rookieDraftId": "f827e1ab-899d-4616-a9ec-8e541453bd06"
  },
  "workflows": [
    {
      "id": "home-live-lineup",
      "status": "PASS",
      "totalMedianMs": 11.9,
      "steps": [
        {
          "workflowId": "home-live-lineup",
          "label": "current matchup row",
          "samples": 3,
          "medianMs": 3.4,
          "maxMs": 10.6,
          "rowCount": 1,
          "status": "PASS",
          "key": "current-matchup"
        },
        {
          "workflowId": "home-live-lineup",
          "label": "league week matchup rows",
          "samples": 3,
          "medianMs": 2.6,
          "maxMs": 13.3,
          "rowCount": 1,
          "status": "PASS",
          "key": "week-matchups"
        },
        {
          "workflowId": "home-live-lineup",
          "label": "my roster for lineup render",
          "samples": 3,
          "medianMs": 2.6,
          "maxMs": 4.1,
          "rowCount": 1,
          "status": "PASS",
          "key": "my-roster"
        },
        {
          "workflowId": "home-live-lineup",
          "label": "opponent roster for lineup render",
          "samples": 3,
          "medianMs": 2,
          "maxMs": 2.2,
          "rowCount": 0,
          "status": "PASS",
          "key": "opponent-roster"
        },
        {
          "workflowId": "home-live-lineup",
          "label": "today NBA games",
          "samples": 3,
          "medianMs": 1.3,
          "maxMs": 1.7,
          "rowCount": 0,
          "status": "PASS",
          "key": "today-games"
        }
      ]
    },
    {
      "id": "lineup-day-change",
      "status": "PASS",
      "totalMedianMs": 8,
      "steps": [
        {
          "workflowId": "lineup-day-change",
          "label": "lineup slot templates",
          "samples": 3,
          "medianMs": 3,
          "maxMs": 9.5,
          "rowCount": 10,
          "status": "PASS",
          "key": "slot-templates"
        },
        {
          "workflowId": "lineup-day-change",
          "label": "weekly lineup assignment rows",
          "samples": 3,
          "medianMs": 2.7,
          "maxMs": 2.7,
          "rowCount": 0,
          "status": "PASS",
          "key": "lineup-assignments"
        },
        {
          "workflowId": "lineup-day-change",
          "label": "same-day lock context games",
          "samples": 3,
          "medianMs": 2.3,
          "maxMs": 2.8,
          "rowCount": 0,
          "status": "PASS",
          "key": "lock-context-games"
        }
      ]
    },
    {
      "id": "player-search-filter",
      "status": "PASS",
      "totalMedianMs": 20.4,
      "steps": [
        {
          "workflowId": "player-search-filter",
          "label": "search_players first page RPC",
          "samples": 3,
          "medianMs": 17.1,
          "maxMs": 17.5,
          "rowCount": 20,
          "status": "PASS",
          "key": "search-page"
        },
        {
          "workflowId": "player-search-filter",
          "label": "availability owned players",
          "samples": 3,
          "medianMs": 1.7,
          "maxMs": 2.7,
          "rowCount": 1,
          "status": "PASS",
          "key": "owned-players"
        },
        {
          "workflowId": "player-search-filter",
          "label": "availability waiver players",
          "samples": 3,
          "medianMs": 1.6,
          "maxMs": 1.9,
          "rowCount": 0,
          "status": "PASS",
          "key": "waiver-players"
        }
      ]
    },
    {
      "id": "player-detail-open",
      "status": "PASS",
      "totalMedianMs": 19.5,
      "steps": [
        {
          "workflowId": "player-detail-open",
          "label": "player row",
          "samples": 3,
          "medianMs": 3.3,
          "maxMs": 8.7,
          "rowCount": 1,
          "status": "PASS",
          "key": "player"
        },
        {
          "workflowId": "player-detail-open",
          "label": "available seasons",
          "samples": 3,
          "medianMs": 2.8,
          "maxMs": 4,
          "rowCount": 0,
          "status": "PASS",
          "key": "seasons"
        },
        {
          "workflowId": "player-detail-open",
          "label": "season averages view",
          "samples": 3,
          "medianMs": 2.2,
          "maxMs": 3.9,
          "rowCount": 0,
          "status": "PASS",
          "key": "season-averages"
        },
        {
          "workflowId": "player-detail-open",
          "label": "game log first page",
          "samples": 3,
          "medianMs": 2.3,
          "maxMs": 2.5,
          "rowCount": 0,
          "status": "PASS",
          "key": "game-log"
        },
        {
          "workflowId": "player-detail-open",
          "label": "projection row RPC",
          "samples": 3,
          "medianMs": 8.9,
          "maxMs": 9.8,
          "rowCount": 0,
          "status": "PASS",
          "key": "projection"
        }
      ]
    },
    {
      "id": "roster-review-manage",
      "status": "PASS",
      "totalMedianMs": 12.4,
      "steps": [
        {
          "workflowId": "roster-review-manage",
          "label": "roster players with player rows",
          "samples": 3,
          "medianMs": 4.4,
          "maxMs": 10.7,
          "rowCount": 1,
          "status": "PASS",
          "key": "roster"
        },
        {
          "workflowId": "roster-review-manage",
          "label": "member draft picks",
          "samples": 3,
          "medianMs": 3.1,
          "maxMs": 3.4,
          "rowCount": 15,
          "status": "PASS",
          "key": "draft-picks"
        },
        {
          "workflowId": "roster-review-manage",
          "label": "my waiver claims",
          "samples": 3,
          "medianMs": 2.9,
          "maxMs": 10.2,
          "rowCount": 0,
          "status": "PASS",
          "key": "waiver-claims"
        },
        {
          "workflowId": "roster-review-manage",
          "label": "my waiver priority",
          "samples": 3,
          "medianMs": 2,
          "maxMs": 2.4,
          "rowCount": 0,
          "status": "PASS",
          "key": "waiver-priority"
        }
      ]
    },
    {
      "id": "waiver-add-claim",
      "status": "PASS",
      "totalMedianMs": 11.3,
      "steps": [
        {
          "workflowId": "waiver-add-claim",
          "label": "active waiver wire entries",
          "samples": 3,
          "medianMs": 4.6,
          "maxMs": 10.5,
          "rowCount": 0,
          "status": "PASS",
          "key": "waiver-wire"
        },
        {
          "workflowId": "waiver-add-claim",
          "label": "member transaction state",
          "samples": 3,
          "medianMs": 4.4,
          "maxMs": 4.6,
          "rowCount": 1,
          "status": "PASS",
          "key": "transaction-state"
        },
        {
          "workflowId": "waiver-add-claim",
          "label": "claim modal roster choices",
          "samples": 3,
          "medianMs": 2.3,
          "maxMs": 2.5,
          "rowCount": 1,
          "status": "PASS",
          "key": "roster-choices"
        }
      ]
    },
    {
      "id": "trade-review-act",
      "status": "PASS",
      "totalMedianMs": 10.1,
      "steps": [
        {
          "workflowId": "trade-review-act",
          "label": "trades involving member",
          "samples": 3,
          "medianMs": 4.2,
          "maxMs": 10.8,
          "rowCount": 0,
          "status": "PASS",
          "key": "trades"
        },
        {
          "workflowId": "trade-review-act",
          "label": "tradeable roster players",
          "samples": 3,
          "medianMs": 3,
          "maxMs": 3.4,
          "rowCount": 1,
          "status": "PASS",
          "key": "roster-assets"
        },
        {
          "workflowId": "trade-review-act",
          "label": "tradeable draft picks",
          "samples": 3,
          "medianMs": 2.9,
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
      "totalMedianMs": 12.7,
      "steps": [
        {
          "workflowId": "auction-draft-room",
          "label": "auction draft row",
          "samples": 3,
          "medianMs": 4,
          "maxMs": 9.6,
          "rowCount": 1,
          "status": "PASS",
          "key": "draft"
        },
        {
          "workflowId": "auction-draft-room",
          "label": "auction draft order",
          "samples": 3,
          "medianMs": 3.2,
          "maxMs": 4.3,
          "rowCount": 10,
          "status": "PASS",
          "key": "order"
        },
        {
          "workflowId": "auction-draft-room",
          "label": "auction budgets",
          "samples": 3,
          "medianMs": 2.8,
          "maxMs": 3.4,
          "rowCount": 10,
          "status": "PASS",
          "key": "budgets"
        },
        {
          "workflowId": "auction-draft-room",
          "label": "auction nominations",
          "samples": 3,
          "medianMs": 2.7,
          "maxMs": 3.8,
          "rowCount": 0,
          "status": "PASS",
          "key": "nominations"
        }
      ]
    },
    {
      "id": "rookie-draft-room",
      "status": "PASS",
      "totalMedianMs": 10.1,
      "steps": [
        {
          "workflowId": "rookie-draft-room",
          "label": "rookie draft row",
          "samples": 3,
          "medianMs": 4.2,
          "maxMs": 9.9,
          "rowCount": 1,
          "status": "PASS",
          "key": "draft"
        },
        {
          "workflowId": "rookie-draft-room",
          "label": "snake pick board",
          "samples": 3,
          "medianMs": 3.6,
          "maxMs": 10.3,
          "rowCount": 30,
          "status": "PASS",
          "key": "pick-board"
        },
        {
          "workflowId": "rookie-draft-room",
          "label": "rookie player board",
          "samples": 3,
          "medianMs": 2.3,
          "maxMs": 2.4,
          "rowCount": 100,
          "status": "PASS",
          "key": "player-board"
        }
      ]
    },
    {
      "id": "dynasty-hub",
      "status": "PASS",
      "totalMedianMs": 8.3,
      "steps": [
        {
          "workflowId": "dynasty-hub",
          "label": "dynasty rankings first page",
          "samples": 3,
          "medianMs": 4.1,
          "maxMs": 12.5,
          "rowCount": 51,
          "status": "PASS",
          "key": "rankings"
        },
        {
          "workflowId": "dynasty-hub",
          "label": "dynasty news first page",
          "samples": 3,
          "medianMs": 2.1,
          "maxMs": 3.2,
          "rowCount": 0,
          "status": "PASS",
          "key": "news"
        },
        {
          "workflowId": "dynasty-hub",
          "label": "my roster news scope",
          "samples": 3,
          "medianMs": 2.1,
          "maxMs": 3.6,
          "rowCount": 1,
          "status": "PASS",
          "key": "roster-news-scope"
        }
      ]
    }
  ],
  "failures": []
}
