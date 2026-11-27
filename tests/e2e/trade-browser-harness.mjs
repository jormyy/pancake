import { browserArtifactPath } from './browser-artifacts.mjs'
import process from 'node:process'
import { createBrowser, fillSignInCredentials, listBrowserSessions } from './browser-agent.mjs'
import { installRuntimeOverrides } from './browser-runtime-overrides.mjs'

/** @typedef {{ frontendUrl: string, apiBaseUrl: string, supabaseUrl: string, anonKey: string }} BrowserEnv */
/** @typedef {{ email: string }} BrowserUser */

export const ROOT = process.cwd()
export const ARTIFACT_ROOT = browserArtifactPath('artifacts')
export const MULTI_TEAM_REPORT_PATH = browserArtifactPath('e2e-browser-trade-multi-team-report.md')
export const browser = createBrowser({ cwd: ROOT })
export const listSessions = () => listBrowserSessions({ cwd: ROOT })
/** @param {string} base @param {string} pathname */
export const joinUrl = (base, pathname) => new URL(pathname, base.endsWith('/') ? base : `${base}/`).toString()
/** @param {string} value */
export const safeName = (value) => value.replace(/[^a-zA-Z0-9._-]/g, '-')
/** @param {string} code @param {string} runId */
export const tradeSessionName = (code, runId) =>
  safeName(`pc-${code}-${runId}-${process.pid}`)

/** @param {string} output @returns {unknown} */
const parseEvalJson = (output) => {
  const line = output.split('\n').filter(Boolean).at(-1)
  if (!line) throw new Error('browser eval returned no JSON output')
  const value = JSON.parse(line)
  return typeof value === 'string' ? JSON.parse(value) : value
}

/** @param {string} session @param {BrowserEnv} env @param {{ openBeforeSet?: boolean, reloadAfterSet?: boolean }} [options] */
export const installBrowserHooks = async (session, env, options = {}) => {
  await installRuntimeOverrides(browser, session, env, {
    alerts: true,
    confirm: true,
    openBeforeSet: options.openBeforeSet ?? false,
    reloadAfterSet: options.reloadAfterSet ?? false,
  })
}

/** @param {string} session */
const authState = async (session) => {
  const parsed = parseEvalJson(await browser(session, ['eval', `(() => {
  const text = document.body?.innerText || '';
  return JSON.stringify({
    url: location.href,
    isSignIn: text.includes('Sign In') && text.includes("Don't have an account?"),
    sample: text.slice(0, 400)
  });
})()`]))
  if (!parsed || typeof parsed !== 'object') throw new Error('browser auth state was not an object')
  return {
    isSignIn: Reflect.get(parsed, 'isSignIn') === true,
    url: String(Reflect.get(parsed, 'url') ?? ''),
    sample: String(Reflect.get(parsed, 'sample') ?? ''),
  }
}

/** @param {string} session */
const submitSignIn = async (session) => {
  const result = parseEvalJson(await browser(session, ['eval', `(() => {
    const candidates = [...document.querySelectorAll('[aria-label], [role="button"], button')];
    const named = candidates.find((element) => element.getAttribute('aria-label') === 'Sign In' || (element.textContent || '').trim() === 'Sign In');
    const textNode = named || [...document.querySelectorAll('*')].reverse().find((element) => (element.textContent || '').trim() === 'Sign In');
    const target = textNode?.closest?.('[role="button"], button, [tabindex]') || textNode;
    if (!target) return JSON.stringify({ ok: false, sample: (document.body?.innerText || '').slice(0, 400) });
    target.click();
    return JSON.stringify({ ok: true });
  })()`]))
  if (!result || typeof result !== 'object' || Reflect.get(result, 'ok') !== true) {
    throw new Error(`browser trade sign-in button not found: ${String(result && typeof result === 'object' ? Reflect.get(result, 'sample') : '')}`)
  }
}

