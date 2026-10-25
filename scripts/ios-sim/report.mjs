import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { json, run } from './common.mjs'

export function failures(report) {
  const result = []
  if (report.error) result.push(report.error)
  if (!report.metrics) result.push('No paint recording arrived')
  else if (report.metrics.missingObservation) result.push(report.metrics.observationError)
  else {
    if (report.metrics.observationError) result.push(report.metrics.observationError)
    if (!report.metrics.standalone) result.push('The page is not an installed Home Screen app')
    if (report.metrics.firstContentMs === null) result.push('Expected real content did not appear')
    if (!report.metrics.settled) result.push('The screen did not settle within the observation window')
  }
  return result
}

export async function videoDifferences(video, directory) {
  const output = await run('/opt/homebrew/bin/ffmpeg', ['-hide_banner', '-i', video, '-vf', 'fps=15,scale=402:874,format=gray,tblend=all_mode=difference,bbox=min_val=24', '-an', '-f', 'null', '-'], { captureStderr: true })
  const events = [...output.matchAll(/pts_time:([\d.]+).*?x1:(\d+) x2:(\d+) y1:(\d+) y2:(\d+) w:(\d+) h:(\d+)/g)].map(match => ({ timeMs: Number(match[1]) * 1000, element: { role: null, label: null, text: null }, before: null, after: { rect: { x: Number(match[2]), y: Number(match[4]), width: Number(match[6]), height: Number(match[7]) } }, method: 'video-difference', limitation: 'Pixels identify changed regions. They cannot identify DOM elements or separate animation from data changes.' }))
  await json(path.join(directory, 'video-differences.json'), events)
  return events
}

export async function writeReport(directory, report) {
  const cell = value => String(value ?? 'unknown').replaceAll('|', '\\|').replaceAll('\n', ' ')
  report.passed = report.steps.filter(step => failures(step).length === 0).length
  report.failed = report.steps.length - report.passed + (report.error ? 1 : 0) + (report.cleanupError ? 1 : 0)
  await json(path.join(directory, 'report.json'), report)
  const lines = [
    '# iPhone Safari Home Screen report', '',
    `Source: ${report.head}. Device: ${report.device?.name ?? 'not started'}.`,
    `Build: ${report.build ?? 'unknown'}. Source fingerprint: ${report.sourceFingerprint ?? 'unknown'}.`,
    `Completed steps: ${report.steps.length}. Passed: ${report.passed}. Failed: ${report.failed}.`,
    'Request counts include page-initiated fetch, XHR, and resource loads. Harness traffic is excluded. Cache hits can be included.',
    'The first expected content defines the first meaningful paint. Every sampled visible DOM change after that paint appears below.',
    'Background work pauses while the app is hidden. Recorded sampling cost appears in report.json.', '',
    '| Screen or action | First content (ms) | Requests | Changes | Result |',
    '| --- | ---: | ---: | ---: | --- |',
    ...report.steps.map(step => `| ${cell(step.id)} | ${cell(step.metrics?.firstContentMs)} | ${cell(step.metrics?.requestCount)} | ${cell(step.metrics?.events.length)} | ${cell(failures(step).join('; ') || 'pass')} |`), '',
  ]
  for (const step of report.steps) {
    lines.push(`## ${step.id}`, '', `Screenshot: [${step.id}.png](${step.id}.png).`, '')
    if (step.videoDifferences) lines.push(`Video differences after the first meaningful paint: ${step.videoDifferences.length}. See [video-differences.json](video-differences.json) and report.json for each changed region.`, '')
    if (step.note) lines.push(step.note, '')
    const events = step.metrics?.events ?? []
    if (!events.length) lines.push(step.metrics?.firstContentMs === null || !step.metrics ? 'No usable paint baseline. Changes are unknown.' : 'No visible DOM changes after the first meaningful paint.', '')
    else {
      lines.push('| Time (ms) | Event | Role | Label or text | Before rect | After rect |', '| ---: | --- | --- | --- | --- | --- |')
      for (const event of events) lines.push(`| ${event.timeMs} | ${event.kind} | ${cell(event.element.role ?? event.element.tag)} | ${cell(event.element.label || event.element.text)} | ${cell(JSON.stringify(event.before?.rect ?? null))} | ${cell(JSON.stringify(event.after?.rect ?? null))} |`)
      lines.push('')
    }
  }
  if (report.error) lines.push(`Run error: ${report.error}`, '')
  if (report.cleanupError) lines.push(`Cleanup error: ${report.cleanupError}`, '')
  await writeFile(path.join(directory, 'report.md'), `${lines.join('\n')}\n`)
}
