{
  "status": "PASS",
  "season": 0,
  "artifactDir": "/Users/michaelchen/Projects/Apps/pancake/tests/artifacts/season-0/browser-lineup-locked",
  "fixture": {
    "runId": "20260912223911-4252-0",
    "leagueId": "b01b267d-2cfc-46da-aa36-ea7ab3afc8ba",
    "leagueSeasonId": "1dcef84a-86df-42d0-b37e-83d3945fa875",
    "memberId": "2c983d58-f9c9-484a-9ac6-6e79cbefcea0",
    "lockedPlayerId": "d0aeac50-f20d-415b-a43f-f041e2b3b616",
    "benchPlayerId": "99b4ff55-d31e-4f52-ba28-6d090df20981",
    "lockedRosterPlayerId": "d3bced6e-df17-4263-92aa-6fe4eca989f5",
    "benchRosterPlayerId": "5e8806a0-0a0f-4f02-8ccf-96c7a18551cb",
    "weekNumber": 1,
    "scheduledTipoff": "2026-09-12T22:38:11.731Z"
  },
  "mode": "locked",
  "lockedCheck": {
    "lockedLineup": {
      "id": "2b392e99-2ec3-42d6-873a-6053a2718bad",
      "player_id": "d0aeac50-f20d-415b-a43f-f041e2b3b616",
      "slot_type": "PG",
      "game_date": "2026-09-12"
    },
    "benchRows": [],
    "failures": []
  },
  "forgedRpcCheck": {
    "rejected": true,
    "errorMessage": "Lineup changes are locked because E2E Player008's game has already started.",
    "check": {
      "lockedLineup": {
        "id": "2b392e99-2ec3-42d6-873a-6053a2718bad",
        "player_id": "d0aeac50-f20d-415b-a43f-f041e2b3b616",
        "slot_type": "PG",
        "game_date": "2026-09-12"
      },
      "benchRows": [],
      "failures": []
    },
    "failures": []
  },
  "forgedMovesCheck": {
    "rejected": true,
    "errorMessage": "Lineup changes are locked because E2E Player008's game has already started.",
    "check": {
      "lockedLineup": {
        "id": "2b392e99-2ec3-42d6-873a-6053a2718bad",
        "player_id": "d0aeac50-f20d-415b-a43f-f041e2b3b616",
        "slot_type": "PG",
        "game_date": "2026-09-12"
      },
      "benchRows": [],
      "failures": []
    },
    "failures": []
  },
  "forgedAutoSetCheck": {
    "rejected": true,
    "errorMessage": "Lineup changes are locked because E2E Player008's game has already started.",
    "check": {
      "lockedLineup": {
        "id": "2b392e99-2ec3-42d6-873a-6053a2718bad",
        "player_id": "d0aeac50-f20d-415b-a43f-f041e2b3b616",
        "slot_type": "PG",
        "game_date": "2026-09-12"
      },
      "benchRows": [],
      "failures": []
    },
    "failures": []
  },
  "forgedLegalityCheck": {
    "gameDate": "2026-09-13",
    "legalStarterAccepted": true,
    "overfillRejected": true,
    "overfillErrorMessage": "Lineup slot PG is full.",
    "ineligibleRejected": true,
    "ineligibleErrorMessage": "E2E Player008 is not eligible for C.",
    "rows": [
      {
        "id": "7ed3117e-5dc0-49fe-9559-f1ae1e3acc52",
        "player_id": "d0aeac50-f20d-415b-a43f-f041e2b3b616",
        "slot_type": "PG",
        "game_date": "2026-09-13"
      }
    ],
    "failures": []
  },
  "notes": [
    "Frontend: http://127.0.0.1:8081",
    "Session: pancake-lineup-locked-20260912223911-4252-0-4252",
    "Manager: pancake-lineup-20260912223911-4252-0@example.com",
    "Active sessions:\n  acceptance-rpg-rejoin-final-20260905\n  zergchat-ui-fresh-retry-20260831"
  ],
  "failures": []
}
