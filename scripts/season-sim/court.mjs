import assert from 'node:assert/strict'

export function clockSeconds(value) {
  const match = /^PT(\d+)M([\d.]+)S$/.exec(value)
  assert.ok(match, `Invalid game clock: ${value}`)
  return Number(match[1]) * 60 + Number(match[2])
}

export function courtTime(box, allActions, selectedActions) {
  const teams = [box.game.homeTeam, box.game.awayTeam]
  const teamByPlayer = new Map(teams.flatMap((team, index) => team.players.map(player => [player.personId, index])))
  const result = new Map([...teamByPlayer.keys()].map(id => [id, { seconds: 0, plus: 0, minus: 0, oncourt: '0', played: '0' }]))
  let court = [new Set(), new Set()]
  let period = 0, previous = 0
  for (const action of selectedActions) {
    if (action.period !== period) {
      period = action.period
      previous = period <= 4 ? 720 : 300
      court = teams.map((team, index) => {
        if (period === 1) return new Set(team.players.filter(player => player.starter === '1').map(player => player.personId))
        const first = new Map()
        for (const event of allActions.filter(event => event.period === period)) {
          if (event.actionType === 'substitution') {
            if (teamByPlayer.get(event.personId) === index && !first.has(event.personId)) first.set(event.personId, event.subType === 'out')
          } else if (['2pt', '3pt', 'freethrow', 'rebound', 'steal', 'block', 'turnover', 'jumpball'].includes(event.actionType) || (event.actionType === 'foul' && event.subType !== 'technical')) {
            for (const id of [event.personId, event.assistPersonId, event.foulDrawnPersonId, event.jumpBallWonPersonId, event.jumpBallLostPersonId, event.jumpBallRecoverdPersonId]) {
              if (teamByPlayer.get(id) === index && !first.has(id)) first.set(id, true)
            }
          }
        }
        const starters = new Set([...first].filter(([, starts]) => starts).map(([id]) => id))
        if (starters.size < 5) {
          const untouched = team.players.filter(player => !first.has(player.personId) && clockSeconds(player.statistics.minutes) - result.get(player.personId).seconds > 0.1)
          if (untouched.length === 5 - starters.size) for (const player of untouched) starters.add(player.personId)
        }
        assert.equal(starters.size, 5, `Ambiguous period starters: ${box.game.gameId} period ${period} ${team.teamTricode}: ${[...starters]}`)
        return starters
      })
    }
    const remaining = clockSeconds(action.clock)
    const elapsed = previous - remaining
    if (Math.abs(elapsed) > 0.001) for (const lineup of court) {
      assert.equal(lineup.size, 5, `Invalid court: ${box.game.gameId} action ${action.actionNumber}`)
      for (const id of lineup) result.get(id).seconds += elapsed
    }
    const scored = action.shotResult === 'Made' ? ({ '2pt': 2, '3pt': 3, freethrow: 1 })[action.actionType] ?? 0 : 0
    const scoringTeam = teamByPlayer.get(action.personId)
    for (const [index, lineup] of court.entries()) for (const id of lineup) {
      const stats = result.get(id)
      stats.played = '1'
      if (scored && index === scoringTeam) stats.plus += scored
      if (scored && index !== scoringTeam) stats.minus += scored
    }
    previous = remaining
    if (action.actionType === 'substitution') {
      const index = teamByPlayer.get(action.personId)
      assert.ok(index != null, 'Unknown substitution player')
      if (action.subType === 'out') assert.ok(court[index].delete(action.personId), `Substitution out absent player: ${box.game.gameId} ${action.actionNumber}`)
      else if (action.subType === 'in') {
        assert.ok(!court[index].has(action.personId), 'Duplicate substitution in')
        court[index].add(action.personId)
        result.get(action.personId).played = '1'
      }
    }
  }
  for (const lineup of court) for (const id of lineup) result.get(id).oncourt = '1'
  return result
}

export function minutesIso(seconds) {
  return `PT${Math.floor(seconds / 60)}M${(seconds % 60).toFixed(2).padStart(5, '0')}S`
}
