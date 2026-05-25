import app from "./app";
import { logger } from "./lib/logger";
import { startDutchBot } from "./lib/dutchEngine";
import { autoResumeDutchV2Bots } from "./lib/dutchV2Engine";
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

  // Auto-resume Dutching bots (current + v2 paper variants) if they were
  // running before the restart.
  void (async () => {
    try {
      const [config] = await db.select().from(botConfigTable).limit(1);
      if (config?.dutchIsRunning) {
        logger.info("Auto-resuming Dutch Bot after server restart");
        await startDutchBot();
      }
      await autoResumeDutchV2Bots();
    } catch (err) {
      logger.error({ err }, "Failed to auto-resume bots on startup");
    }
  })();
});
