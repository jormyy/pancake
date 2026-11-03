var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __hasOwnProp = Object.prototype.hasOwnProperty;
function __accessProp(key) {
  return this[key];
}
var __toCommonJS = (from) => {
  var entry = (__moduleCache ??= new WeakMap).get(from), desc;
  if (entry)
    return entry;
  entry = __defProp({}, "__esModule", { value: true });
  if (from && typeof from === "object" || typeof from === "function") {
    for (var key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(entry, key))
        __defProp(entry, key, {
          get: __accessProp.bind(from, key),
          enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable
        });
  }
  __moduleCache.set(from, entry);
  return entry;
};
var __moduleCache;
var __returnValue = (v) => v;
function __exportSetter(name, newValue) {
  this[name] = __returnValue.bind(null, newValue);
}
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, {
      get: all[name],
      enumerable: true,
      configurable: true,
      set: __exportSetter.bind(all, name)
    });
};

// server/live/vercel.ts
var exports_vercel = {};
__export(exports_vercel, {
  default: () => handler
});
module.exports = __toCommonJS(exports_vercel);

// supabase/functions/_shared/gameId.ts
function isRegularSeasonGameId(gameId) {
  const id = gameId?.trim();
  if (!id)
    return false;
  if (id.startsWith("002"))
    return true;
  if (/^00\d/.test(id))
    return false;
  return true;
}

// supabase/functions/_shared/workContext.ts
var import_node_async_hooks = require("node:async_hooks");
var workContext = new import_node_async_hooks.AsyncLocalStorage;
function currentWorkContext() {
  return workContext.getStore();
}
function requestHeaders() {
  const context = currentWorkContext();
  return context?.requestId && context.requestActor ? { "x-request-id": context.requestId, "x-request-actor": context.requestActor } : {};
}
async function workFetch(input, init) {
  const context = currentWorkContext();
  if (!context)
    return fetch(input, init);
  context.signal.throwIfAborted();
  const outer = init?.signal ?? (input instanceof Request ? input.signal : null);
  const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
  const url = new URL(input instanceof Request ? input.url : input);
  const runtime = globalThis;
  const databaseUrl = runtime.Deno?.env.get("SUPABASE_URL");
  const databaseOrigin = databaseUrl ? new URL(databaseUrl).origin : null;
  if (context.livePollHolder && url.origin === databaseOrigin)
    headers.set("x-pancake-live-holder", context.livePollHolder);
  else
    headers.delete("x-pancake-live-holder");
  if (context.livePollHolder && context.publicCheckpoint && url.origin === databaseOrigin)
    headers.set("x-pancake-public-checkpoint", "true");
  else
    headers.delete("x-pancake-public-checkpoint");
  if (context.workInvocation && url.origin === databaseOrigin)
    headers.set("x-pancake-work-key", context.workInvocation);
  else
    headers.delete("x-pancake-work-key");
  headers.delete("x-request-id");
  headers.delete("x-request-actor");
  if (url.origin === databaseOrigin && url.pathname.startsWith("/rest/v1/rpc/")) {
    for (const [name, value] of Object.entries(requestHeaders()))
      headers.set(name, value);
  }
  for (let attempt = 0;; attempt++) {
    const response = await fetch(input, {
      ...init,
      headers,
      signal: outer ? AbortSignal.any([outer, context.signal]) : context.signal
    });
    if (response.ok || !context.livePollHolder || url.origin !== databaseOrigin || !url.pathname.startsWith("/rest/v1/rpc/"))
      return response;
    const error = await response.clone().json().catch(() => ({}));
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : {};
    const rpc = url.pathname.split("/").at(-1);
    const details = {
      rpc,
      gameId: body.p_game_id,
      providerGameId: body.p_provider_game_id,
      leagueId: body.p_league_id,
      seasonId: body.p_league_season_id,
      week: body.p_week_number,
      code: error.code,
      message: error.message,
      details: error.details
    };
    const scoreRpc = ["capture_score_inputs", "get_stale_score_weeks", "update_score_points_atomic", "finalize_score_week_atomic"].includes(rpc ?? "");
    const contention = ["55P03", "40P01", "40001"].includes(error.code) || error.code === "PT409" && error.message === "Game inputs are being updated. Retry this operation.";
    if (context.retryScoreInputs && scoreRpc && contention && attempt < 3 && !context.signal.aborted && !outer?.aborted) {
      context.onScoreInputRetry?.();
      console.warn("[live-poll] retrying score input:", JSON.stringify({ ...details, attempt: attempt + 1 }));
      await response.body?.cancel();
      await new Promise((resolve) => setTimeout(resolve, 25 * 2 ** attempt));
      context.signal.throwIfAborted();
      outer?.throwIfAborted();
      continue;
    }
    console.error("[live-poll] database input failed:", JSON.stringify(details));
    return response;
  }
}

