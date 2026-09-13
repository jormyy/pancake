{
  "status": "PASS",
  "generatedAt": "2026-09-13T01:01:36.157Z",
  "endpoint": "http://127.0.0.1:54321",
  "runId": "20260913005935",
  "leagueId": "a9b446a8-e54e-451f-adcc-50c905f5f0d0",
  "user": "pancake-e2e-20260913005935-1@example.com",
  "provenance": {
    "commitSha": "1a98fc22b453435e83c7762a36b817a80df32ad0",
    "bundleDigest": "b31aa3bfea20bb647c382a47f667a9801d1922ddf609569933f0cc0808c80383",
    "runId": "local-1a98fc22b453-b31aa3bfea20"
  },
  "schemaVersion": "20260912000003",
  "repositorySchemaVersion": "20260912000003",
  "budgets": {
    "dataRequestMs": 100,
    "workflowTotalMs": 1000,
    "samples": 3
  },
  "context": {
    "memberId": "6665f772-e0e1-4d02-a576-e783bae4a915",
    "seasonId": "b73307b2-09d8-4ade-b0ee-f16b8c77e54f",
    "matchupId": "54cd935d-6284-4d3f-923b-002399fffa82",
    "playerId": "efdc9420-6317-4b3e-b469-50bbaed2a9b9",
    "auctionDraftId": "59d21800-fa93-4347-a0f0-376f18b9dc30",
    "rookieDraftId": "e1ab0c54-3745-48e0-a510-39c7ba5090a6"
  },
  "workflows": [
    {
      "id": "home-live-lineup",
      "status": "PASS",
      "totalMedianMs": 19.7,
      "steps": [
        {
          "workflowId": "home-live-lineup",
          "label": "current matchup row",
          "samples": 3,
          "medianMs": 5.3,
          "maxMs": 14.2,
          "rowCount": 1,
          "status": "PASS",
          "key": "current-matchup"
        },
        {
          "workflowId": "home-live-lineup",
          "label": "league week matchup rows",
          "samples": 3,
          "medianMs": 4.5,
          "maxMs": 5.3,
          "rowCount": 1,
          "status": "PASS",
          "key": "week-matchups"
        },
        {
          "workflowId": "home-live-lineup",
          "label": "my roster for lineup render",
          "samples": 3,
          "medianMs": 4.3,
          "maxMs": 4.4,
          "rowCount": 1,
          "status": "PASS",
          "key": "my-roster"
        },
        {
          "workflowId": "home-live-lineup",
          "label": "opponent roster for lineup render",
          "samples": 3,
          "medianMs": 3.7,
          "maxMs": 5.2,
          "rowCount": 0,
          "status": "PASS",
          "key": "opponent-roster"
        },
        {
          "workflowId": "home-live-lineup",
          "label": "today NBA games",
          "samples": 3,
          "medianMs": 1.9,
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
      "totalMedianMs": 17.6,
      "steps": [
        {
          "workflowId": "lineup-day-change",
          "label": "lineup slot templates",
          "samples": 3,
          "medianMs": 9.5,
          "maxMs": 17.2,
          "rowCount": 10,
          "status": "PASS",
          "key": "slot-templates"
        },
        {
          "workflowId": "lineup-day-change",
          "label": "weekly lineup assignment rows",
          "samples": 3,
          "medianMs": 3.8,
          "maxMs": 4.5,
          "rowCount": 0,
          "status": "PASS",
          "key": "lineup-assignments"
        },
        {
          "workflowId": "lineup-day-change",
          "label": "same-day lock context games",
          "samples": 3,
          "medianMs": 4.3,
          "maxMs": 6.5,
          "rowCount": 0,
          "status": "PASS",
          "key": "lock-context-games"
        }
      ]
    },
    {
      "id": "player-search-filter",
      "status": "PASS",
      "totalMedianMs": 29.2,
      "steps": [
        {
          "workflowId": "player-search-filter",
          "label": "search_players first page RPC",
          "samples": 3,
          "medianMs": 24.3,
          "maxMs": 30.9,
          "rowCount": 20,
          "status": "PASS",
          "key": "search-page"
        },
        {
          "workflowId": "player-search-filter",
          "label": "availability owned players",
          "samples": 3,
          "medianMs": 2.8,
          "maxMs": 2.9,
          "rowCount": 1,
          "status": "PASS",
          "key": "owned-players"
        },
        {
          "workflowId": "player-search-filter",
          "label": "availability waiver players",
          "samples": 3,
          "medianMs": 2.1,
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
      "totalMedianMs": 31.5,
      "steps": [
        {
          "workflowId": "player-detail-open",
          "label": "player row",
          "samples": 3,
          "medianMs": 6.4,
          "maxMs": 8.8,
          "rowCount": 1,
          "status": "PASS",
          "key": "player"
        },
        {
          "workflowId": "player-detail-open",
          "label": "available seasons",
          "samples": 3,
          "medianMs": 3.6,
          "maxMs": 5.4,
          "rowCount": 0,
          "status": "PASS",
          "key": "seasons"
        },
        {
          "workflowId": "player-detail-open",
          "label": "season averages view",
          "samples": 3,
          "medianMs": 3.6,
          "maxMs": 5.6,
          "rowCount": 0,
          "status": "PASS",
          "key": "season-averages"
        },
        {
          "workflowId": "player-detail-open",
          "label": "game log first page",
          "samples": 3,
          "medianMs": 5.8,
          "maxMs": 6.1,
          "rowCount": 0,
          "status": "PASS",
          "key": "game-log"
        },
        {
          "workflowId": "player-detail-open",
          "label": "projection row RPC",
          "samples": 3,
          "medianMs": 12.1,
          "maxMs": 12.6,
          "rowCount": 0,
          "status": "PASS",
          "key": "projection"
        }
      ]
    },
    {
      "id": "roster-review-manage",
      "status": "PASS",
      "totalMedianMs": 17.5,
      "steps": [
        {
          "workflowId": "roster-review-manage",
          "label": "roster players with player rows",
          "samples": 3,
          "medianMs": 5.1,
          "maxMs": 13.6,
          "rowCount": 1,
          "status": "PASS",
          "key": "roster"
        },
        {
          "workflowId": "roster-review-manage",
          "label": "member draft picks",
          "samples": 3,
          "medianMs": 4.6,
          "maxMs": 4.8,
          "rowCount": 15,
          "status": "PASS",
          "key": "draft-picks"
        },
        {
          "workflowId": "roster-review-manage",
          "label": "my waiver claims",
          "samples": 3,
          "medianMs": 4.3,
          "maxMs": 5.2,
          "rowCount": 0,
          "status": "PASS",
          "key": "waiver-claims"
        },
        {
          "workflowId": "roster-review-manage",
          "label": "my waiver priority",
          "samples": 3,
          "medianMs": 3.5,
          "maxMs": 5.2,
          "rowCount": 0,
          "status": "PASS",
          "key": "waiver-priority"
        }
      ]
    },
    {
      "id": "waiver-add-claim",
      "status": "PASS",
      "totalMedianMs": 19.6,
      "steps": [
        {
          "workflowId": "waiver-add-claim",
          "label": "active waiver wire entries",
          "samples": 3,
          "medianMs": 9.7,
          "maxMs": 18.4,
          "rowCount": 0,
          "status": "PASS",
          "key": "waiver-wire"
        },
        {
          "workflowId": "waiver-add-claim",
          "label": "member transaction state",
          "samples": 3,
          "medianMs": 6.8,
          "maxMs": 7.1,
          "rowCount": 1,
          "status": "PASS",
          "key": "transaction-state"
        },
        {
          "workflowId": "waiver-add-claim",
          "label": "claim modal roster choices",
          "samples": 3,
          "medianMs": 3.1,
          "maxMs": 5.6,
          "rowCount": 1,
          "status": "PASS",
          "key": "roster-choices"
        }
      ]
    },
    {
      "id": "trade-review-act",
      "status": "PASS",
      "totalMedianMs": 15.6,
      "steps": [
        {
          "workflowId": "trade-review-act",
          "label": "trades involving member",
          "samples": 3,
          "medianMs": 5.6,
          "maxMs": 14.2,
          "rowCount": 0,
          "status": "PASS",
          "key": "trades"
        },
        {
          "workflowId": "trade-review-act",
          "label": "tradeable roster players",
          "samples": 3,
          "medianMs": 5.5,
          "maxMs": 6.7,
          "rowCount": 1,
          "status": "PASS",
          "key": "roster-assets"
        },
        {
          "workflowId": "trade-review-act",
          "label": "tradeable draft picks",
          "samples": 3,
          "medianMs": 4.5,
          "maxMs": 5.5,
          "rowCount": 15,
          "status": "PASS",
          "key": "pick-assets"
        }
      ]
    },
    {
      "id": "auction-draft-room",
      "status": "PASS",
      "totalMedianMs": 22.3,
      "steps": [
        {
          "workflowId": "auction-draft-room",
          "label": "auction draft row",
          "samples": 3,
          "medianMs": 7.8,
          "maxMs": 9.8,
          "rowCount": 1,
          "status": "PASS",
          "key": "draft"
        },
        {
          "workflowId": "auction-draft-room",
          "label": "auction draft order",
          "samples": 3,
          "medianMs": 5.8,
          "maxMs": 7.1,
          "rowCount": 10,
          "status": "PASS",
          "key": "order"
        },
        {
          "workflowId": "auction-draft-room",
          "label": "auction budgets",
          "samples": 3,
          "medianMs": 5.4,
          "maxMs": 5.7,
          "rowCount": 10,
          "status": "PASS",
          "key": "budgets"
        },
        {
          "workflowId": "auction-draft-room",
          "label": "auction nominations",
          "samples": 3,
          "medianMs": 3.3,
          "maxMs": 4,
          "rowCount": 0,
          "status": "PASS",
          "key": "nominations"
        }
      ]
    },
    {
      "id": "rookie-draft-room",
      "status": "PASS",
      "totalMedianMs": 13.1,
      "steps": [
        {
          "workflowId": "rookie-draft-room",
          "label": "rookie draft row",
          "samples": 3,
          "medianMs": 4,
          "maxMs": 12.9,
          "rowCount": 1,
          "status": "PASS",
          "key": "draft"
        },
        {
          "workflowId": "rookie-draft-room",
          "label": "snake pick board",
          "samples": 3,
          "medianMs": 4.8,
          "maxMs": 6.4,
          "rowCount": 30,
          "status": "PASS",
          "key": "pick-board"
        },
        {
          "workflowId": "rookie-draft-room",
          "label": "rookie player board",
          "samples": 3,
          "medianMs": 4.3,
          "maxMs": 4.6,
          "rowCount": 100,
          "status": "PASS",
          "key": "player-board"
        }
      ]
    },
    {
      "id": "dynasty-hub",
      "status": "PASS",
      "totalMedianMs": 13.8,
      "steps": [
        {
          "workflowId": "dynasty-hub",
          "label": "dynasty rankings first page",
          "samples": 3,
          "medianMs": 5.1,
          "maxMs": 15.9,
          "rowCount": 51,
          "status": "PASS",
          "key": "rankings"
        },
        {
          "workflowId": "dynasty-hub",
          "label": "dynasty news first page",
          "samples": 3,
          "medianMs": 3.9,
          "maxMs": 4.4,
          "rowCount": 0,
          "status": "PASS",
          "key": "news"
        },
        {
          "workflowId": "dynasty-hub",
          "label": "my roster news scope",
          "samples": 3,
          "medianMs": 4.8,
          "maxMs": 7,
          "rowCount": 1,
          "status": "PASS",
          "key": "roster-news-scope"
        }
      ]
    }
  ],
  "failures": []
}
