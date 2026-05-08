import app from "./app";
import { logger } from "./lib/logger";
import { startDutchBot } from "./lib/dutchEngine";
import { db, botConfigTable } from "@workspace/db";

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

  // Auto-resume the Dutch bot if it was running before the server restarted.
  // (Legacy AI bot and Bookie bot have been retired — only the Combo-strategy
  // Dutch bot is exposed in the UI.)
  void (async () => {
    try {
      const [config] = await db.select().from(botConfigTable).limit(1);
      if (config?.dutchIsRunning) {
        logger.info("Auto-resuming Dutch Bot after server restart");
        await startDutchBot();
      }
    } catch (err) {
      logger.error({ err }, "Failed to auto-resume Dutch Bot on startup");
    }
  })();
});
