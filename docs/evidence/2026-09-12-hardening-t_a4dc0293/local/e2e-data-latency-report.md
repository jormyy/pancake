{
  "status": "PASS",
  "generatedAt": "2026-09-12T21:32:06.306Z",
  "endpoint": "http://127.0.0.1:54321",
  "runId": "20260912212954",
  "leagueId": "41a67745-30db-442b-b37b-fb7be5ce0a01",
  "user": "pancake-e2e-20260912212954-1@example.com",
  "provenance": {
    "commitSha": "553373c32e66e34ad6d0a7527a03524b43271ee3",
    "bundleDigest": "571a746cb7bb05ce6491a9a8539cbc2a25bbe78215be75af15b25a79e7c2650c",
    "runId": "local-553373c32e66-571a746cb7bb"
  },
  "schemaVersion": "20260823000001",
  "repositorySchemaVersion": "20260823000001",
  "budgets": {
    "dataRequestMs": 100,
    "workflowTotalMs": 1000,
    "samples": 3
  },
  "context": {
    "memberId": "55d3cbac-a438-4ec4-9873-481192868dac",
    "seasonId": "8b1bb18a-b3a1-4775-80d6-f44887058e33",
    "matchupId": "1bd5d339-df50-4cdc-8373-716b4e77e58f",
    "playerId": "add2961a-1f53-41ca-8fad-d1e7dd368786",
    "auctionDraftId": "f26b5cc0-95fe-40c0-b33a-e65f26750b90",
    "rookieDraftId": "a43f892f-ba98-4fb6-aa59-ee02008f486e"
  },
  "workflows": [
    {
      "id": "home-live-lineup",
      "status": "PASS",
      "totalMedianMs": 13.5,
      "steps": [
        {
          "workflowId": "home-live-lineup",
          "label": "current matchup row",
          "samples": 3,
          "medianMs": 4.4,
          "maxMs": 12.3,
          "rowCount": 1,
          "status": "PASS",
          "key": "current-matchup"
        },
        {
          "workflowId": "home-live-lineup",
          "label": "league week matchup rows",
          "samples": 3,
          "medianMs": 2.4,
          "maxMs": 2.5,
          "rowCount": 1,
          "status": "PASS",
          "key": "week-matchups"
        },
        {
          "workflowId": "home-live-lineup",
          "label": "my roster for lineup render",
          "samples": 3,
          "medianMs": 2.4,
          "maxMs": 2.7,
          "rowCount": 0,
          "status": "PASS",
          "key": "my-roster"
        },
        {
          "workflowId": "home-live-lineup",
          "label": "opponent roster for lineup render",
          "samples": 3,
          "medianMs": 2.6,
          "maxMs": 2.8,
          "rowCount": 0,
          "status": "PASS",
          "key": "opponent-roster"
        },
        {
          "workflowId": "home-live-lineup",
          "label": "today NBA games",
          "samples": 3,
          "medianMs": 1.7,
          "maxMs": 2.5,
          "rowCount": 0,
          "status": "PASS",
          "key": "today-games"
        }
      ]
    },
    {
      "id": "lineup-day-change",
      "status": "PASS",
      "totalMedianMs": 7.6,
      "steps": [
        {
          "workflowId": "lineup-day-change",
          "label": "lineup slot templates",
          "samples": 3,
          "medianMs": 3.5,
          "maxMs": 10.2,
          "rowCount": 10,
          "status": "PASS",
          "key": "slot-templates"
        },
        {
          "workflowId": "lineup-day-change",
          "label": "weekly lineup assignment rows",
          "samples": 3,
          "medianMs": 2.5,
          "maxMs": 17.2,
          "rowCount": 0,
          "status": "PASS",
          "key": "lineup-assignments"
        },
        {
          "workflowId": "lineup-day-change",
          "label": "same-day lock context games",
          "samples": 3,
          "medianMs": 1.6,
          "maxMs": 1.6,
          "rowCount": 0,
          "status": "PASS",
          "key": "lock-context-games"
        }
      ]
    },
    {
      "id": "player-search-filter",
      "status": "PASS",
      "totalMedianMs": 18.1,
      "steps": [
        {
          "workflowId": "player-search-filter",
          "label": "search_players first page RPC",
          "samples": 3,
          "medianMs": 15.4,
          "maxMs": 21,
          "rowCount": 20,
          "status": "PASS",
          "key": "search-page"
        },
        {
          "workflowId": "player-search-filter",
          "label": "availability owned players",
          "samples": 3,
          "medianMs": 1.5,
          "maxMs": 2.1,
          "rowCount": 0,
          "status": "PASS",
          "key": "owned-players"
        },
        {
          "workflowId": "player-search-filter",
          "label": "availability waiver players",
          "samples": 3,
          "medianMs": 1.2,
          "maxMs": 1.3,
          "rowCount": 0,
          "status": "PASS",
          "key": "waiver-players"
        }
      ]
    },
    {
      "id": "player-detail-open",
      "status": "PASS",
      "totalMedianMs": 18.2,
      "steps": [
        {
          "workflowId": "player-detail-open",
          "label": "player row",
          "samples": 3,
          "medianMs": 4.3,
          "maxMs": 9.7,
          "rowCount": 1,
          "status": "PASS",
          "key": "player"
        },
        {
          "workflowId": "player-detail-open",
          "label": "available seasons",
          "samples": 3,
          "medianMs": 2.4,
          "maxMs": 3,
          "rowCount": 0,
          "status": "PASS",
          "key": "seasons"
        },
        {
          "workflowId": "player-detail-open",
          "label": "season averages view",
          "samples": 3,
          "medianMs": 1.8,
          "maxMs": 2.4,
          "rowCount": 0,
          "status": "PASS",
          "key": "season-averages"
        },
        {
          "workflowId": "player-detail-open",
          "label": "game log first page",
          "samples": 3,
          "medianMs": 2.1,
          "maxMs": 2.9,
          "rowCount": 0,
          "status": "PASS",
          "key": "game-log"
        },
        {
          "workflowId": "player-detail-open",
          "label": "projection row RPC",
          "samples": 3,
          "medianMs": 7.6,
          "maxMs": 9.4,
          "rowCount": 0,
          "status": "PASS",
          "key": "projection"
        }
      ]
    },
    {
      "id": "roster-review-manage",
      "status": "PASS",
      "totalMedianMs": 8.9,
      "steps": [
        {
          "workflowId": "roster-review-manage",
          "label": "roster players with player rows",
          "samples": 3,
          "medianMs": 2.7,
          "maxMs": 11.8,
          "rowCount": 0,
          "status": "PASS",
          "key": "roster"
        },
        {
          "workflowId": "roster-review-manage",
          "label": "member draft picks",
          "samples": 3,
          "medianMs": 2.6,
          "maxMs": 17.9,
          "rowCount": 15,
          "status": "PASS",
          "key": "draft-picks"
        },
        {
          "workflowId": "roster-review-manage",
          "label": "my waiver claims",
          "samples": 3,
          "medianMs": 2,
          "maxMs": 3.1,
          "rowCount": 0,
          "status": "PASS",
          "key": "waiver-claims"
        },
        {
          "workflowId": "roster-review-manage",
          "label": "my waiver priority",
          "samples": 3,
          "medianMs": 1.6,
          "maxMs": 1.8,
          "rowCount": 0,
          "status": "PASS",
          "key": "waiver-priority"
        }
      ]
    },
    {
      "id": "waiver-add-claim",
      "status": "PASS",
      "totalMedianMs": 16.9,
      "steps": [
        {
          "workflowId": "waiver-add-claim",
          "label": "active waiver wire entries",
          "samples": 3,
          "medianMs": 10.4,
          "maxMs": 14.3,
          "rowCount": 0,
          "status": "PASS",
          "key": "waiver-wire"
        },
        {
          "workflowId": "waiver-add-claim",
          "label": "member transaction state",
          "samples": 3,
          "medianMs": 4.8,
          "maxMs": 5.6,
          "rowCount": 1,
          "status": "PASS",
          "key": "transaction-state"
        },
        {
          "workflowId": "waiver-add-claim",
          "label": "claim modal roster choices",
          "samples": 3,
          "medianMs": 1.7,
          "maxMs": 2.1,
          "rowCount": 0,
          "status": "PASS",
          "key": "roster-choices"
        }
      ]
    },
    {
      "id": "trade-review-act",
      "status": "PASS",
      "totalMedianMs": 6.5,
      "steps": [
        {
          "workflowId": "trade-review-act",
          "label": "trades involving member",
          "samples": 3,
          "medianMs": 2.1,
          "maxMs": 21.1,
          "rowCount": 0,
          "status": "PASS",
          "key": "trades"
        },
        {
          "workflowId": "trade-review-act",
          "label": "tradeable roster players",
          "samples": 3,
          "medianMs": 2.2,
          "maxMs": 2.7,
          "rowCount": 0,
          "status": "PASS",
          "key": "roster-assets"
        },
        {
          "workflowId": "trade-review-act",
          "label": "tradeable draft picks",
          "samples": 3,
          "medianMs": 2.2,
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
      "totalMedianMs": 12.2,
      "steps": [
        {
          "workflowId": "auction-draft-room",
          "label": "auction draft row",
          "samples": 3,
          "medianMs": 5.1,
          "maxMs": 10.9,
          "rowCount": 1,
          "status": "PASS",
          "key": "draft"
        },
        {
          "workflowId": "auction-draft-room",
          "label": "auction draft order",
          "samples": 3,
          "medianMs": 2.4,
          "maxMs": 2.8,
          "rowCount": 10,
          "status": "PASS",
          "key": "order"
        },
        {
          "workflowId": "auction-draft-room",
          "label": "auction budgets",
          "samples": 3,
          "medianMs": 2.3,
          "maxMs": 3.1,
          "rowCount": 10,
          "status": "PASS",
          "key": "budgets"
        },
        {
          "workflowId": "auction-draft-room",
          "label": "auction nominations",
          "samples": 3,
          "medianMs": 2.4,
          "maxMs": 4.4,
          "rowCount": 0,
          "status": "PASS",
          "key": "nominations"
        }
      ]
    },
    {
      "id": "rookie-draft-room",
      "status": "PASS",
      "totalMedianMs": 9.2,
      "steps": [
        {
          "workflowId": "rookie-draft-room",
          "label": "rookie draft row",
          "samples": 3,
          "medianMs": 4.2,
          "maxMs": 11.5,
          "rowCount": 1,
          "status": "PASS",
          "key": "draft"
        },
        {
          "workflowId": "rookie-draft-room",
          "label": "snake pick board",
          "samples": 3,
          "medianMs": 2.5,
          "maxMs": 2.7,
          "rowCount": 30,
          "status": "PASS",
          "key": "pick-board"
        },
        {
          "workflowId": "rookie-draft-room",
          "label": "rookie player board",
          "samples": 3,
          "medianMs": 2.5,
          "maxMs": 3.1,
          "rowCount": 100,
          "status": "PASS",
          "key": "player-board"
        }
      ]
    },
    {
      "id": "dynasty-hub",
      "status": "PASS",
      "totalMedianMs": 9.2,
      "steps": [
        {
          "workflowId": "dynasty-hub",
          "label": "dynasty rankings first page",
          "samples": 3,
          "medianMs": 5.1,
          "maxMs": 10.1,
          "rowCount": 0,
          "status": "PASS",
          "key": "rankings"
        },
        {
          "workflowId": "dynasty-hub",
          "label": "dynasty news first page",
          "samples": 3,
          "medianMs": 2.2,
          "maxMs": 2.8,
          "rowCount": 0,
          "status": "PASS",
          "key": "news"
        },
        {
          "workflowId": "dynasty-hub",
          "label": "my roster news scope",
          "samples": 3,
          "medianMs": 1.9,
          "maxMs": 1.9,
          "rowCount": 0,
          "status": "PASS",
          "key": "roster-news-scope"
        }
      ]
    }
  ],
  "failures": []
}