// supabase/functions/_shared/retry.ts
function shouldRetry(res) {
  return !res.ok && (res.status >= 500 || res.status === 429);
}
async function attempt(url, init, timeoutMs) {
  const outer = init?.signal ?? null;
  if (outer?.aborted)
    throw outer.reason ?? new DOMException("The operation was aborted.", "AbortError");
  const controller = new AbortController;
  const onOuterAbort = () => controller.abort(outer?.reason);
  outer?.addEventListener("abort", onOuterAbort, { once: true });
  const timer = timeoutMs == null ? null : setTimeout(() => controller.abort(new DOMException("Attempt timed out.", "TimeoutError")), timeoutMs);
  try {
    const response = await workFetch(url, { ...init, signal: controller.signal });
    return { response, unlink: () => outer?.removeEventListener("abort", onOuterAbort) };
  } catch (error) {
    outer?.removeEventListener("abort", onOuterAbort);
    throw error;
  } finally {
    if (timer != null)
      clearTimeout(timer);
  }
}
async function fetchWithRetry(url, init, options = {}) {
  const timeoutMs = options.attemptTimeoutMs;
  const delay = options.retryDelayMs ?? (() => 300 + Math.random() * 400);
  let firstError = null;
  try {
    const first = await attempt(url, init, timeoutMs);
    if (!shouldRetry(first.response))
      return first.response;
    first.unlink();
    await first.response.body?.cancel();
  } catch (error) {
    firstError = error;
  }
  if (init?.signal?.aborted)
    throw firstError ?? init.signal.reason;
  await new Promise((resolve) => setTimeout(resolve, delay()));
  return (await attempt(url, init, timeoutMs)).response;
}

// supabase/functions/_shared/sourceTimestamp.ts
function sourceTimestamp(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?$/.test(value.trim()))
    return;
  const normalized = value.trim().replace(" ", "T");
  const timestamp = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(normalized) ? normalized : `${normalized}Z`;
  return Number.isFinite(Date.parse(timestamp)) ? timestamp : undefined;
}

// supabase/functions/_shared/sourceEnvironment.ts
function sourceEnvironment(name) {
  const runtime = globalThis;
  return runtime.Deno?.env.get(name) ?? runtime.process?.env[name];
}

// supabase/functions/_shared/nba.ts
var NBA_CDN = sourceEnvironment("NBA_CDN_BASE_URL") ?? "https://cdn.nba.com/static/json";
var NBA_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
  Accept: "application/json, text/plain, */*",
  "Accept-Language": "en-US,en;q=0.9",
  Origin: "https://www.nba.com",
  Referer: "https://www.nba.com/"
};

class CdnHttpError extends Error {
  status;
  constructor(status, path) {
    super(`CDN ${status} for ${path}`);
    this.status = status;
  }
}
var CDN_ATTEMPT_TIMEOUT_MS = 20000;
var CDN_TOTAL_TIMEOUT_MS = 45000;
async function cdnGet(path, timeoutMs, onRevision) {
  const res = await fetchWithRetry(`${NBA_CDN}${path}`, { headers: NBA_HEADERS, signal: AbortSignal.timeout(timeoutMs ?? CDN_TOTAL_TIMEOUT_MS) }, { attemptTimeoutMs: timeoutMs ?? CDN_ATTEMPT_TIMEOUT_MS });
  if (!res.ok) {
    throw new CdnHttpError(res.status, path);
  }
  const modified = Date.parse(res.headers.get("last-modified") ?? "");
  onRevision?.(Number.isFinite(modified) ? new Date(modified).toISOString() : undefined);
  return await res.json();
}
function parseNBAMinutes(iso) {
  if (!iso)
    return null;
  const m = iso.match(/PT(\d+)M([\d.]+)S/);
  if (!m)
    return null;
  const mins = parseInt(m[1]);
  const secs = parseFloat(m[2]);
  return Math.round((mins + secs / 60) * 100) / 100;
}
async function fetchTodaysGames(timeoutMs) {
  let modified;
  const data = await cdnGet("/liveData/scoreboard/todaysScoreboard_00.json", timeoutMs, (value) => {
    modified = value;
  });
  const time = data.meta?.time ?? data.scoreboard?.time;
  const revision = modified ?? (typeof time === "string" && /(?:Z|[+-]\d{2}:?\d{2})$/.test(time) ? sourceTimestamp(time) : undefined);
  return (data?.scoreboard?.games ?? []).filter((game) => isRegularSeasonGameId(game?.gameId)).map((game) => revision ? { ...game, sourceUpdatedAt: revision } : game);
}
async function fetchBoxScore(gameId, timeoutMs) {
  let modified;
  const data = await cdnGet(`/liveData/boxscore/boxscore_${gameId}.json`, timeoutMs, (value) => {
    modified = value;
  });
  if (!data.game)
    throw new Error(`NBA box score missing game payload for ${gameId}`);
  const revision = sourceTimestamp(data.meta?.time);
  const offset = data.game.gameEt?.match(/([+-]\d{2}:\d{2})$/)?.[1];
  const explicit = typeof data.meta?.time === "string" && /(?:Z|[+-]\d{2}:?\d{2})$/.test(data.meta.time);
  const localTime = explicit ? revision : typeof data.meta?.time === "string" && offset ? sourceTimestamp(data.meta.time + offset) : undefined;
  return { ...data.game, ...revision ? { sourceUpdatedAt: revision } : {}, liveSourceUpdatedAt: localTime ?? modified };
}

