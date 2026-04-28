import { Router, type IRouter } from "express";
import healthRouter from "./health";
import betfairRouter from "./betfair";
import marketsRouter from "./markets";
import strategiesRouter from "./strategies";
import betsRouter from "./bets";
import botRouter from "./bot";
import dashboardRouter from "./dashboard";

const router: IRouter = Router();

router.use(healthRouter);
router.use(betfairRouter);
router.use(marketsRouter);
router.use(strategiesRouter);
router.use(betsRouter);
router.use(botRouter);
router.use(dashboardRouter);

export default router;
