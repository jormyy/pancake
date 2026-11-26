#!/usr/bin/env node
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { webkit } from 'playwright'
import { requireLocal } from './run.mjs'

const [dirArg, ...options] = process.argv.slice(2)
const option = (name, fallback) => options.find(value => value.startsWith(`--${name}=`))?.split('=')[1] ?? fallback
const dir = path.resolve(dirArg)
const run = JSON.parse(await readFile(path.join(dir, 'run.json'), 'utf8'))
assert.equal(run.dir, dir)
assert.equal(run.repo, path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..'))
assert.ok(run.readyAt && !run.cleanedAt)
requireLocal(run.url)
const label = option('label', 'run')
assert.match(label, /^[a-z0-9-]+$/)
const width = Number(option('width', '390'))
const height = Number(option('height', '844'))
const teams = Number(option('teams', '3'))
const prefix = path.join(dir, `trade-grouping-${label}-${teams}team-${width}${option('details', '0') === '1' ? '-details' : ''}`)
const state = JSON.parse(await readFile(path.join(run.work, 'tests/e2e-state.json'), 'utf8'))
const fixture = JSON.parse(await readFile(path.join(dir, 'fixture.json'), 'utf8'))
const receipt = { label, width, height, teams, revision: run.revision ?? null, steps: [], routes: [], failures: [] }
const fail = message => { receipt.failures.push(message); console.error(`FAIL ${message}`) }

const browser = await webkit.launch({ headless: true })
const context = await browser.newContext({ viewport: { width, height }, isMobile: true, hasTouch: true })
const page = await context.newPage()
page.setDefaultTimeout(20000)
const button = name => page.getByRole('button', { name, exact: true }).filter({ visible: true })
const tap = async name => { await button(name).first().tap(); await page.waitForTimeout(250) }
const dialog = () => page.locator('[role="dialog"]:visible, [aria-modal="true"]:visible').last()
const closeSheet = async () => { await dialog().getByRole('button', { name: 'Close', exact: true }).filter({ visible: true }).last().tap(); await page.waitForTimeout(400) }
const shot = async name => {
  assert.equal(await page.locator('input[type="password"]:visible').count(), 0)
  await page.screenshot({ path: `${prefix}-${name}.png`, animations: 'disabled' })
  await writeFile(`${prefix}-${name}.txt`, await page.locator('body').ariaSnapshot())
}

const geometry = anchorText => page.evaluate(anchor => {
  const scrollers = [...document.querySelectorAll('*')].filter(node => node.getClientRects().length && node.clientHeight > 200 && node.scrollHeight > node.clientHeight + 4 && /auto|scroll/.test(getComputedStyle(node).overflowY))
  const scroller = scrollers.sort((a, b) => b.clientHeight - a.clientHeight)[0]
  const heading = [...document.querySelectorAll('[role="heading"]')].find(node => node.getAttribute('aria-label') === anchor && node.getClientRects().length)
  return {
    innerWidth, docScrollWidth: document.documentElement.scrollWidth, docScrollX: scrollX,
    scrollTop: scroller ? Math.round(scroller.scrollTop) : null, scrollLeft: scroller ? Math.round(scroller.scrollLeft) : null,
    scrollerWidth: scroller?.clientWidth ?? null, scrollerScrollWidth: scroller?.scrollWidth ?? null,
    anchorTop: heading ? Math.round(heading.getBoundingClientRect().top * 10) / 10 : null,
    anchorLeft: heading ? Math.round(heading.getBoundingClientRect().left * 10) / 10 : null,
  }
}, anchorText)
const placeBelowFold = anchorText => page.evaluate(anchor => {
  const heading = [...document.querySelectorAll('[role="heading"]')].find(node => node.getAttribute('aria-label') === anchor && node.getClientRects().length)
  const scrollers = [...document.querySelectorAll('*')].filter(node => node.getClientRects().length && node.clientHeight > 200 && node.scrollHeight > node.clientHeight + 4 && /auto|scroll/.test(getComputedStyle(node).overflowY))
  const scroller = scrollers.sort((a, b) => b.clientHeight - a.clientHeight)[0]
  scroller.scrollTop += heading.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 24
}, anchorText)

const startSampler = anchorText => page.evaluate(anchor => {
  const scroller = [...document.querySelectorAll('*')].filter(node => node.getClientRects().length && node.clientHeight > 200 && node.scrollHeight > node.clientHeight + 4 && /auto|scroll/.test(getComputedStyle(node).overflowY)).sort((a, b) => b.clientHeight - a.clientHeight)[0]
  const content = scroller.firstElementChild
  const lead = content.firstElementChild
  const heights = () => `${content.offsetHeight}:${lead.offsetHeight}`
  let observed = heights()
  const samples = []
  const sample = source => {
    const heading = [...document.querySelectorAll('[role="heading"]')].find(node => node.getAttribute('aria-label') === anchor && node.getClientRects().length)
    samples.push({ source, anchorTop: heading ? Math.round(heading.getBoundingClientRect().top * 10) / 10 : null, anchorLeft: heading ? Math.round(heading.getBoundingClientRect().left * 10) / 10 : null,
      scrollTop: Math.round(scroller.scrollTop), scrollLeft: Math.round(scroller.scrollLeft), maxScroll: scroller.scrollHeight - scroller.clientHeight,
      overflow: document.documentElement.scrollWidth > innerWidth || scrollX !== 0 || scroller.scrollWidth > scroller.clientWidth })
  }
  const observer = new ResizeObserver(() => { observed = heights(); sample('observer') })
  observer.observe(content)
  observer.observe(lead)
  window.__tradeGroupingSampler = { samples, running: true, observer, skipped: 0 }
  const frame = () => {
    if (heights() === observed) sample('frame')
    else window.__tradeGroupingSampler.skipped++
    if (window.__tradeGroupingSampler.running) requestAnimationFrame(frame)
  }
  frame()
}, anchorText)
const stopSampler = () => page.evaluate(() => { const sampler = window.__tradeGroupingSampler; sampler.running = false; sampler.observer.disconnect(); return sampler.samples })

const measured = async (name, anchor, act, { allowBottomClamp = false } = {}) => {
  await placeBelowFold(anchor)
  await page.waitForTimeout(1500)
  const before = await geometry(anchor)
  await shot(`${name}-before`)
  await startSampler(anchor)
  await act()
  await page.waitForTimeout(3000)
  const samples = (await stopSampler()).filter(sample => sample.anchorTop !== null)
  const after = await geometry(anchor)
  const drift = Math.max(...samples.map(sample => Math.abs(sample.anchorTop - before.anchorTop)))
  const finalDrift = Math.abs(after.anchorTop - before.anchorTop)
  const sideways = samples.some(sample => sample.overflow || sample.scrollLeft !== 0 || sample.anchorLeft !== before.anchorLeft)
  const atBottom = samples[0] && samples[0].scrollTop >= samples[0].maxScroll - 1
  const clamped = atBottom && after.scrollTop < before.scrollTop && Math.abs(after.scrollTop - (samples.at(-1)?.maxScroll ?? -1)) <= 1
  await shot(`${name}-after`)
  const trace = samples.filter((sample, index) => index === 0 || JSON.stringify(sample) !== JSON.stringify(samples[index - 1])).slice(0, 80)
  const step = { name, anchor, before, after, frames: samples.length, trace, maxAnchorDrift: drift, finalAnchorDrift: finalDrift, sideways, scrollDelta: after.scrollTop - before.scrollTop, bottomClamp: clamped }
  receipt.steps.push(step)
  if (drift > 2 && !(allowBottomClamp && clamped)) fail(`${name}: ${anchor} moved ${drift}px (final ${finalDrift}px)`)
  if (sideways) fail(`${name}: sideways movement or overflow`)
  return step
}

const draftRoutes = () => page.evaluate(() => {
  const raw = sessionStorage.getItem('pancake:trade-composer-draft')
  if (!raw) return null
  const find = value => {
    if (!value || typeof value !== 'object') return typeof value === 'string' && value.startsWith('{') ? find(JSON.parse(value)) : null
    if (Array.isArray(value.items)) return value
    for (const entry of Object.values(value)) { const found = find(entry); if (found) return found }
    return null
  }
  return find(JSON.parse(raw))
})
const assetNames = () => page.evaluate(() => Object.fromEntries([...document.querySelectorAll('[data-testid^="trade-remove-"]')]
  .filter(node => /-(player|pick)-/.test(node.dataset.testid))
  .map(node => [node.dataset.testid.replace(/^trade-remove-[^-]+(?:-[^-]+){4}-/, '').replace(/^(player|pick)-/, ''), node.getAttribute('aria-label').replace(/^Remove /, '').replace(/ from trade$/, '')])))
const teamNames = async () => Object.fromEntries([[fixture.memberId, 'You'], [fixture.otherMemberId, fixture.recipientTeamName], [fixture.thirdMemberId, fixture.thirdTeamName]])
const shownRoutes = scope => page.evaluate(scopeSelector => {
  const root = scopeSelector ? document.querySelector(scopeSelector) : document
  if (!root) return null
  const headings = [...root.querySelectorAll('[role="heading"]')].filter(node => / gets?$/.test(node.getAttribute('aria-label') ?? '') && node.getClientRects().length)
  return headings.map(heading => ({
    receiver: heading.getAttribute('aria-label').replace(/ gets?$/, ''),
    rows: [...heading.parentElement.children].slice(1).map(row => row.innerText.replace(/\s+/g, ' ').trim()).filter(Boolean),
  }))
}, scope)

const compareRoutes = async (screen, scope) => {
  const draft = await draftRoutes()
  const names = { ...await assetNames(), ...receipt.names }
  receipt.names = names
  const members = await teamNames()
  const shown = await shownRoutes(scope)
  const expected = (draft?.items ?? []).filter(item => item.kind !== 'faab').map(item => {
    const id = item.kind === 'player' ? item.playerId : item.pickId
    return { kind: item.kind, id, name: names[id] ?? id, from: members[item.fromMemberId], to: members[item.toMemberId] }
  })
  const result = { screen, expected, shown, mismatches: [] }
  if (!shown?.length) result.mismatches.push('no receiving-team groups shown')
  for (const route of expected) {
    const group = shown?.find(entry => entry.receiver === route.to)
    const token = route.kind === 'player' ? route.name : route.name.replace(/ pick via .*/, '').replace(/^(\d{4}) /, '$1 ')
    const row = group?.rows.find(text => text.includes(token.split(' pick via ')[0].replace(/ pick$/, '')) && text.includes(`From ${route.from}`))
    if (!row) result.mismatches.push(`${route.name}: expected under ${route.to} from ${route.from}`)
  }
  const shownCount = (shown ?? []).reduce((total, group) => total + group.rows.filter(text => text.includes('From ')).length, 0)
  if (shownCount !== expected.length) result.mismatches.push(`shown ${shownCount} routed rows, draft has ${expected.length}`)
  receipt.routes.push(result)
  for (const mismatch of result.mismatches) fail(`${screen}: ${mismatch}`)
  return result
}

const addFromSheet = async (openLabel, count, kind) => {
  await tap(openLabel)
  const sheet = dialog()
  const pattern = kind === 'pick' ? /^Select .+ pick via .+ for trade$/ : /^Add .+ to trade$/
  const candidates = sheet.getByRole('button', { name: pattern })
  let added = 0
  for (let index = 0; added < count && index < await candidates.count(); index++) {
    const candidate = candidates.nth(index)
    if (await candidate.getAttribute('aria-disabled') === 'true') continue
    const name = (await candidate.getAttribute('aria-label')).replace(/^(Add|Select) /, '').replace(/ (to|for) trade$/, '')
    await candidate.scrollIntoViewIfNeeded()
    await candidate.tap()
    await page.waitForTimeout(300)
    receipt.added = [...receipt.added ?? [], name]
    added++
  }
  await closeSheet()
  assert.equal(added, count, `Could not add ${count} ${kind}s from ${openLabel}`)
}
const route = async (sender, asset, id, toName) => {
  await page.locator(`[data-testid="trade-route-${sender}-${asset}-${id}"]:visible`).tap()
  await page.waitForTimeout(300)
  await dialog().getByRole('button', { name: new RegExp(`^Route .+ to ${toName}$`) }).first().tap()
  await page.waitForTimeout(400)
}
const selectedIds = async (sender, asset) => page.evaluate(([member, kind]) => [...document.querySelectorAll(`[data-testid^="trade-remove-${member}-${kind}-"]`)]
  .filter(node => node.getClientRects().length).map(node => node.dataset.testid.slice(`trade-remove-${member}-${kind}-`.length)), [sender, asset])

try {
  await page.goto(run.url + '/sign-in')
  await page.waitForLoadState('networkidle')
  await page.getByPlaceholder('you@example.com').filter({ visible: true }).fill(state.users[0].email)
  await page.getByPlaceholder('Your password').filter({ visible: true }).fill(state.password)
  await button('Sign In').tap()
  await page.waitForURL(url => !url.pathname.includes('sign-in'))
  await page.getByRole('link', { name: /Trades/ }).filter({ visible: true }).first().tap().catch(() => page.goto(run.url + '/trades'))
  await page.waitForTimeout(1500)
  await shot('trades-reference')
  await tap('Propose trade')
  await page.waitForTimeout(1500)
  await tap('Choose a team to trade with')
  await tap(`Trade with ${fixture.recipientTeamName}`)
  await page.waitForTimeout(1500)
  if (teams === 3) {
    await tap('Add another team to this trade')
    await tap(`Trade with ${fixture.thirdTeamName}`)
    await page.waitForTimeout(1500)
  }
  await addFromSheet('Add players, picks or FAAB from your team', 2, 'player')
  await addFromSheet('Add players, picks or FAAB from your team', 1, 'pick')
  await addFromSheet(`Add players, picks or FAAB from ${fixture.recipientTeamName}`, 1, 'player')
  await addFromSheet(`Add players, picks or FAAB from ${fixture.recipientTeamName}`, 1, 'pick')
  await page.waitForTimeout(2500)
  const lastSender = teams === 3 ? fixture.thirdTeamName : fixture.recipientTeamName
  const lastMember = teams === 3 ? fixture.thirdMemberId : fixture.otherMemberId
  const anchor = `${lastSender} sends`
  if (teams === 3) {
    await addFromSheet(`Add players, picks or FAAB from ${fixture.thirdTeamName}`, 1, 'player')
    const [thirdPlayer] = await selectedIds(fixture.thirdMemberId, 'player')
    await route(fixture.thirdMemberId, 'player', thirdPlayer, fixture.proposerTeamName)
    const [myPick] = await selectedIds(fixture.memberId, 'pick')
    await route(fixture.memberId, 'pick', myPick, fixture.thirdTeamName)
    const [teamTwoPick] = await selectedIds(fixture.otherMemberId, 'pick')
    await route(fixture.otherMemberId, 'pick', teamTwoPick, fixture.proposerTeamName)
    await page.waitForTimeout(2500)
  }
  await page.evaluate(() => { const scroller = [...document.querySelectorAll('*')].filter(node => node.clientHeight > 200 && /auto|scroll/.test(getComputedStyle(node).overflowY)).sort((a, b) => b.clientHeight - a.clientHeight)[0]; if (scroller) scroller.scrollTop = 0 })
  await page.waitForTimeout(500)
  await shot('propose-top')
  await page.screenshot({ path: `${prefix}-propose-full.png`, fullPage: true, animations: 'disabled' })
  await compareRoutes('propose')

  if (option('details', '0') === '1') await tap('Show trade value details')
  const middle = `${fixture.recipientTeamName} sends`
  await measured('add', middle, () => addFromSheet(`Add players, picks or FAAB from ${fixture.recipientTeamName}`, 1, 'player'))
  if (teams === 3) {
    const ids = await selectedIds(fixture.otherMemberId, 'player')
    await measured('remove', middle, () => page.locator(`[data-testid="trade-remove-${fixture.otherMemberId}-player-${ids.at(-1)}"]:visible`).tap())
    const [rerouted] = await selectedIds(fixture.otherMemberId, 'player')
    await measured('reroute', middle, () => route(fixture.otherMemberId, 'player', rerouted, fixture.thirdTeamName))
    await measured('add-last', anchor, () => addFromSheet(`Add players, picks or FAAB from ${lastSender}`, 1, 'player'))
    const lastIds = await selectedIds(lastMember, 'player')
    await measured('remove-last', anchor, () => page.locator(`[data-testid="trade-remove-${lastMember}-player-${lastIds.at(-1)}"]:visible`).tap(), { allowBottomClamp: true })
  } else {
    const mine = await selectedIds(fixture.memberId, 'player')
    await measured('remove', 'You send', () => page.locator(`[data-testid="trade-remove-${fixture.memberId}-player-${mine.at(-1)}"]:visible`).tap())
    await measured('add-pick', middle, () => addFromSheet(`Add players, picks or FAAB from ${fixture.recipientTeamName}`, 1, 'pick'))
    const theirs = await selectedIds(fixture.otherMemberId, 'player')
    await measured('remove-last', middle, () => page.locator(`[data-testid="trade-remove-${fixture.otherMemberId}-player-${theirs.at(-1)}"]:visible`).tap(), { allowBottomClamp: true })
  }
  await page.waitForTimeout(2000)
  await compareRoutes('propose-after-edits')

  const review = button('Review trade proposal')
  if (await review.getAttribute('aria-disabled') === 'true') fail('Review stayed disabled')
  else {
    await review.tap()
    await page.waitForTimeout(3000)
    await shot('review-top')
    await page.screenshot({ path: `${prefix}-review-full.png`, fullPage: true, animations: 'disabled' })
    await compareRoutes('review', '[data-testid="trade-review-card"]')
    receipt.reviewValueShown = await page.locator('[data-testid="trade-value"]:visible').count() > 0
    receipt.reviewSendVisible = await page.getByRole('button', { name: 'Send', exact: true }).count()
    receipt.reviewOverflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)
    if (receipt.reviewOverflow) fail('review: sideways overflow')
    await tap('Close trade review')
  }
  receipt.submitted = false
} catch (error) {
  fail(`driver: ${error.message.split('\n')[0]}`)
  await shot('error').catch(() => {})
} finally {
  await writeFile(`${prefix}-receipt.json`, JSON.stringify(receipt, null, 2))
  await context.close()
  await browser.close()
}
console.log(JSON.stringify({ label, teams, width, failures: receipt.failures, steps: receipt.steps.map(step => ({ name: step.name, drift: step.maxAnchorDrift, final: step.finalAnchorDrift, sideways: step.sideways, scrollDelta: step.scrollDelta, bottomClamp: step.bottomClamp })) }))
process.exitCode = receipt.failures.length ? 1 : 0