// supabase/functions/_shared/gameProgress.ts
function gameElapsedSeconds(game) {
  if (game.gameStatus === 1)
    return 0;
  const period = game.period ?? 0;
  const clock = /^PT(\d+)M([\d.]+)S$/.exec(game.gameClock ?? "");
  if (!Number.isInteger(period) || period < 1 || !clock)
    throw new Error("Live game progress is missing or invalid");
  const remaining = Number(clock[1]) * 60 + Number(clock[2]);
  const length = period <= 4 ? 720 : 300;
  if (!Number.isFinite(remaining) || remaining < 0 || remaining > length)
    throw new Error("Live game clock is outside its period");
  return Math.min(period - 1, 4) * 720 + Math.max(period - 5, 0) * 300 + length - remaining;
}

// supabase/functions/_shared/liveSourceChoice.ts
function newerNbaSource(nba, espn) {
  if (!nba)
    return false;
  if (nba.gameStatus === 3)
    return true;
  if (nba.gameStatus !== 2)
    return false;
  const timestamp = nba.liveSourceUpdatedAt ?? nba.sourceUpdatedAt;
  return (timestamp ? Date.parse(timestamp) : NaN) >= Date.parse(espn.sourceUpdatedAt ?? "") || gameElapsedSeconds(nba) > gameElapsedSeconds(espn);
}

// supabase/functions/_shared/runBounded.ts
async function runBounded(jobs, concurrency) {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new RangeError("concurrency must be a positive integer");
  }
  let next = 0;
  const failures = [];
  const workers = Array.from({ length: Math.min(concurrency, jobs.length) }, async () => {
    while (next < jobs.length) {
      const job = jobs[next++];
      try {
        await job();
      } catch (error) {
        failures.push(error);
      }
    }
  });
  await Promise.all(workers);
  if (failures.length > 0) {
    throw new AggregateError(failures, `${failures.length} bounded job${failures.length === 1 ? "" : "s"} failed`);
  }
}

// supabase/functions/live-poll/espn.ts
var ESPN = sourceEnvironment("ESPN_LIVE_BASE_URL") ?? "https://site.api.espn.com/apis/site/v2/sports/basketball/nba";
var teamCode = (code) => ({ GS: "GSW", NY: "NYK", NO: "NOP", SA: "SAS", UTAH: "UTA", WSH: "WAS" })[code] ?? code;
async function get(path, timeoutMs = 2500) {
  const response = await workFetch(`${ESPN}${path}`, { signal: AbortSignal.timeout(timeoutMs), redirect: "error" });
  if (!response.ok)
    throw new Error(`ESPN ${response.status} for ${path}`);
  return await response.json();
}

class EspnSnapshotError extends Error {
}

