import app from "./app";
import { logger } from "./lib/logger";
import { autoResumeSoccerBot } from "./lib/soccerEngine";
import { db, botConfigTable } from "@workspace/db";
import { eq } from "drizzle-orm";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");

  // Auto-resume Dutching bots (current + v2 paper variants) if they were
  // running before the restart.
  void (async () => {
    try {
      // Operator override: when FORCE_DATA_COLLECTION=true, force the whole
      // server into data-collection mode on every boot regardless of the
      // stored toggle. All four engines honour bot_config.data_collection_mode
      // and place NO bets when it is on. This guarantees a freshly deployed
      // server collects data without anyone having to flip the UI toggle.
      if (process.env["FORCE_DATA_COLLECTION"] === "true") {
        const [existing] = await db.select({ id: botConfigTable.id }).from(botConfigTable).limit(1);
        if (existing) {
          await db.update(botConfigTable).set({ dataCollectionMode: true }).where(eq(botConfigTable.id, existing.id));
        } else {
          await db.insert(botConfigTable).values({ dataCollectionMode: true });
        }
        logger.info("FORCE_DATA_COLLECTION=true — data-collection mode enforced; no bets will be placed");
      }

      // Ensure Dutch bot flag is cleared — horse-racing bots have been retired.
      await db.update(botConfigTable).set({ dutchIsRunning: false });

      await autoResumeSoccerBot();
    } catch (err) {
      logger.error({ err }, "Failed to auto-resume bots on startup");
    }
  })();
});
