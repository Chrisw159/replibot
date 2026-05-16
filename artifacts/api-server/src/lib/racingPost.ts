import { logger } from "./logger";

/**
 * Scrapes the Racing Post daily results page to extract going (track condition)
 * for every meeting that has at least one race completed on that date.
 *
 * Used by runScheduleSettlement so each settled row in dutch_schedule gets a
 * `going` value (e.g. "Good", "Good To Soft", "Heavy"). Future strategies can
 * then condition on track condition — which is widely believed to materially
 * affect favourite-win rates and trip preferences.
 *
 * Results are cached per-process per-date so repeated settlement ticks don't
 * re-fetch the page (~150 kB per request).
 */

type CourseGoing = Map<string, string>;
const cache = new Map<string, { fetchedAt: number; data: CourseGoing }>();
const CACHE_TTL_MS = 30 * 60 * 1000;

const RP_URL = (date: string) => `https://www.racingpost.com/results/${date}`;

/**
 * Strip the "(IRE)" / "(FR)" / etc. suffix and upper-case so we can match
 * against Betfair event names like "Newbury 15th May" → "NEWBURY".
 */
function normalizeCourse(s: string): string {
  return s
    .replace(/\s*\([A-Z]{2,3}\)\s*$/i, "")
    .trim()
    .toUpperCase();
}

/**
 * Allow-list of valid going values. Anything outside this set is treated as
 * a parser false-positive and discarded. Combinations like "Good To Soft" are
 * normalised to title case before matching here.
 */
const VALID_GOING = new Set<string>([
  "Firm",
  "Good To Firm",
  "Good",
  "Good To Soft",
  "Yielding",
  "Good To Yielding",
  "Yielding To Soft",
  "Soft",
  "Soft To Heavy",
  "Heavy",
  "Standard",
  "Standard To Slow",
  "Slow",
  "Fast",
  "Hard",
]);

function titleCase(g: string): string {
  return g
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Extract the course portion from a Betfair event name. Event names look like:
 *   "Newbury 15th May"
 *   "Newton Abbot 13th May"
 *   "Bangor-on-Dee 16th May"
 * We strip the trailing " <day><suffix> <month>" and return upper-case.
 * Returns null if the pattern doesn't match (e.g. "Daily Win Dist Odds").
 */
export function courseFromEventName(eventName: string): string | null {
  const m = eventName.match(
    /^(.+?)\s+\d+(?:st|nd|rd|th)\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)/i,
  );
  if (!m) return null;
  return m[1].trim().toUpperCase();
}

async function fetchPage(date: string): Promise<string | null> {
  try {
    const res = await fetch(RP_URL(date), {
      headers: {
        "user-agent":
          "Mozilla/5.0 (compatible; ReplibotResultsBot/1.0; +https://racing.example/bot)",
        accept: "text/html",
      },
    });
    if (!res.ok) {
      logger.warn(
        { date, status: res.status },
        "[GOING] Racing Post results page returned non-OK",
      );
      return null;
    }
    return await res.text();
  } catch (err) {
    logger.warn({ err, date }, "[GOING] Racing Post fetch failed");
    return null;
  }
}

/**
 * Parse Racing Post HTML and return per-course going.
 *
 * RP layout (in HTML and the markdown rendering we previously tested):
 *   <h2>NEWBURY</h2>
 *   ... "Going:" then a value ("GOOD (Watered; 5.3)") ...
 *   <race title link>
 *     ... "Going: Good" per-race ...
 *
 * The per-race "Going: X" lines are simpler and more accurate (no measurement
 * suffix), so we prefer those. We then aggregate per course taking the most
 * common value.
 */
function parseGoings(html: string): CourseGoing {
  const result: CourseGoing = new Map();

  // Strip HTML tags to a text approximation, preserving newlines.
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<\/(h2|h3|p|div|li|tr|td|th|br)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/[ \t]+/g, " ");

  // Walk course headers — uppercase words possibly followed by " (IRE)" etc.
  // We use a regex that finds runs of uppercase course names appearing on
  // their own line. To avoid false positives (e.g. "GOOD") we require the
  // name to span 4+ chars and be followed within 200 chars by the word "Going".
  const courseRe =
    /\n\s*([A-Z][A-Z'\-& ]{3,}?(?:\s*\([A-Z]{2,3}\))?)\s*\n/g;
  const heads: { course: string; pos: number; end: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = courseRe.exec(text))) {
    const name = m[1].trim();
    // Filter out lines that are clearly not course headers
    if (/\b(GOOD|SOFT|HEAVY|FIRM|YIELDING|STANDARD)\b/.test(name)) continue;
    if (/\b(GOING|WEATHER|WIND|STALLS|TOTAL|JACKPOT|PLACEPOT)\b/.test(name)) continue;
    if (name.length > 40) continue;
    heads.push({ course: name, pos: m.index, end: m.index + m[0].length });
  }

  for (let i = 0; i < heads.length; i++) {
    const h = heads[i];
    const next = heads[i + 1];
    const block = text.slice(h.end, next ? next.pos : text.length);
    const courseKey = normalizeCourse(h.course);
    if (!courseKey) continue;

    // Per-race "Going: X" lines (preferred — short, one value)
    const perRace: string[] = [];
    const reRace = /\bGoing:\s*([A-Za-z][A-Za-z ]{2,30}?)\s*(?:\n|$|\d)/g;
    let rm: RegExpExecArray | null;
    while ((rm = reRace.exec(block))) {
      const raw = rm[1].trim();
      if (raw.length > 30 || /\d/.test(raw)) continue;
      const norm = titleCase(raw);
      // Allow-list guard rejects parser garbage like "Turf", "Standard time",
      // page-section text accidentally captured as a heading, etc.
      if (VALID_GOING.has(norm)) perRace.push(norm);
    }

    if (perRace.length > 0) {
      const counts = new Map<string, number>();
      for (const g of perRace) counts.set(g, (counts.get(g) ?? 0) + 1);
      const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
      result.set(courseKey, top);
      continue;
    }

    // Fallback to course-header "Going: GOOD (Watered; 5.3)" — extracts the
    // leading word(s) before any "(" measurement suffix.
    const headerGoing = block.match(/\bGoing:\s*\n*\s*([A-Z][A-Z ]{2,20})\b/);
    if (headerGoing) {
      const norm = titleCase(headerGoing[1]);
      if (VALID_GOING.has(norm)) result.set(courseKey, norm);
    }
  }

  return result;
}

/**
 * Returns a map of UPPER-CASE course name → going for the given YYYY-MM-DD.
 * Cached per-process for 30 min. Returns an empty map (not null) on failure
 * so callers can simply do `.get(course)` without null checks.
 */
export async function getGoingByCourseForDate(date: string): Promise<CourseGoing> {
  const cached = cache.get(date);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.data;
  }
  const html = await fetchPage(date);
  if (!html) {
    // Don't poison the cache with an empty result — let the next tick retry.
    return new Map();
  }
  const data = parseGoings(html);
  cache.set(date, { fetchedAt: Date.now(), data });
  if (data.size === 0) {
    logger.warn({ date }, "[GOING] parsed Racing Post page but found no goings");
  } else {
    logger.info(
      { date, courses: data.size, sample: [...data.entries()].slice(0, 3) },
      "[GOING] loaded going map from Racing Post",
    );
  }
  return data;
}
