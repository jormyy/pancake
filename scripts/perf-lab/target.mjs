export function labTarget(env = process.env) {
  const lane = env.PERF_LAB_LANE ?? 'fable-timeline/perf-lab'
  const project = env.PERF_LAB_PROJECT ?? 'pt4bafablelab'
  const prefix = env.PERF_LAB_PORT_PREFIX ?? '572'
  if (!/^[a-z0-9_-]+(?:\/[a-z0-9_-]+)*$/.test(lane)) throw new Error('Use a relative private lab lane')
  if (!/^pt[a-z0-9]+$/.test(project)) throw new Error('Use a private lab project')
  if (!/^\d{3}$/.test(prefix) || Number(prefix) < 102 || Number(prefix) > 654) throw new Error('Use a private lab port block')
  const port = suffix => Number(`${prefix}${suffix}`)
  return { lane, project, prefix, relativeRoot: `pancake-t_4ba51e0d/lanes/${lane}`,
    ports: { api: port('21'), db: port('22'), https: port('84'), edge: port('81'), inspector: port('83'), proxy: port('88'), fixtures: port('80') } }
}
