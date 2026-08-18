/**
 * Live score feed (ESPN public scoreboard).
 *
 * Betfair's API carries no live scores, so the engine's primary source used
 * to be inference from the Correct Score market. This module provides real
 * scores from ESPN's keyless public feed. Coverage is major leagues; obscure
 * competitions fall back to Correct Score inference in the engine.
 *
 * Matching is by normalised team-name tokens against Betfair's "Home v Away"
 * event names. Conservative: an ambiguous or weak match returns null rather
 * than risking the wrong game's score.
 */

export interface FeedScore {
  home: number;
  away: number;
  minute: number | null; // display clock minute if parseable
  homeTeam: string;
  awayTeam: string;
}

interface EspnEvent {
  name?: string;
  status?: { type?: { state?: string }; displayClock?: string };
  competitions?: Array<{
    competitors?: Array<{
      homeAway?: string;
      score?: string;
      team?: { displayName?: string; shortDisplayName?: string; name?: string };
    }>;
  }>;
}

const FEED_URL = "https://site.api.espn.com/apis/site/v2/sports/soccer/all/scoreboard";
const CACHE_MS = 30_000;

let cache: { at: number; games: FeedScore[] } | null = null;
let lastError: string | null = null;

export function getFeedStatus(): { games: number; ageMs: number | null; lastError: string | null } {
  return {
    games: cache?.games.length ?? 0,
    ageMs: cache ? Date.now() - cache.at : null,
    lastError,
  };
}

/** Words that carry no identity: club suffixes, connectives, etc. */
const NOISE = new Set([
  "fc", "cf", "afc", "sc", "ac", "as", "cd", "sd", "if", "fk", "sk", "bk",
  "club", "de", "do", "da", "el", "al", "the", "town", "city", "united",
  "utd", "real", "sporting", "athletic", "atletico", "deportivo",
  "u23", "u21", "u20", "u19", "ii", "b", "women", "w",
]);

function tokens(name: string): Set<string> {
  const cleaned = name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // strip accents
    .replace(/[^a-z0-9\s]/g, " ");
  const out = new Set<string>();
  for (const t of cleaned.split(/\s+/)) {
    if (t.length >= 3 && !NOISE.has(t)) out.add(t);
  }
  return out;
}

/** True if the two team names share at least one meaningful token. */
function teamsMatch(a: string, b: string): boolean {
  const ta = tokens(a);
  const tb = tokens(b);
  if (ta.size === 0 || tb.size === 0) return false;
  for (const t of ta) if (tb.has(t)) return true;
  return false;
}

function parseMinute(clock: string | undefined): number | null {
  if (!clock) return null;
  const m = clock.match(/^(\d+)/);
  return m ? Number(m[1]) : null;
}

/** Fetch (with 30s cache) all in-play games from the feed. Errors return []. */
export async function fetchLiveScores(): Promise<FeedScore[]> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.games;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    const res = await fetch(FEED_URL, {
      headers: { "User-Agent": "Mozilla/5.0" },
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`feed HTTP ${res.status}`);
    const data = (await res.json()) as { events?: EspnEvent[] };
    const games: FeedScore[] = [];
    for (const e of data.events ?? []) {
      if (e.status?.type?.state !== "in") continue;
      const comps = e.competitions?.[0]?.competitors ?? [];
      const home = comps.find((c) => c.homeAway === "home");
      const away = comps.find((c) => c.homeAway === "away");
      const hs = Number(home?.score);
      const as = Number(away?.score);
      const hn = home?.team?.displayName ?? home?.team?.name;
      const an = away?.team?.displayName ?? away?.team?.name;
      if (!hn || !an || !Number.isFinite(hs) || !Number.isFinite(as)) continue;
      games.push({
        home: hs,
        away: as,
        minute: parseMinute(e.status?.displayClock),
        homeTeam: hn,
        awayTeam: an,
      });
    }
    cache = { at: Date.now(), games };
    lastError = null;
    return games;
  } catch (err) {
    lastError = String(err);
    // Serve stale cache (up to 5 min) rather than nothing on a blip.
    if (cache && Date.now() - cache.at < 300_000) return cache.games;
    return [];
  }
}

/**
 * Find the feed score for a Betfair event name like "Arsenal v Chelsea".
 * Requires BOTH teams to match, in the right order, and exactly one feed
 * game to qualify — otherwise null (engine falls back to CS inference).
 */
export function matchFeedScore(games: FeedScore[], betfairEventName: string): FeedScore | null {
  const parts = betfairEventName.split(/\s+v(?:s\.?)?\s+/i);
  if (parts.length !== 2) return null;
  const [bfHome, bfAway] = parts;
  const hits = games.filter(
    (g) => teamsMatch(bfHome, g.homeTeam) && teamsMatch(bfAway, g.awayTeam),
  );
  return hits.length === 1 ? hits[0] : null;
}