class EspnLiveSource {
  now;
  timeoutMs;
  backoffs = new Map;
  constructor(now = () => Date.now(), timeoutMs = 2500) {
    this.now = now;
    this.timeoutMs = timeoutMs;
  }
  async request(key, run) {
    const previous = this.backoffs.get(key);
    if (previous && this.now() < previous.retryAt)
      throw new Error(`ESPN ${key}: backoff until ${new Date(previous.retryAt).toISOString()}`);
    try {
      const value = await run();
      this.backoffs.delete(key);
      return value;
    } catch (error) {
      const failures = error instanceof EspnSnapshotError ? 1 : Math.min((previous?.failures ?? 0) + 1, 4);
      const delay = error instanceof EspnSnapshotError ? 1e4 : Math.min(120000, 20000 * 2 ** (failures - 1));
      this.backoffs.set(key, { failures, retryAt: this.now() + delay });
      throw error;
    }
  }
  scoreboard(dates) {
    return this.request("scoreboard", async () => {
      const days = [...new Set(dates)].sort().map((date) => date.replaceAll("-", ""));
      const pages = await Promise.all(days.map((day) => get(`/scoreboard?dates=${day}&limit=100`, this.timeoutMs)));
      if (pages.some((page) => !Array.isArray(page.events)))
        throw new Error("ESPN scoreboard has invalid events");
      const payload = { events: pages.flatMap((page) => page.events) };
      const counts = new Map;
      for (const event of payload.events)
        if (event && typeof event.id === "string")
          counts.set(event.id, (counts.get(event.id) ?? 0) + 1);
      const events = payload.events.filter((event) => {
        if (!event || typeof event.id !== "string" || !Number.isFinite(Date.parse(event.date)) || !["pre", "in", "post"].includes(event.status?.type?.state) || !Array.isArray(event.competitions) || event.competitions.length !== 1 || !Array.isArray(event.competitions[0]?.competitors) || counts.get(event.id) !== 1)
          return false;
        const sides = event.competitions[0].competitors;
        if (sides.length !== 2 || sides.some((side) => !side || !["home", "away"].includes(side.homeAway) || !/^[A-Z]{2,4}$/.test(side.team?.abbreviation)))
          return false;
        if (new Set(sides.map((side) => side.homeAway)).size !== 2)
          return false;
        try {
          if (event.status.type.state !== "pre")
            espnGame(event.id, event.competitions[0]);
          return true;
        } catch {
          return false;
        }
      });
      if (!events.length && payload.events.length)
        throw new Error([...counts.values()].some((count) => count > 1) ? "ESPN scoreboard has duplicate games" : "ESPN scoreboard has invalid events");
      return events;
    });
  }
  summary(event) {
    return this.request(event.id, async () => {
      const payload = await get(`/summary?event=${encodeURIComponent(event.id)}`, this.timeoutMs);
      try {
        const parsed = parseEspnSummary(payload, event);
        if (Date.parse(parsed.sourceUpdatedAt) > this.now() + 5000)
          throw new Error(`ESPN ${event.id}: future source timestamp`);
        return parsed;
      } catch (error) {
        throw new EspnSnapshotError(error instanceof Error ? error.message : String(error), { cause: error });
      }
    });
  }
}
var liveEspnSource = new EspnLiveSource;
function espnGame(id, competition) {
  const home = competition.competitors.find((team) => team.homeAway === "home");
  const away = competition.competitors.find((team) => team.homeAway === "away");
  const status = competition.status;
  if (!home || !away || !["in", "post"].includes(status.type.state))
    throw new Error(`ESPN ${id}: live sides/status missing`);
  const clock = /^(?:(\d+):)?(\d{1,2})(?:\.(\d+))?$/.exec(status.displayClock);
  if (!clock)
    throw new Error(`ESPN ${id}: invalid clock`);
  const game = {
    gameId: id,
    gameStatus: 2,
    period: status.period,
    gameClock: `PT${clock[1] ?? "0"}M${clock[2].padStart(2, "0")}${clock[3] ? "." + clock[3] : ""}S`,
    gameStatusText: status.type.state === "post" ? "Awaiting final stats" : status.type.detail ?? `${status.displayClock} Q${status.period}`,
    homeTeam: { teamTricode: teamCode(home.team.abbreviation), score: Number(home.score) },
    awayTeam: { teamTricode: teamCode(away.team.abbreviation), score: Number(away.score) }
  };
  if ([home.score, away.score].some((score) => !/^\d+$/.test(score) || !Number.isSafeInteger(Number(score)) || Number(score) > 2147483647))
    throw new Error(`ESPN ${id}: invalid score`);
  gameElapsedSeconds(game);
  return game;
}
function matchEspnGame(game, events) {
  const matches = events.filter((event) => {
    if (event.season?.type !== 2 || event.season.year !== game.season_year)
      return false;
    const date = new Date(event.date).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
    const competitors = event.competitions[0]?.competitors ?? [];
    return date === game.game_date && competitors.some((team) => team.homeAway === "home" && teamCode(team.team.abbreviation) === game.home_team) && competitors.some((team) => team.homeAway === "away" && teamCode(team.team.abbreviation) === game.away_team);
  });
  if (matches.length > 1)
    throw new Error(`Ambiguous ESPN game for ${game.away_team}@${game.home_team}/${game.game_date}`);
  return matches[0];
}
function parseEspnSummary(summary, event) {
  if (summary.header.id !== event.id || summary.header.season.type !== 2 || summary.header.season.year !== event.season?.year)
    throw new Error(`ESPN ${event.id}: summary identity changed`);
  const game = espnGame(event.id, summary.header.competitions[0]);
  const reference = espnGame(event.id, { ...event.competitions[0], status: event.status });
  if (game.homeTeam.teamTricode !== reference.homeTeam.teamTricode || game.awayTeam.teamTricode !== reference.awayTeam.teamTricode)
    throw new Error(`ESPN ${event.id}: summary sides changed`);
  const sourceUpdatedAt = sourceTimestamp(summary.meta?.lastUpdatedAt);
  if (!sourceUpdatedAt)
    throw new Error(`ESPN ${event.id}: summary source timestamp missing`);
  const sides = summary.boxscore?.players ?? [];
  if (sides.length !== 2 || new Set(sides.map((side) => teamCode(side.team.abbreviation))).size !== 2)
    throw new Error(`ESPN ${event.id}: incomplete box sides`);
  const seen = new Set;
  const players = sides.flatMap((side) => {
    const team = teamCode(side.team.abbreviation);
    if (![game.homeTeam.teamTricode, game.awayTeam.teamTricode].includes(team))
      throw new Error(`ESPN ${event.id}: unexpected box side`);
    const groups = side.statistics.filter((group2) => group2.names.includes("PTS"));
    if (groups.length !== 1)
      throw new Error(`ESPN ${event.id}: ambiguous statistics`);
    const group = groups[0];
    const result = group.athletes.map((row) => {
      const id = row.athlete.id;
      if (!/^\d+$/.test(id) || seen.has(id))
        throw new Error(`ESPN ${event.id}: duplicate/invalid athlete ${id}`);
      seen.add(id);
      if (row.didNotPlay === true)
        return { espnId: id, team, player: {
          personId: 0,
          name: row.athlete.displayName,
          played: 0,
          statistics: {
            minutes: "PT0M00S",
            points: 0,
            reboundsTotal: 0,
            reboundsOffensive: 0,
            reboundsDefensive: 0,
            assists: 0,
            steals: 0,
            blocks: 0,
            turnovers: 0,
            foulsPersonal: 0,
            plusMinusPoints: 0,
            fieldGoalsMade: 0,
            fieldGoalsAttempted: 0,
            threePointersMade: 0,
            threePointersAttempted: 0,
            freeThrowsMade: 0,
            freeThrowsAttempted: 0
          }
        } };
      const values = Object.fromEntries(group.names.map((name, index) => [name, row.stats[index]]));
      const count = (name, signed = false) => {
        if (!(signed ? /^[+-]?\d+$/ : /^\d+$/).test(values[name] ?? ""))
          throw new Error(`ESPN ${event.id}/${id}: invalid ${name}`);
        const value = Number(values[name]);
        if (!Number.isSafeInteger(value) || value > 2147483647 || value < (signed ? -2147483648 : 0))
          throw new Error(`ESPN ${event.id}/${id}: out-of-range ${name}`);
        return value;
      };
      const pair = (name) => {
        const match = /^(\d+)-(\d+)$/.exec(values[name] ?? "");
        if (!match || Number(match[1]) > Number(match[2]) || !Number.isSafeInteger(Number(match[2])) || Number(match[2]) > 2147483647)
          throw new Error(`ESPN ${event.id}/${id}: invalid ${name}`);
        return [Number(match[1]), Number(match[2])];
      };
      const minutes = /^(\d+)(?::(\d{2}))?$/.exec(values.MIN ?? "");
      if (!minutes || Number(minutes[2] ?? 0) > 59)
        throw new Error(`ESPN ${event.id}/${id}: invalid MIN`);
      const [fgm, fga] = pair("FG"), [tpm, tpa] = pair("3PT"), [ftm, fta] = pair("FT");
      const statistics = {
        minutes: `PT${minutes[1]}M${minutes[2] ?? "00"}S`,
        points: count("PTS"),
        reboundsTotal: count("REB"),
        assists: count("AST"),
        reboundsOffensive: count("OREB"),
        reboundsDefensive: count("DREB"),
        steals: count("STL"),
        blocks: count("BLK"),
        turnovers: count("TO"),
        foulsPersonal: count("PF"),
        plusMinusPoints: count("+/-", true),
        fieldGoalsMade: fgm,
        fieldGoalsAttempted: fga,
        threePointersMade: tpm,
        threePointersAttempted: tpa,
        freeThrowsMade: ftm,
        freeThrowsAttempted: fta
      };
      return { espnId: id, team, player: { personId: 0, name: row.athlete.displayName, played: 1, statistics } };
    });
    if (!result.length || result.reduce((sum, row) => sum + row.player.statistics.points, 0) !== (team === game.homeTeam.teamTricode ? game.homeTeam.score : game.awayTeam.score))
      throw new Error(`ESPN ${event.id}: incomplete team points`);
    return result;
  });
  return { game: { ...game, sourceUpdatedAt }, players, sourceUpdatedAt };
}

