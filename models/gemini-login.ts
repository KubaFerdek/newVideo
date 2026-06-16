import { launchPersistentBrowserContext } from "./core/browser-launcher.js";
import * as readline from "readline";
import { logger } from "./core/logger.js";
import { paths } from "./config/paths.js";
import { ensureBrowserProfileExists } from "./core/file-utils.js";

/**
 * Manual Login Flow for Gemini
 *
 * This script:
 * 1. Opens Chrome browser with persistent profile
 * 2. Navigates to Gemini
 * 3. Lets you log in manually
 * 4. Waits for Enter key press
 * 5. Closes browser cleanly (saves session)
 *
 * Usage:
 *   pnpm run gemini:login
 */

async function main() {
  logger.separator();
  logger.separator();
  logger.info("đź”‘ GEMINI MANUAL LOGIN FLOW");
  logger.separator();
  logger.separator();

  const userDataDir = paths.geminiProfile;

  // Ensure profile directory exists
  const profileStatus = ensureBrowserProfileExists(userDataDir);

  if (profileStatus.isFirstRun) {
    logger.info("âś¨ Created new browser profile");
  } else {
    logger.info("đź“ Using existing browser profile");
  }

  logger.info(`   Location: ${userDataDir}`);
  logger.separator();

  let context;

  try {
    logger.info("ďż˝ďż˝ Opening Chrome browser...");
    logger.separator();

    // Launch Chrome with persistent context
    context = await launchPersistentBrowserContext(userDataDir, {
      headless: false, // Must be visible for manual login      viewport: { width: 1280, height: 720 },
      args: ["--disable-blink-features=AutomationControlled"],
    });

    logger.success("Browser opened");

    const page = context.pages()[0] || (await context.newPage());

    // Navigate to Gemini
    logger.info("đźŚ Navigating to Gemini...");
    await page.goto("https://gemini.google.com/", {
      waitUntil: "domcontentloaded",
    });

    logger.success("Gemini loaded");
    logger.separator();
    logger.separator();
    logger.info("INSTRUCTIONS:");
    logger.separator();
    logger.info("  1. âśŤď¸Ź  Log in to Google/Gemini in the browser window");
    logger.info("  2. âś”ď¸Ź  Complete authentication");
    logger.info("  3. âś”ď¸Ź  Accept any terms if prompted");
    logger.info("  4. âś”ď¸Ź  Make sure you can see Gemini's chat interface");
    logger.separator();
    logger.info("  5. âŹŽ  THEN press Enter in this terminal");
    logger.separator();
    logger.separator();

    // Wait for user to press Enter
    await waitForEnter();

    logger.separator();
    logger.info("đź”’ Closing browser and saving session...");
  } catch (error) {
    logger.error("Login flow failed", error as Error);
    throw error;
  } finally {
    if (context) {
      await context.close();
    }
  }

  logger.separator();
  logger.success("SESSION SAVED!");
  logger.separator();
  logger.info("Your Google/Gemini session has been saved to:");
  logger.info(`  ${userDataDir}`);
  logger.separator();
  logger.info("You can now run your pipeline:");
  logger.info("");
  logger.info("  pnpm run dev:complete");
  logger.info("");
  logger.info("The pipeline will use your saved session automatically.");
  logger.separator();
  logger.separator();
}

/**
 * Wait for user to press Enter
 */
function waitForEnter(): Promise<void> {
  return new Promise(resolve => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    rl.question("", () => {
      rl.close();
      resolve();
    });
  });
}

// Run the login flow
main().catch(error => {
  logger.error("Fatal error in login flow", error);
  process.exit(1);
});
