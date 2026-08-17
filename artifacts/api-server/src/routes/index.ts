import { Router, type IRouter } from "express";
import healthRouter from "./health";
import betfairRouter from "./betfair";
import marketsRouter from "./markets";
import strategiesRouter from "./strategies";
import betsRouter from "./bets";
import botRouter from "./bot";
import dashboardRouter from "./dashboard";
import settingsRouter from "./settings";
import goalbotRouter from "./goalbot";
import bookieRouter from "./bookie";
import dutchRouter from "./dutch";
import dutchV2Router from "./dutch-v2";
import adminRouter from "./admin";
import soccerRouter from "./soccer";

const router: IRouter = Router();

router.use(healthRouter);
router.use(betfairRouter);
router.use(marketsRouter);
router.use(strategiesRouter);
router.use(betsRouter);
router.use(botRouter);
router.use(dashboardRouter);
router.use(settingsRouter);
router.use(goalbotRouter);
router.use(bookieRouter);
router.use(dutchRouter);
router.use(dutchV2Router);
router.use(adminRouter);
router.use(soccerRouter);

export default router;
