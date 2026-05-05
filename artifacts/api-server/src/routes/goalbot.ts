import { Router, type IRouter } from "express";
import {
  startGoalDetector,
  stopGoalDetector,
  isGoalDetectorRunning,
  getWatchedMarketCount,
  getRecentSignals,
} from "../lib/goalDetector";

const router: IRouter = Router();

router.get("/goalbot/status", async (_req, res) => {
  res.json({
    isRunning: isGoalDetectorRunning(),
    watchedMarkets: getWatchedMarketCount(),
  });
});

router.post("/goalbot/start", async (_req, res) => {
  startGoalDetector();
  res.json({ ok: true, message: "Goal detector started" });
});

router.post("/goalbot/stop", async (_req, res) => {
  stopGoalDetector();
  res.json({ ok: true, message: "Goal detector stopped" });
});

router.get("/goalbot/signals", async (req, res) => {
  const limit = Math.min(Number(req.query.limit ?? 100), 500);
  const signals = await getRecentSignals(limit);
  res.json(signals);
});

export default router;
