import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { resolvedEnv, requireEnv, describeEndpoint } from './env.mjs'
import { normalizeBrowserErrors } from './browser-runtime-overrides.mjs'
import { createBrowser, listBrowserSessions } from './browser-agent.mjs'
import { assertPageText, clickButton, installBrowserHooks, signInBrowser } from './trade-browser-harness.mjs'
import { setupTradeGameplayFixture } from './trade-fixture.mjs'

export { mkdir, writeFile, path, resolvedEnv, requireEnv, describeEndpoint, normalizeBrowserErrors }
export { assertPageText, clickButton, installBrowserHooks, signInBrowser }
export { setupTradeGameplayFixture }

export const ROOT = process.cwd()
export const ARTIFACT_ROOT = path.join(ROOT, 'tests/artifacts')
export const REPORT_PATH = path.join(ROOT, 'tests/e2e-browser-trade-report.md')
export const ACCEPT_REPORT_PATH = path.join(ROOT, 'tests/e2e-browser-trade-accept-report.md')
export const TERMINAL_REPORT_PATH = path.join(ROOT, 'tests/e2e-browser-trade-terminal-report.md')
export const FUTURE_PICK_REPORT_PATH = path.join(ROOT, 'tests/e2e-browser-trade-future-pick-report.md')
export const FUTURE_PICK_ACCEPT_REPORT_PATH = path.join(ROOT, 'tests/e2e-browser-trade-future-pick-accept-report.md')
export const OVERFLOW_ACCEPT_REPORT_PATH = path.join(ROOT, 'tests/e2e-browser-trade-overflow-accept-report.md')
export const POST_DEADLINE_REPORT_PATH = path.join(ROOT, 'tests/e2e-browser-trade-post-deadline-report.md')
export const VETO_REPORT_PATH = path.join(ROOT, 'tests/e2e-browser-trade-veto-report.md')
export const MULTI_TEAM_REPORT_PATH = path.join(ROOT, 'tests/e2e-browser-trade-multi-team-report.md')

export const browser = createBrowser({ cwd: ROOT })

export const listSessions = () => listBrowserSessions({ cwd: ROOT })

export const safeName = (value) => value.replace(/[^a-zA-Z0-9._-]/g, '-')
export const tradeSessionName = (code, runId) => safeName(`pc-${code}-${runId}-${process.pid}`)
export const joinUrl = (base, pathname) => new URL(pathname, base.endsWith('/') ? base : `${base}/`).toString()
export const parseEvalJson = (output) => {
  const line = output.split('\n').filter(Boolean).at(-1)
  const value = JSON.parse(line)
  return typeof value === 'string' ? JSON.parse(value) : value
}

export const clickLastButton = async (session, name, label) => {
  const output = await browser(session, [
    'eval',
    `(() => {
      const candidates = [...document.querySelectorAll('[role="button"], button, [tabindex]')]
        .filter((element) => element.getAttribute('aria-label') === ${JSON.stringify(name)} || (element.textContent || '').trim() === ${JSON.stringify(name)});
      const visibleCandidates = candidates.filter((element) => {
        element.scrollIntoView({ block: 'center', inline: 'center' });
        const rect = element.getBoundingClientRect();
        const style = window.getComputedStyle(element);
        const disabled = Boolean(element.disabled) || element.getAttribute('aria-disabled') === 'true';
        if (disabled || style.visibility === 'hidden' || style.display === 'none' || style.pointerEvents === 'none') return false;
        if (rect.width <= 0 || rect.height <= 0) return false;
        const x = rect.left + rect.width / 2;
        const y = rect.top + rect.height / 2;
        const hit = document.elementFromPoint(x, y);
        return hit === element || element.contains(hit);
      });
      const target = visibleCandidates.at(-1);
      if (!target) return JSON.stringify({ ok: false, body: (document.body?.innerText || '').slice(0, 1400), count: candidates.length, visibleCount: visibleCandidates.length });
      const rect = target.getBoundingClientRect();
      const init = {
        bubbles: true,
        cancelable: true,
        view: window,
        clientX: rect.left + rect.width / 2,
        clientY: rect.top + rect.height / 2,
      };
      const Pointer = window.PointerEvent || window.MouseEvent;
      target.dispatchEvent(new Pointer('pointerdown', { ...init, pointerId: 1, pointerType: 'mouse', isPrimary: true }));
      target.dispatchEvent(new MouseEvent('mousedown', init));
      target.dispatchEvent(new Pointer('pointerup', { ...init, pointerId: 1, pointerType: 'mouse', isPrimary: true }));
      target.dispatchEvent(new MouseEvent('mouseup', init));
      target.dispatchEvent(new MouseEvent('click', init));
      return JSON.stringify({
        ok: true,
        tagName: target.tagName,
        role: target.getAttribute('role'),
        ariaLabel: target.getAttribute('aria-label'),
        text: target.textContent,
      });
    })()`,
  ])
  const parsed = parseEvalJson(output)
  if (!parsed.ok) throw new Error(`${label}: visible enabled button not found: ${name}. Body: ${parsed.body}`)
  return parsed
}