/** @param {string} session @param {BrowserEnv} env @param {BrowserUser} user @param {string} password */
export const signInBrowser = async (session, env, user, password) => {
  await installBrowserHooks(session, env, { openBeforeSet: true, reloadAfterSet: true })
  await browser(session, ['wait', '1500'])
  /** @type {{ isSignIn: boolean, url: string, sample: string } | null} */
  let state = null
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    await fillSignInCredentials(browser, session, user.email, password)
    await submitSignIn(session)
    await browser(session, ['wait', '4000'])
    state = await authState(session)
    if (!state.isSignIn) return
    if (attempt < 3) {
      await browser(session, ['open', env.frontendUrl])
      await installBrowserHooks(session, env)
      await browser(session, ['wait', '1500'])
    }
  }
  throw new Error(`browser trade sign-in stayed on auth screen at ${state?.url ?? '<unknown>'}: ${state?.sample ?? '<no sample>'}`)
}

/** @param {string} session @param {string[]} required @param {string} label */
export const assertPageText = async (session, required, label) => {
  // Poll instead of asserting a single snapshot: responsive re-layout after a
  // viewport switch can take longer than the scenario's fixed waits.
  let parsed
  const deadline = Date.now() + 10_000
  do {
    parsed = parseEvalJson(await browser(session, ['eval', `(() => {
    const text = document.body?.innerText || '';
    const required = ${JSON.stringify(required)};
    return JSON.stringify({
      ok: required.every((value) => text.includes(value)),
      missing: required.filter((value) => !text.includes(value)),
      sample: text.slice(0, 1200) + ' [iw=' + window.innerWidth + ' url=' + location.pathname + ' nodes=' + document.querySelectorAll('*').length + ']'
    });
  })()`]))
    if (parsed && typeof parsed === 'object' && Reflect.get(parsed, 'ok') === true) break
    await browser(session, ['wait', '500'])
  } while (Date.now() < deadline)
  if (!parsed || typeof parsed !== 'object' || Reflect.get(parsed, 'ok') !== true) {
    const missing = parsed && typeof parsed === 'object' && Array.isArray(Reflect.get(parsed, 'missing'))
      ? Reflect.get(parsed, 'missing').join(', ')
      : '<invalid result>'
    throw new Error(`${label} missing page text: ${missing}. Sample: ${String(parsed && typeof parsed === 'object' ? Reflect.get(parsed, 'sample') : '')}`)
  }
  return parsed
}

/** @param {string} session @param {string} testID @param {string} label */
export const clickTestId = async (session, testID, label) => {
  if (testID.startsWith('trade-sender-') || testID === 'trade-deal-summary') {
    const memberId = testID.slice('trade-sender-'.length)
    const output = await browser(session, ['eval', `(() => {
      const visible = ${JSON.stringify(testID)} === 'trade-deal-summary'
        ? [...document.querySelectorAll('[role="button"]')].some((node) => node.getAttribute('aria-label')?.startsWith('Remove ') && node.getAttribute('aria-label')?.includes(' sent by ') && node.getAttribute('aria-label')?.endsWith(' from trade') && node.getBoundingClientRect().width > 0)
        : [...document.querySelectorAll('[data-testid]')].some((node) =>
          ['trade-' + ${JSON.stringify(memberId)} + '-player-', 'trade-' + ${JSON.stringify(memberId)} + '-pick-', 'trade-faab-' + ${JSON.stringify(memberId)}]
            .some((prefix) => node.getAttribute('data-testid').startsWith(prefix)) && node.getBoundingClientRect().width > 0);
      const control = document.querySelector(${JSON.stringify(`[data-testid="${testID}"]`)})
        || document.getElementById(${JSON.stringify(testID)});
      return JSON.stringify({ ok: visible, layout: 'desktop', panelsVisible: visible, hasControl: Boolean(control?.getClientRects().length) });
    })()`])
    const result = parseEvalJson(output)
    if (!result || typeof result !== 'object') throw new Error(`${label}: invalid sender or overview state`)
    if (Reflect.get(result, 'hasControl') !== true) {
      if (Reflect.get(result, 'ok') !== true) throw new Error(`${label}: desktop sender or overview panel is missing`)
      return result
    }
  }
  const result = parseEvalJson(await browser(session, ['eval', `(() => {
    const target = document.querySelector(${JSON.stringify(`[data-testid="${testID}"]`)})
      || document.querySelector(${JSON.stringify(`[testid="${testID}"]`)})
      || document.getElementById(${JSON.stringify(testID)});
    if (!target) return JSON.stringify({ ok: false, body: (document.body?.innerText || '').slice(0, 1200) });
    target.scrollIntoView({ block: 'center', inline: 'center' });
    target.click();
    return JSON.stringify({ ok: true });
  })()`]))
  if (!result || typeof result !== 'object' || Reflect.get(result, 'ok') !== true) {
    throw new Error(`${label}: testID not found: ${testID}. Body: ${String(result && typeof result === 'object' ? Reflect.get(result, 'body') : '')}`)
  }
  return result
}

