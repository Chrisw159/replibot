import { logger } from "./logger";

/**
 * EXTERNAL full-finishing-order results (optional).
 *
 * Betfair only exposes WIN (1st) + PLACE (placed set) — never the exact order
 * of 2nd/3rd/4th. This module is the seam for layering a third-party results
 * provider on top, so each runner can get an exact `finishPosition`.
 *
 * It is fully DORMANT until credentials are configured, so the bot runs on
 * Betfair-only data by default. When `RACING_API_USERNAME` + `RACING_API_PASSWORD`
 * are present (The Racing API — https://www.theracingapi.com), settlement will
 * call this to enrich runners with exact finishing positions, matched by
 * normalised horse name + course + date.
 *
 * Parsing is defensive: any shape mismatch yields an empty map and the bot
 * falls back to the Betfair win/place result. Adjust the field mapping in
 * `parseResults` if the provider's response differs.
 */

const RACING_API_BASE = "https://api.theracingapi.com/v1";

type CourseResults = Map<string, Map<string, number>>; // courseKey -> (horseKey -> position)
const cache = new Map<string, { fetchedAt: number; data: CourseResults }>();
const CACHE_TTL_MS = 60 * 60 * 1000;

export function isExternalResultsConfigured(): boolean {
  return !!(process.env.RACING_API_USERNAME && process.env.RACING_API_PASSWORD);
}

/** Normalise a course name to match Betfair event names (e.g. "NEWBURY"). */
export function normalizeCourseKey(s: string): string {
  return s.replace(/\s*\([A-Z]{2,3}\)\s*$/i, "").trim().toUpperCase();
}

/** Normalise a horse name for matching: strip country suffix + punctuation. */
export function normalizeHorseKey(s: string): string {
  return s
    .replace(/\s*\([A-Z]{2,3}\)\s*$/i, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

interface RacingApiRunner {
  horse?: string;
  position?: string | number;
}
interface RacingApiResult {
  course?: string;
  runners?: RacingApiRunner[];
}
interface RacingApiResponse {
  results?: RacingApiResult[];
}

function parseResults(body: RacingApiResponse): CourseResults {
  const out: CourseResults = new Map();
  for (const race of body.results ?? []) {
    if (!race.course || !Array.isArray(race.runners)) continue;
    const courseKey = normalizeCourseKey(race.course);
    let byHorse = out.get(courseKey);
    if (!byHorse) {
      byHorse = new Map();
      out.set(courseKey, byHorse);
    }
    for (const r of race.runners) {
      if (!r.horse) continue;
      const pos = typeof r.position === "number" ? r.position : parseInt(String(r.position ?? ""), 10);
      if (!Number.isFinite(pos) || pos <= 0) continue; // skip PU/F/non-finishers
      byHorse.set(normalizeHorseKey(r.horse), pos);
    }
  }
  return out;
}

/**
 * Fetch full finishing order for every meeting on a date.
 * Returns an empty map when not configured or on any error.
 */
export async function getFinishingOrderByCourseForDate(date: string): Promise<CourseResults> {
  if (!isExternalResultsConfigured()) return new Map();

  const hit = cache.get(date);
  if (hit && Date.now() - hit.fetchedAt < CACHE_TTL_MS) return hit.data;

  try {
    const auth = Buffer.from(
      `${process.env.RACING_API_USERNAME}:${process.env.RACING_API_PASSWORD}`,
    ).toString("base64");
    const res = await fetch(`${RACING_API_BASE}/results?start_date=${date}&end_date=${date}`, {
      headers: { Authorization: `Basic ${auth}`, Accept: "application/json" },
    });
    if (!res.ok) {
      logger.warn({ status: res.status, date }, "[RESULTS] external results fetch failed");
      return new Map();
    }
    const body = (await res.json()) as RacingApiResponse;
    const data = parseResults(body);
    cache.set(date, { fetchedAt: Date.now(), data });
    return data;
  } catch (err) {
    logger.warn({ err, date }, "[RESULTS] external results error");
    return new Map();
  }
}
