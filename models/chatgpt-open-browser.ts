import { logger } from "./core/logger.js";
import {
  defaultCdpUrl,
  openExternalAutomationBrowser,
} from "./core/external-browser.js";

async function main(): Promise<void> {
  await openExternalAutomationBrowser();
  logger.info(`CDP endpoint: ${defaultCdpUrl}`);
  logger.info("Log in to ChatGPT in that browser window, then run:");
  logger.info("  npm run chatgpt:images:browser");
}

main().catch(error => {
  logger.error("Failed to open browser", error);
  process.exit(1);
});
