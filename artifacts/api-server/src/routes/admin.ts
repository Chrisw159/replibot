import { Router, type IRouter } from "express";
import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { betsTable, dutchScheduleTable, botLogsTable } from "@workspace/db";

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

export default router;