/** @param {string} session @param {string} script @param {string} label @param {number} [timeoutMs] */
const waitForEval = async (session, script, label, timeoutMs = 10_000) => {
  const deadline = Date.now() + timeoutMs
  let parsed
  do {
    parsed = parseEvalJson(await browser(session, ['eval', script]))
    if (parsed && typeof parsed === 'object' && Reflect.get(parsed, 'ok') === true) return parsed
    await browser(session, ['wait', '250'])
  } while (Date.now() < deadline)
  throw new Error(`${label}: ${String(parsed && typeof parsed === 'object' ? Reflect.get(parsed, 'body') : '<invalid result>')}`)
}

const visibleDialogScript = `[...document.querySelectorAll('[role="dialog"], [aria-modal="true"]')].filter((node) => node.getBoundingClientRect().width > 0)`

/** @param {string} session @param {string} label */
const closeTradeSheet = async (session, label) => {
  await browser(session, ['press', 'Escape'])
  const closed = async () => parseEvalJson(await browser(session, ['eval', `(() => JSON.stringify({ ok: ${visibleDialogScript}.length === 0 }))()`]))
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const state = await closed()
    if (state && typeof state === 'object' && Reflect.get(state, 'ok') === true) return
    if (attempt === 4) {
      await browser(session, ['eval', `(() => { const dialogs = ${visibleDialogScript}; const button = dialogs.at(-1)?.querySelector('[role="button"][aria-label="Close"]'); button?.click(); return JSON.stringify({ ok: Boolean(button) }) })()`])
    }
    await browser(session, ['wait', '250'])
  }
  throw new Error(`${label}: trade sheet did not close`)
}

/** @param {string} session @param {string} memberId @param {string[]} testIDs @param {string} label */
export const addTradeAssets = async (session, memberId, testIDs, label) => {
  const openClick = await clickTestId(session, `trade-add-assets-${memberId}`, `${label} open asset sheet`)
  const clicks = []
  for (const testID of testIDs) {
    const selector = JSON.stringify(`[data-testid="${testID}"]`)
    await waitForEval(session, `(() => {
      const target = document.querySelector(${selector});
      const ok = Boolean(target && target.getBoundingClientRect().width > 0 && target.getAttribute('aria-disabled') !== 'true');
      return JSON.stringify({ ok, body: (document.body?.innerText || '').slice(0, 1200) });
    })()`, `${label}: asset ${testID} not ready`)
    clicks.push(await clickTestId(session, testID, `${label} ${testID}`))
    await waitForEval(session, `(() => {
      const target = document.querySelector(${selector});
      const ok = target?.getAttribute('aria-pressed') === 'true' || target?.getAttribute('aria-selected') === 'true' || Boolean(target?.getAttribute('aria-label')?.startsWith('Remove '));
      return JSON.stringify({ ok, body: (document.body?.innerText || '').slice(0, 1200) });
    })()`, `${label}: asset ${testID} was not selected`)
  }
  await closeTradeSheet(session, label)
  return { openClick, clicks }
}