// core/src/live/codec.ts
function liveLineStats(row) {
  if (row.length !== 15 || !/^\d+$/.test(row[0]) || row.slice(1).some((value) => typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 2147483647))
    return null;
  if (![0, 1].includes(row[14]))
    return null;
  const doubles = [row[1], row[2], row[3], row[4], row[5]].filter((value) => value >= 10).length;
  return {
    points: row[1],
    rebounds: row[2],
    assists: row[3],
    steals: row[4],
    blocks: row[5],
    turnovers: row[6],
    threePointersMade: row[7],
    fieldGoalsMade: row[8],
    fieldGoalsAttempted: row[9],
    freeThrowsMade: row[10],
    freeThrowsAttempted: row[11],
    fouls: row[12],
    minutesPlayed: row[13],
    didNotPlay: row[14] === 1,
    doubleDouble: doubles >= 2,
    tripleDouble: doubles >= 3
  };
}

// server/live/snapshot.ts
var etDate = (value) => new Date(value).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
function boardDate(game, now) {
  const extra = game;
  if (extra.gameEt && Number.isFinite(Date.parse(extra.gameEt)))
    return etDate(extra.gameEt);
  const date = /^(\d{4})(\d{2})(\d{2})\//.exec(extra.gameCode ?? "");
  return date ? `${date[1]}-${date[2]}-${date[3]}` : etDate(now);
}
function compactPlayer(player, id = String(player.personId === 196295686 ? 1641794 : player.personId)) {
  if (!/^\d+$/.test(id))
    throw new Error("Invalid provider player identity");
  const s = player.statistics;
  const minutes = parseNBAMinutes(s.minutes);
  const didNotPlay = player.played === "0" || player.played === 0;
  const required = [
    s.points,
    s.reboundsTotal,
    s.assists,
    s.steals,
    s.blocks,
    s.turnovers,
    s.threePointersMade,
    s.fieldGoalsMade,
    s.fieldGoalsAttempted,
    s.freeThrowsMade,
    s.freeThrowsAttempted,
    s.foulsPersonal
  ];
  if (!didNotPlay && (minutes == null || required.some((value) => typeof value !== "number" || !Number.isFinite(value) || value < 0)))
    throw new Error("Provider player line is incomplete");
  const row = [
    id,
    s.points ?? 0,
    s.reboundsTotal ?? 0,
    s.assists ?? 0,
    s.steals ?? 0,
    s.blocks ?? 0,
    s.turnovers ?? 0,
    s.threePointersMade ?? 0,
    s.fieldGoalsMade ?? 0,
    s.fieldGoalsAttempted ?? 0,
    s.freeThrowsMade ?? 0,
    s.freeThrowsAttempted ?? 0,
    s.foulsPersonal ?? 0,
    minutes ?? 0,
    didNotPlay ? 1 : 0
  ];
  if (!liveLineStats(row))
    throw new Error("Invalid provider stat line");
  return row;
}
function compactBox(box, board, event, observedAt, ids) {
  if (![2, 3].includes(box.gameStatus))
    throw new Error("Provider box has not started");
  if (box.gameStatus !== 3)
    gameElapsedSeconds(box);
  const updatedAt = Date.parse(box.liveSourceUpdatedAt ?? box.sourceUpdatedAt ?? board?.sourceUpdatedAt ?? "");
  if (!Number.isFinite(updatedAt) || updatedAt > observedAt + 5000)
    throw new Error("Provider snapshot has an invalid source timestamp");
  const sides = [box.homeTeam, box.awayTeam].map((side) => {
    const players = side.players.map((player) => compactPlayer(player, ids?.get(player)));
    if (!players.length || new Set(players.map((row) => row[0])).size !== players.length || !Number.isFinite(side.score) || players.reduce((sum, row) => sum + row[1], 0) !== side.score)
      throw new Error("Provider box is incomplete");
    return { team: side.teamTricode, score: side.score, players };
  });
  const identities = sides.flatMap((side) => side.players.map((player) => player[0]));
  if (new Set(identities).size !== identities.length)
    throw new Error("Provider player appears on both sides");
  return {
    id: board?.gameId ?? `espn:${event.id}`,
    nbaId: board?.gameId ?? null,
    espnId: event?.id ?? null,
    source: ids ? "espn" : "nba",
    status: box.gameStatus === 3 ? "Final" : "InProgress",
    updatedAt,
    ...box.gameStatus !== 3 && event?.status.type.state === "post" ? { completionPending: true } : {},
    period: box.period,
    clock: box.gameClock,
    home: sides[0],
    away: sides[1]
  };
}
function nbaIsCurrent(box, event, observedAt) {
  if (box.gameStatus === 3 || !event)
    return true;
  const timestamp = Date.parse(box.liveSourceUpdatedAt ?? box.sourceUpdatedAt ?? "");
  if (!Number.isFinite(timestamp) || observedAt - timestamp > 1e4)
    return false;
  if (event.status.type.state === "pre")
    return true;
  const board = espnGame(event.id, { ...event.competitions[0], status: event.status });
  return gameElapsedSeconds(box) >= gameElapsedSeconds(board) && box.homeTeam.score === board.homeTeam.score && box.awayTeam.score === board.awayTeam.score;
}
function scoreboardState(board, event) {
  const espn = event && ["in", "post"].includes(event.status.type.state) ? espnGame(event.id, { ...event.competitions[0], status: event.status }) : undefined;
  const reference = board ?? espn;
  return {
    key: JSON.stringify([
      board && [board.gameStatus, board.period, board.gameClock, board.homeTeam.score, board.awayTeam.score],
      event && [event.status.type.state, event.status.period, event.status.displayClock, event.competitions[0].competitors.map((side) => side.score)]
    ]),
    home: reference?.homeTeam.score,
    away: reference?.awayTeam.score
  };
}
function createSnapshotSource(now = Date.now) {
  const espn = new EspnLiveSource(now, 1500);
  const unchanged = new Map;
  return async (date) => {
    for (const [id, entry] of unchanged)
      if (now() - entry.at > 43200000)
        unchanged.delete(id);
    const results = await Promise.allSettled([fetchTodaysGames(1500), espn.scoreboard([date])]);
    if (results.every((result) => result.status === "rejected"))
      throw new Error("Both public score providers are unavailable");
    const boards = results[0].status === "fulfilled" ? results[0].value : [];
    const events = results[1].status === "fulfilled" ? results[1].value.filter((event) => etDate(event.date) === date && event.season?.type === 2) : [];
    const year = Number(date.slice(0, 4)) + (Number(date.slice(5, 7)) >= 10 ? 1 : 0);
    const catalog = [];
    const failures = [];
    for (const board of boards) {
      try {
        if (boardDate(board, now()) !== date)
          continue;
        if (![1, 2, 3].includes(board.gameStatus) || ![board.homeTeam, board.awayTeam].every((team) => team && /^[A-Z]{2,4}$/.test(team.teamTricode) && Number.isFinite(team.score) && team.score >= 0) || board.homeTeam.teamTricode === board.awayTeam.teamTricode)
          throw new Error("Invalid scoreboard row");
        const event = matchEspnGame({
          game_date: date,
          season_year: year,
          home_team: board.homeTeam.teamTricode,
          away_team: board.awayTeam.teamTricode
        }, events);
        if (board.gameStatus !== 1 || event && ["in", "post"].includes(event.status.type.state))
          catalog.push({ board, event });
      } catch {
        failures.push(board.gameId);
      }
    }
    for (const event of events)
      if (["in", "post"].includes(event.status.type.state) && !catalog.some((item) => item.event?.id === event.id))
        catalog.push({ event });
    if (catalog.length > 15)
      throw new Error("Public slate is larger than the supported limit");
    const games = [];
    await runBounded(catalog.map(({ board, event }) => async () => {
      const id = `${date}:${board?.gameId ?? `espn:${event.id}`}`;
      let state;
      try {
        state = scoreboardState(board, event);
      } catch {
        state = undefined;
      }
      const kept = unchanged.get(id);
      if (state && kept?.key === state.key && now() - kept.at < (kept.game.status === "Final" ? Infinity : kept.game.completionPending ? 300000 : 60000)) {
        games.push(kept.game);
        return;
      }
      const remember = (game) => {
        if (state && game.home.score === state.home && game.away.score === state.away)
          unchanged.set(id, { key: state.key, game, at: now() });
        else
          unchanged.delete(id);
        games.push(game);
      };
      try {
        const nbaResult = await (board ? fetchBoxScore(board.gameId, 1500) : Promise.resolve(undefined)).then((value) => ({ status: "fulfilled", value }), (reason) => ({ status: "rejected", reason }));
        let nba = nbaResult.status === "fulfilled" ? nbaResult.value : undefined;
        if (nba && (nba.gameId !== board?.gameId || nba.gameEt && etDate(nba.gameEt) !== date || nba.homeTeam.teamTricode !== board?.homeTeam.teamTricode || nba.awayTeam.teamTricode !== board?.awayTeam.teamTricode))
          nba = undefined;
        let nbaCompact;
        if (nba) {
          try {
            nbaCompact = compactBox(nba, board, event, now());
          } catch {
            nba = undefined;
          }
        }
        if (nba && nbaCompact && nbaIsCurrent(nba, event, now())) {
          remember(nbaCompact);
          return;
        }
        const other = event && ["in", "post"].includes(event.status.type.state) ? await espn.summary(event).catch(() => {
          return;
        }) : undefined;
        if (nba && nbaCompact && (!other || newerNbaSource(nba, other.game)))
          remember(nbaCompact);
        else if (other) {
          const identities = new Map(other.players.map((row) => [row.player, row.espnId]));
          const box = {
            ...other.game,
            gameEt: null,
            homeTeam: { ...other.game.homeTeam, players: other.players.filter((row) => row.team === other.game.homeTeam.teamTricode).map((row) => row.player) },
            awayTeam: { ...other.game.awayTeam, players: other.players.filter((row) => row.team === other.game.awayTeam.teamTricode).map((row) => row.player) }
          };
          remember(compactBox(box, board, event, now(), identities));
        } else if (nbaCompact)
          remember(nbaCompact);
        else
          throw new Error("No valid live box");
      } catch {
        failures.push(board?.gameId ?? `espn:${event.id}`);
      }
    }), 8);
    if ((catalog.length || failures.length) && !games.length)
      throw new Error("No public game snapshot is usable");
    return {
      version: 1,
      mode: "public",
      date,
      capturedAt: now(),
      games: games.sort((a, b) => a.id.localeCompare(b.id)),
      ...failures.length ? { unavailable: failures.sort() } : {}
    };
  };
}

