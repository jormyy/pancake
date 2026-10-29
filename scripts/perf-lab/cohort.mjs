import { rankTraffic } from './traffic.mjs'

export function captureCohort(definition, captures) {
  const accepted = new Set(definition.sources)
  const latest = new Map()
  for (const capture of captures.filter(row => accepted.has(row.source))) {
    for (const observation of capture.observations ?? []) {
      if (observation.webkit?.passed && observation.webkit.traffic) {
        latest.set(observation.id, { ...observation, source: capture.source, evidence: capture.evidence })
      }
    }
  }
  const observations = [...latest.values()]
  const states = [...new Set(observations.map(row => row.state))].map(state => {
    const samples = observations.filter(row => row.state === state)
    return { state, samples: samples.length, requests: samples.reduce((sum, row) => sum + row.webkit.requests, 0),
      bytesDown: samples.reduce((sum, row) => sum + row.webkit.bytesIn, 0), bytesUp: samples.reduce((sum, row) => sum + row.webkit.bytesOut, 0) }
  })
  return { release: definition.release, observations, states, ranking: rankTraffic(observations.map(row => ({ breakdown: row.webkit.traffic }))) }
}