/** @param {string} session @param {string} memberId @param {'player' | 'pick'} asset @param {string} assetId @param {string} destinationId @param {string} label */
export const routeTradeAsset = async (session, memberId, asset, assetId, destinationId, label) => {
  const openClick = await clickTestId(session, `trade-route-${memberId}-${asset}-${assetId}`, `${label} open route sheet`)
  const testID = `trade-${asset}-route-${memberId}-${assetId}-${destinationId}`
  await waitForEval(session, `(() => {
    const target = document.querySelector(${JSON.stringify(`[data-testid="${testID}"]`)});
    return JSON.stringify({ ok: Boolean(target && target.getBoundingClientRect().width > 0), body: (document.body?.innerText || '').slice(0, 1200) });
  })()`, `${label}: route ${testID} not ready`)
  const routeClick = await clickTestId(session, testID, label)
  await waitForEval(session, `(() => JSON.stringify({ ok: ${visibleDialogScript}.length === 0, body: (document.body?.innerText || '').slice(0, 1200) }))()`, `${label}: route sheet did not close`)
  return { openClick, routeClick }
}

/** @param {string} session @param {string} memberId @param {string} label */
export const addTradePartner = async (session, memberId, label) => {
  const openClick = await clickTestId(session, 'trade-add-team', `${label} open team picker`)
  const testID = `trade-participant-${memberId}`
  await waitForEval(session, `(() => {
    const target = ${visibleDialogScript}.map((dialog) => dialog.querySelector(${JSON.stringify(`[data-testid="${testID}"]`)})).find(Boolean);
    return JSON.stringify({ ok: Boolean(target), body: (document.body?.innerText || '').slice(0, 1200) });
  })()`, `${label}: team ${memberId} not offered`)
  const pickClick = parseEvalJson(await browser(session, ['eval', `(() => {
    const target = ${visibleDialogScript}.map((dialog) => dialog.querySelector(${JSON.stringify(`[data-testid="${testID}"]`)})).find(Boolean);
    target?.click();
    return JSON.stringify({ ok: Boolean(target) });
  })()`]))
  await waitForEval(session, `(() => JSON.stringify({ ok: ${visibleDialogScript}.length === 0 && Boolean(document.querySelector(${JSON.stringify(`[data-testid="trade-add-assets-${memberId}"]`)})), body: (document.body?.innerText || '').slice(0, 1200) }))()`, `${label}: team ${memberId} was not added`)
  return { openClick, pickClick }
}

/** @param {string} session @param {string} label @param {'trade-confirm-submit' | 'trade-confirm-accept'} [testID] */
const confirmTradeReview = async (session, label, testID = 'trade-confirm-submit') => {
  const selector = JSON.stringify(`[data-testid="${testID}"]`)
  await waitForEval(session, `(() => {
    const target = document.querySelector(${selector});
    const ok = Boolean(target && target.getBoundingClientRect().width > 0 && target.getAttribute('aria-disabled') !== 'true' && !target.disabled);
    return JSON.stringify({ ok, body: (document.body?.innerText || '').slice(0, 1600) });
  })()`, `${label}: ${testID} did not become ready`, 20_000)
  return clickTestId(session, testID, label)
}

/** @param {string} session @param {string} label */
export const reviewAndSendTrade = async (session, label) => {
  const reviewClick = await clickTestId(session, 'trade-submit', `${label} review`)
  await assertPageText(session, ['Send', 'Valid roster'], `${label} final review`)
  const confirmClick = await confirmTradeReview(session, `${label} send`)
  return { reviewClick, confirmClick }
}