// server/live/handler.ts
var REFRESH_MS = 20000;
var cachePolicy = "public, max-age=0, s-maxage=20, stale-while-revalidate=10, stale-if-error=90";
function offSwitch() {
  const runtime = globalThis;
  return (runtime.Deno?.env.get("LIVE_SCORES_OFF") ?? runtime.process?.env.LIVE_SCORES_OFF) === "1";
}
function createLiveHandler(options = {}) {
  const now = options.now ?? Date.now;
  const disabled = options.disabled ?? offSwitch;
  const source = options.source ?? createSnapshotSource(now);
  const lastGood = new Map;
  const refreshAt = new Map;
  const inFlight = new Map;
  return async (request) => {
    const headers = { "content-type": "application/json", "access-control-allow-origin": "*", "x-content-type-options": "nosniff" };
    if (!["GET", "HEAD"].includes(request.method))
      return new Response(null, { status: 405, headers: { ...headers, allow: "GET, HEAD", "cache-control": "no-store" } });
    const url = new URL(request.url);
    const date = url.searchParams.get("date") ?? url.pathname.split("/").at(-1) ?? "";
    const day = new Date(now()).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
    const previous = new Date(Date.parse(`${day}T12:00:00Z`) - 86400000).toISOString().slice(0, 10);
    for (const key of refreshAt.keys())
      if (key !== day && key !== previous) {
        lastGood.delete(key);
        refreshAt.delete(key);
      }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || ![day, previous].includes(date) || url.searchParams.getAll("date").length > 1 || [...url.searchParams.keys()].some((key) => key !== "date"))
      return Response.json({ error: "Date is outside the live window" }, { status: 400, headers: { ...headers, "cache-control": "no-store" } });
    const canonical = `/api/live/${date}`;
    if (url.pathname !== "/api/live/[date]" && url.pathname !== canonical) {
      return new Response(null, { status: 308, headers: { ...headers, location: canonical, "cache-control": "no-store" } });
    }
    try {
      let snapshot;
      if (disabled()) {
        lastGood.clear();
        refreshAt.clear();
        snapshot = { version: 1, mode: "database", date, capturedAt: now(), games: [] };
      } else {
        let pending = inFlight.get(date);
        if (!pending) {
          if (now() < (refreshAt.get(date) ?? 0)) {
            const saved = lastGood.get(date);
            if (!saved || now() - saved.capturedAt > 120000)
              throw new Error("Live refresh is backing off");
            return new Response(request.method === "HEAD" ? null : saved.body, { headers: {
              ...headers,
              "cache-control": `public, max-age=0, s-maxage=${Math.max(1, Math.ceil(Math.min(refreshAt.get(date) - now(), 120000 - (now() - saved.capturedAt)) / 1000))}`
            } });
          }
          refreshAt.set(date, now() + REFRESH_MS);
          pending = source(date).finally(() => {
            inFlight.delete(date);
          });
          inFlight.set(date, pending);
        }
        snapshot = await pending;
      }
      const body = JSON.stringify(snapshot);
      if (new TextEncoder().encode(body).length > 1e6)
        throw new Error("Live snapshot exceeds the payload budget");
      if (snapshot.mode === "public")
        lastGood.set(date, { body, capturedAt: snapshot.capturedAt });
      return new Response(request.method === "HEAD" ? null : body, { headers: { ...headers, "cache-control": cachePolicy } });
    } catch {
      const saved = lastGood.get(date);
      const remaining = saved ? 120000 - (now() - saved.capturedAt) : 0;
      if (saved && remaining > 0 && remaining <= 120000)
        return new Response(request.method === "HEAD" ? null : saved.body, {
          headers: { ...headers, "cache-control": `public, max-age=0, s-maxage=${Math.min(REFRESH_MS / 1000, Math.ceil(remaining / 1000))}`, "x-live-snapshot-fallback": "1" }
        });
      return Response.json({ error: "Live scores are temporarily unavailable" }, { status: 503, headers: { ...headers, "cache-control": "no-store" } });
    }
  };
}

// server/live/vercel.ts
var liveHandler = createLiveHandler();
async function handler(request, response) {
  const result = await liveHandler(new Request(`http://localhost${request.url ?? "/"}`, { method: request.method ?? "GET" }));
  response.statusCode = result.status;
  for (const [name, value] of result.headers)
    response.setHeader(name, value);
  response.end(request.method === "HEAD" ? undefined : await result.text());
}
