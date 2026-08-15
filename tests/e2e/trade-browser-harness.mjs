import path from 'node:path'
import process from 'node:process'
import { createBrowser, fillSignInCredentials, listBrowserSessions } from './browser-agent.mjs'
import { installRuntimeOverrides } from './browser-runtime-overrides.mjs'

/** @typedef {{ frontendUrl: string, apiBaseUrl: string, supabaseUrl: string, anonKey: string }} BrowserEnv */
/** @typedef {{ email: string }} BrowserUser */

export const ROOT = process.cwd()
export const ARTIFACT_ROOT = path.join(ROOT, 'tests/artifacts')
export const MULTI_TEAM_REPORT_PATH = path.join(ROOT, 'tests/e2e-browser-trade-multi-team-report.md')
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
