import { Router, type IRouter } from "express";
import { sql, desc } from "drizzle-orm";
import { db } from "@workspace/db";
import { betsTable, dutchScheduleTable, botLogsTable, raceDatasetTable } from "@workspace/db";

/**
 * ============================================================================
 *  PERMANENT DATA — NEVER WIPE
 * ============================================================================
 *  The `race_dataset` table is the long-term research corpus (every race we
 *  have ever observed, with winners + going). It must NEVER be referenced by
 *  any reset/delete endpoint in this file. If you add a new wipe endpoint,
 *  audit it to confirm raceDatasetTable is not touched.
 * ============================================================================
 */

const router: IRouter = Router();

const ADMIN_TOKEN = "k7Qm9pR2vT5wXz8aB3cD6fH1jL4nP7sU";

router.post("/admin/:token/reset-dutch", async (req, res) => {
  if (req.params.token !== ADMIN_TOKEN) {
    res.status(404).json({ error: "not found" });
    return;
  }
  const betsDel = await db
    .delete(betsTable)
    .where(sql`${betsTable.strategyName} = 'Dutch Bot'`)
    .returning({ id: betsTable.id });
  const schedDel = await db.delete(dutchScheduleTable).returning({ id: dutchScheduleTable.id });
  res.json({
    ok: true,
    betsDeleted: betsDel.length,
    scheduleDeleted: schedDel.length,
  });
});

router.post("/admin/:token/reset-strategy", async (req, res) => {
  if (req.params.token !== ADMIN_TOKEN) {
    res.status(404).json({ error: "not found" });
    return;
  }
  const name = String(req.query.name ?? "");
  if (!name) {
    res.status(400).json({ error: "missing ?name=" });
    return;
  }
  const betsDel = await db
    .delete(betsTable)
    .where(sql`${betsTable.strategyName} = ${name}`)
    .returning({ id: betsTable.id });
  res.json({ ok: true, strategy: name, betsDeleted: betsDel.length });
});

router.post("/admin/:token/clear-logs", async (req, res) => {
  if (req.params.token !== ADMIN_TOKEN) {
    res.status(404).json({ error: "not found" });
    return;
  }
  const del = await db.delete(botLogsTable).returning({ id: botLogsTable.id });
  res.json({ ok: true, logsDeleted: del.length });
});

// Read-only dataset access (no token required — research data, no secrets).
router.get("/dataset/races", async (req, res) => {
  const limit = Math.min(Number(req.query.limit ?? 100), 1000);
  const date  = req.query.date ? String(req.query.date) : null;
  const rows = date
    ? await db.select().from(raceDatasetTable)
        .where(sql`${raceDatasetTable.scheduledDate} = ${date}`)
        .orderBy(desc(raceDatasetTable.marketStartTime))
        .limit(limit)
    : await db.select().from(raceDatasetTable)
        .orderBy(desc(raceDatasetTable.marketStartTime))
        .limit(limit);
  res.json({ count: rows.length, races: rows });
});

router.get("/dataset/races/count", async (_req, res) => {
  const [r] = await db
    .select({
      total:        sql<number>`count(*)::int`,
      withWinner:   sql<number>`count(${raceDatasetTable.winnerSelectionId})::int`,
      withGoing:    sql<number>`count(${raceDatasetTable.going})::int`,
    })
    .from(raceDatasetTable);
  res.json(r ?? { total: 0, withWinner: 0, withGoing: 0 });
});

export default router;