export const readButtonState = async (session, name, label) => {
  const output = await browser(session, [
    'eval',
    `(() => {
      const named = [...document.querySelectorAll('[aria-label], [role="button"], button')]
        .find((element) => element.getAttribute('aria-label') === ${JSON.stringify(name)} || (element.textContent || '').trim() === ${JSON.stringify(name)});
      const target = named?.closest?.('[role="button"], button, [tabindex]') || named;
      if (!target) return JSON.stringify({ ok: false, body: (document.body?.innerText || '').slice(0, 1400) });
      const style = window.getComputedStyle(target);
      return JSON.stringify({
        ok: true,
        disabled: Boolean(target.disabled),
        ariaDisabled: target.getAttribute('aria-disabled'),
        pointerEvents: style.pointerEvents,
        opacity: style.opacity,
        role: target.getAttribute('role'),
        ariaLabel: target.getAttribute('aria-label'),
        text: target.textContent,
      });
    })()`,
  ])
  const parsed = parseEvalJson(output)
  if (!parsed.ok) throw new Error(`${label}: button not found: ${name}. Body: ${parsed.body}`)
  return parsed
}

export const clickTab = async (session, namePrefix, label) => {
  const output = await browser(session, [
    'eval',
    `(() => {
      const norm = (value) => (value || '').trim();
      const target = [...document.querySelectorAll('[role="tab"], [role="button"], button, [tabindex]')]
        .find((element) => {
          const name = norm(element.getAttribute('aria-label')) || norm(element.textContent);
          return name === ${JSON.stringify(namePrefix)} || name.startsWith(${JSON.stringify(namePrefix + ',')}) || name.startsWith(${JSON.stringify(namePrefix)});
        });
      if (!target) return JSON.stringify({ ok: false, body: (document.body?.innerText || '').slice(0, 1400) });
      target.scrollIntoView({ block: 'center', inline: 'center' });
      target.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse' }));
      target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
      target.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
      target.click();
      return JSON.stringify({ ok: true, ariaLabel: target.getAttribute('aria-label'), role: target.getAttribute('role') });
    })()`,
  ])
  const parsed = parseEvalJson(output)
  if (!parsed.ok) throw new Error(`${label}: tab not found: ${namePrefix}. Body: ${parsed.body}`)
  return parsed
}

export const openOffersTab = async (session, env) => {
  await browser(session, ['open', joinUrl(env.frontendUrl, '/trades')])
  await installBrowserHooks(session, env)
  await browser(session, ['wait', '2500'])
  await clickTab(session, 'Offers', 'offers tab')
  await browser(session, ['wait', '2500'])
}

export const readBrowserAlerts = async (session) => {
  const output = await browser(session, [
    'eval',
    `(() => JSON.stringify(window.__pancakeAlerts || []))()`,
  ])
  return parseEvalJson(output)
}

export * from './browser-trade-fixtures.mjs'
export * from './browser-trade-verification.mjs'
