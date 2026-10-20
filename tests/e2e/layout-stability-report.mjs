import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

export const sweepFailures = (capture, empty = false) => {
  if (!capture) return ['measurement unavailable']
  const m = capture.metrics
  return [
    m.maxHorizontalPx > 2 && `horizontal displacement ${m.maxHorizontalPx}px`,
    m.maxVerticalPx > 2 && `vertical displacement ${m.maxVerticalPx}px`,
    typeof m.cls === 'number' && m.cls > 0 && `CLS ${m.cls}`,
    m.blankFrames > 0 && `${m.blankFrames} blank frames`,
    m.reappearances > 0 && `${m.reappearances} element reappearances`,
    m.loadingDurationMs > 0 && `loading text ${m.loadingDurationMs}ms`,
    m.spinnerDurationMs > 0 && `spinners ${m.spinnerDurationMs}ms`,
    m.firstContentMs === null && 'no visible content',
    m.stableLayoutMs === null && 'layout did not settle for 500ms',
    empty && !m.noticePresent && 'empty-matchup notice absent',
    empty && m.noticeMissingFrames > 0 && `notice missing after display: ${m.noticeMissingFrames} frames`,
    capture.truncated && 'frame recorder reached its limit',
  ].filter(Boolean)
}

const cell = (value) => String(value ?? '—').replaceAll('|', '\\|').replaceAll('\n', ' ')

let pendingSave = Promise.resolve()

export function saveSweepReport(report, output, name = 'sweep') {
  pendingSave = pendingSave.then(() => writeSweepReport(report, output, name))
  return pendingSave
}

async function writeSweepReport(report, output, name) {
  await mkdir(output, { recursive: true })
  await writeFile(path.join(output, `${name}.json`), `${JSON.stringify(report, null, 2)}\n`)
  const lines = [
    `# ${report.label} layout stability`, '',
    `Build: ${report.release?.commitSha ?? 'unavailable'}. Generated: ${report.generatedAt}.`, '',
    `Command: \`${report.command}\``, '',
    '| Target | Engine | Browser version | Viewport |',
    '| --- | --- | --- | --- |',
    ...[...new Set(report.cells.map((row) => row.target))].map((target) => {
      const row = report.cells.find((row) => row.target === target && row.browserVersion) ?? report.cells.find((row) => row.target === target)
      return `| ${[target, row.engine, row.browserVersion ?? 'not measured', `${row.viewport.width}×${row.viewport.height}`].map(cell).join(' | ')} |`
    }), '',
    'Chromium CLS uses session windows: gaps below 1 second, windows at most 5 seconds, no recent input.',
    'WebKit CLS is unsupported. Geometry is sampled on animation frames, mutations, resizes, and a 50 ms timer.',
    'Geometry excludes 500 ms after input and 150 ms after scroll. Blank and notice checks remain active.',
    'Time to stable layout requires 500 ms without content or position changes. Null means unsettled or missing content.',
    'Sampling can miss changes between frames. Video and screenshots complement DOM measurements.',
    'FAIL includes displacement above 2 CSS pixels, any positive CLS, loading, spinners, blank frames, reappearance, or failed assertions.',
    'iPhone standalone mode is simulated; physical installation and OS suspension are not measured.', '',
    '| Surface | Target | Scenario | Latency | Result | CLS | Max X/Y px | Blank frames | Loading/spinner ms | Stable ms | Notice | Reason |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...report.cells.map((row) => {
      const m = row.metrics
      return `| ${[row.surface, row.target, row.scenario, row.latencyProfile, row.status, m?.cls ?? (row.engine === 'webkit' ? 'unsupported' : 'not measured'), m ? `${m.maxHorizontalPx}/${m.maxVerticalPx}` : null, m?.blankFrames, m ? `${m.loadingDurationMs}/${m.spinnerDurationMs}` : null, m?.stableLayoutMs, row.surface === 'home-empty' ? m?.noticePresent : 'n/a', row.reason ?? row.failures?.join('; ')].map(cell).join(' | ')} |`
    }), '',
    '| Surface | Measured | Pass | Fail | Not run |', '| --- | --- | --- | --- | --- |',
    ...[...new Set(report.cells.map((row) => row.surface))].map((surface) => {
      const rows = report.cells.filter((row) => row.surface === surface)
      return `| ${surface} | ${rows.filter((row) => row.metrics).length} | ${rows.filter((row) => row.status === 'PASS').length} | ${rows.filter((row) => row.status === 'FAIL').length} | ${rows.filter((row) => row.status === 'NOT_RUN').length} |`
    }), '',
  ]
  await writeFile(path.join(output, `${name}.md`), lines.join('\n'))
}
