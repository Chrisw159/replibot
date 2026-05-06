import app from "./app";
import { logger } from "./lib/logger";
import { startBot } from "./lib/botEngine";
import { startBookieBot } from "./lib/bookieEngine";
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

  // Auto-resume bots if they were running before the server restarted
  void (async () => {
    try {
      const [config] = await db.select().from(botConfigTable).limit(1);
      if (config?.isRunning) {
        logger.info("Auto-resuming AI bot after server restart");
        await startBot();
      }
      if (config?.bookieIsRunning) {
        logger.info("Auto-resuming Bookie Bot after server restart");
        await startBookieBot();
      }
    } catch (err) {
      logger.error({ err }, "Failed to auto-resume bots on startup");
    }
  })();
});