/** @param {string} session @param {string} name @param {string} label */
export const clickLastButton = async (session, name, label) => {
  const result = parseEvalJson(await browser(session, ['eval', `(() => {
    const candidates = [...document.querySelectorAll('[role="button"], button, [tabindex]')]
      .filter((element) => element.getAttribute('aria-label') === ${JSON.stringify(name)} || (element.textContent || '').trim() === ${JSON.stringify(name)})
      .filter((element) => {
        element.scrollIntoView({ block: 'center', inline: 'center' });
        const rect = element.getBoundingClientRect();
        const style = window.getComputedStyle(element);
        if (element.getAttribute('aria-disabled') === 'true' || style.display === 'none' || style.visibility === 'hidden') return false;
        return rect.width > 0 && rect.height > 0;
      });
    const target = candidates.at(-1);
    if (!target) return JSON.stringify({ ok: false, body: (document.body?.innerText || '').slice(0, 1400) });
    target.click();
    return JSON.stringify({ ok: true, ariaLabel: target.getAttribute('aria-label'), text: target.textContent });
  })()`]))
  if (!result || typeof result !== 'object' || Reflect.get(result, 'ok') !== true) {
    throw new Error(`${label}: visible enabled button not found: ${name}. Body: ${String(result && typeof result === 'object' ? Reflect.get(result, 'body') : '')}`)
  }
  return result
}

/** @param {string} session @param {string} name @param {string} label */
export const readButtonState = async (session, name, label) => {
  const result = parseEvalJson(await browser(session, ['eval', `(() => {
    const named = [...document.querySelectorAll('[aria-label], [role="button"], button')]
      .find((element) => element.getAttribute('aria-label') === ${JSON.stringify(name)} || (element.textContent || '').trim() === ${JSON.stringify(name)});
    const target = named?.closest?.('[role="button"], button, [tabindex]') || named;
    if (!target) return JSON.stringify({ ok: false, body: (document.body?.innerText || '').slice(0, 1400) });
    return JSON.stringify({
      ok: true,
      disabled: Boolean(target.disabled),
      ariaDisabled: target.getAttribute('aria-disabled'),
      pointerEvents: window.getComputedStyle(target).pointerEvents,
    });
  })()`]))
  if (!result || typeof result !== 'object' || Reflect.get(result, 'ok') !== true) {
    throw new Error(`${label}: button not found: ${name}. Body: ${String(result && typeof result === 'object' ? Reflect.get(result, 'body') : '')}`)
  }
  return {
    disabled: Reflect.get(result, 'disabled') === true,
    ariaDisabled: Reflect.get(result, 'ariaDisabled') === 'true' ? 'true' : null,
    pointerEvents: String(Reflect.get(result, 'pointerEvents') ?? ''),
  }
}

/** @param {string} session */
export const readBrowserAlerts = async (session) => {
  const result = parseEvalJson(await browser(session, ['eval', '(() => JSON.stringify(window.__pancakeAlerts || []))()']))
  if (!Array.isArray(result)) throw new Error('browser alerts result was not an array')
  return result.map(String)
}

/** @param {string} session @param {string} name */
const clickTab = async (session, name) => {
  const parsed = parseEvalJson(await browser(session, ['eval', `(() => {
    const norm = (value) => (value || '').trim();
    const target = [...document.querySelectorAll('[role="tab"], [role="button"], button, [tabindex]')]
      .find((element) => {
        const accessibleName = norm(element.getAttribute('aria-label')) || norm(element.textContent);
        return accessibleName === ${JSON.stringify(name)} || accessibleName.startsWith(${JSON.stringify(`${name},`)}) || accessibleName.startsWith(${JSON.stringify(name)});
      });
    if (!target) return JSON.stringify({ ok: false, body: (document.body?.innerText || '').slice(0, 1400) });
    target.click();
    return JSON.stringify({ ok: true });
  })()`]))
  if (!parsed || typeof parsed !== 'object' || Reflect.get(parsed, 'ok') !== true) {
    throw new Error(`tab not found: ${name}. Body: ${String(parsed && typeof parsed === 'object' ? Reflect.get(parsed, 'body') : '')}`)
  }
}

/** @param {string} session @param {BrowserEnv} env */
export const openOffersTab = async (session, env) => {
  await browser(session, ['open', joinUrl(env.frontendUrl, '/trades')])
  await installBrowserHooks(session, env)
  await browser(session, ['wait', '2500'])
  await clickTab(session, 'Offers')
  await browser(session, ['wait', '2500'])
}
