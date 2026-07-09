import type path from 'node:path'
import type { resolvedEnv } from './env.mjs'

export { mkdir, writeFile } from 'node:fs/promises'
export { default as path } from 'node:path'
export { resolvedEnv, requireEnv, describeEndpoint } from './env.mjs'
export { normalizeBrowserErrors } from './browser-runtime-overrides.mjs'
export { setupTradeGameplayFixture } from './trade-fixture.mjs'
export * from './browser-trade-fixtures.mjs'

export const ROOT: string
export const ARTIFACT_ROOT: string
export const REPORT_PATH: string
export const ACCEPT_REPORT_PATH: string
export const TERMINAL_REPORT_PATH: string
export const FUTURE_PICK_REPORT_PATH: string
export const FUTURE_PICK_ACCEPT_REPORT_PATH: string
export const OVERFLOW_ACCEPT_REPORT_PATH: string
export const POST_DEADLINE_REPORT_PATH: string
export const VETO_REPORT_PATH: string

type Env = ReturnType<typeof resolvedEnv>
type BrowserResult = string
type Verification = { failures: string[]; [key: string]: unknown }

export function browser(session: string, args: string[], options?: { timeout?: number }): Promise<BrowserResult>
export function listSessions(): Promise<string>
export function safeName(value: string): string
export function tradeSessionName(code: string, runId: string): string
export function joinUrl(base: string, pathname: string): string
export function assertPageText(session: string, required: string[], label: string): Promise<void>
export function clickButton(session: string, name: string, label: string): Promise<unknown>
export function clickLastButton(session: string, name: string, label: string): Promise<unknown>
export function readButtonState(session: string, name: string, label: string): Promise<Record<string, unknown>>
export function installBrowserHooks(session: string, env: Env): Promise<void>
export function signInBrowser(session: string, env: Env, user: { email?: string }, password: string): Promise<void>
export function openOffersTab(session: string, env: Env): Promise<void>
export function readBrowserAlerts(session: string): Promise<unknown[]>

export function verifyTradeProposal(fixture: unknown): Promise<Verification>
export function waitForTradeProposal(fixture: unknown, timeoutMs?: number): Promise<Verification>
export function verifyPostDeadlineTradeRejected(fixture: unknown): Promise<Verification>
export function expireAndCompleteAcceptedTrade(fixture: unknown): Promise<unknown>
export function verifyFuturePickTradeProposal(fixture: unknown): Promise<Verification>
export function waitForFuturePickTradeProposal(fixture: unknown, timeoutMs?: number): Promise<Verification>
export function verifyTradeAccepted(fixture: unknown): Promise<Verification>
export function waitForTradeAccepted(fixture: unknown, timeoutMs?: number): Promise<Verification>
export function verifyFuturePickTradeAccepted(fixture: unknown): Promise<Verification>
export function waitForFuturePickTradeAccepted(fixture: unknown, timeoutMs?: number): Promise<Verification>
export function verifyOverflowTradeAccepted(fixture: unknown): Promise<Verification>
export function waitForOverflowTradeAccepted(fixture: unknown, timeoutMs?: number): Promise<Verification>
export function verifyTradeTerminalStatus(fixture: unknown, expectedStatus: string): Promise<Verification>
export function waitForTradeTerminalStatus(fixture: unknown, expectedStatus: string, timeoutMs?: number): Promise<Verification>
export function verifyTradeVetoed(fixture: unknown): Promise<Verification>
export function waitForTradeVetoed(fixture: unknown, timeoutMs?: number): Promise<Verification>
