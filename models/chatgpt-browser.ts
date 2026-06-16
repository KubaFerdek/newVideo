import { type BrowserContext, type Locator, type Page } from "playwright";
import { launchPersistentBrowserContext } from "./core/browser-launcher.js";
import { closeBrowserContext } from "./core/browser-cleanup.js";
import fs from "fs";
import path from "path";
import { logger } from "./core/logger.js";
import {
  ensureDir,
  ensureBrowserProfileExists,
  readJsonFile,
} from "./core/file-utils.js";
import { paths } from "./config/paths.js";
import {
  throttleBrowserLaunch,
  type BrowserThrottleStep,
} from "./core/browser-throttle.js";

/**
 * ChatGPT Browser Automation Service
 *
 * Real implementation using Playwright browser automation.
 * Launches a persistent browser context with saved ChatGPT session,
 * sends prompts, and extracts responses.
 */

// Global counters for modal detection
let globalModalCounter = 0;
let modalCounterPerPipeline = 0;
let rateLimitModalCounter = 0;
let rateLimitModalPerPipeline = 0;

export function resetModalCounter(): void {
  modalCounterPerPipeline = 0;
  rateLimitModalPerPipeline = 0;
}

export function getModalCount(): {
  global: number;
  pipeline: number;
  rateLimit: number;
  rateLimitPipeline: number;
} {
  return {
    global: globalModalCounter,
    pipeline: modalCounterPerPipeline,
    rateLimit: rateLimitModalCounter,
    rateLimitPipeline: rateLimitModalPerPipeline,
  };
}

export interface ChatGPTOptions {
  headless?: boolean;
  timeout?: number;
  userDataDir?: string;
  maxRetries?: number;
  throttleStep?: BrowserThrottleStep;
  stageName?: string; // For logging which stage triggered modal
}

export interface ImageGenerationParams {
  prompt: string;
  outputPath: string;
  width?: number;
  height?: number;
  style?: "realistic" | "artistic" | "minimalist" | "technical";
}

export interface ChatGPTSessionAskOptions {
  timeout?: number;
  stageName?: string;
}

export interface ChatGPTBrowserSession {
  ask(prompt: string, options?: ChatGPTSessionAskOptions): Promise<string>;
  close(): Promise<void>;
}

/**
 * Helper: Retry a function with exponential backoff
 */
async function withRetry<T>(
  fn: () => Promise<T>,
  options: {
    retries: number;
    retryDelay: number;
    taskName: string;
  },
): Promise<T> {
  let lastError: Error;

  for (let attempt = 1; attempt <= options.retries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error as Error;

      if (attempt < options.retries) {
        logger.warn(
          `${options.taskName} failed (attempt ${attempt}/${options.retries}): ${lastError.message}`,
        );
        const delay = options.retryDelay * attempt; // Exponential backoff
        logger.info(`Retrying in ${delay / 1000}s...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }

  throw lastError!;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function getOpenPages(context: BrowserContext): Page[] {
  return context.pages().filter(page => !page.isClosed());
}

async function getOrCreateAutomationPage(
  context: BrowserContext,
): Promise<Page> {
  const openPages = getOpenPages(context);
  if (openPages.length > 0) {
    const chatGptPage = openPages.find(
      page =>
        page.url().includes("chatgpt.com") ||
        page.url().includes("chat.openai.com"),
    );

    if (chatGptPage) {
      await chatGptPage.bringToFront().catch(() => undefined);
      return chatGptPage;
    }

    // Prefer the most recently opened tab in persistent contexts.
    const page = openPages[openPages.length - 1];
    await page.bringToFront().catch(() => undefined);
    return page;
  }

  return context.newPage();
}

function recoverActivePage(context: BrowserContext): Page {
  const openPages = getOpenPages(context);

  if (openPages.length === 0) {
    throw new Error(
      "Browser tab was closed unexpectedly and no active tab is available.",
    );
  }

  return openPages[openPages.length - 1];
}

async function navigateToChatGptHome(
  context: BrowserContext,
  page: Page,
): Promise<Page> {
  await page.bringToFront().catch(() => undefined);
  logger.info("Navigating to https://chatgpt.com/");
  await page.goto("https://chatgpt.com/", { waitUntil: "domcontentloaded" });
  await sleep(3000);

  if (page.isClosed()) {
    logger.warn("Initial browser tab closed after navigation, recovering...");
    page = recoverActivePage(context);
  }

  logger.success("ChatGPT page loaded");
  return page;
}
/**
 * Detect and close modals (system prompt, rate limit, etc.)
 * Returns { closed: boolean, isRateLimit: boolean }
 */
async function detectAndCloseModals(
  page: any,
  stageName: string = "unknown",
): Promise<{ closed: boolean; isRateLimit: boolean }> {
  try {
    // Wait a moment for modal to potentially appear
    await page.waitForTimeout(1500);

    // Possible selectors for the modal
    const modalSelectors = [
      '[role="dialog"]',
      '[role="alertdialog"]',
      ".modal",
      '[class*="modal"]',
      '[data-testid*="modal"]',
      '[class*="Modal"]',
    ];

    for (const selector of modalSelectors) {
      const modal = page.locator(selector).first();
      const isVisible = await modal
        .isVisible({ timeout: 500 })
        .catch(() => false);

      if (isVisible) {
        const modalText = await modal.innerText().catch(() => "");

        // CHECK 1: Rate Limit Modal (PRIORITY - more critical)
        if (
          modalText.includes("Zbyt wiele żądań") ||
          modalText.includes("Too many requests") ||
          modalText.includes("Za często wysyłasz") ||
          modalText.includes("rate limit") ||
          modalText.includes("ograniczyliśmy dostęp") ||
          modalText.includes("Poczekaj kilka minut")
        ) {
          rateLimitModalCounter++;
          rateLimitModalPerPipeline++;

          // Calculate wait time: 5 minutes for first, 10 for second, 15 for third, etc.
          const waitMinutes = rateLimitModalPerPipeline * 5;
          const waitMs = waitMinutes * 60 * 1000;

          logger.error("");
          logger.error("🚨 RATE LIMIT MODAL DETECTED!");
          logger.error(`   Stage: ${stageName}`);
          logger.error(
            `   Rate limit occurrence #${rateLimitModalPerPipeline} in this pipeline`,
          );
          logger.error(
            `   Total rate limit modals (global): ${rateLimitModalCounter}`,
          );
          logger.error("");
          logger.warn("⚠️  ChatGPT is rate limiting requests!");
          logger.warn(`   Waiting ${waitMinutes} minutes before continuing...`);
          logger.warn("   Pipeline will automatically resume after the wait");
          logger.warn("");

          // Try to find and click close/understand button
          const closeButtonSelectors = [
            'button:has-text("Rozumiem")',
            'button:has-text("I understand")',
            'button:has-text("OK")',
            'button:has-text("Close")',
            'button:has-text("Zamknij")',
            'button[aria-label*="Close"]',
            'button[aria-label*="Zamknij"]',
            'button:has-text("✕")',
            'button:has-text("×")',
            '[class*="close"]',
            '[data-testid*="close"]',
          ];

          let closed = false;
          for (const closeSelector of closeButtonSelectors) {
            try {
              const closeButton = modal.locator(closeSelector).first();
              const isCloseVisible = await closeButton
                .isVisible({ timeout: 500 })
                .catch(() => false);

              if (isCloseVisible) {
                await closeButton.click();
                await page.waitForTimeout(1000);
                logger.success("✅ Rate limit modal closed");
                closed = true;
                break;
              }
            } catch (e) {
              // Try next selector
            }
          }

          if (!closed) {
            logger.info("Attempting to close modal with Escape key...");
            await page.keyboard.press("Escape");
            await page.waitForTimeout(500);
          }

          // Wait the calculated time with progress updates
          logger.warn("");
          logger.warn(`⏳ Starting ${waitMinutes}-minute wait period...`);
          const startTime = Date.now();
          const endTime = startTime + waitMs;

          // Show progress every minute
          let lastMinuteLogged = 0;
          while (Date.now() < endTime) {
            const elapsed = Date.now() - startTime;
            const elapsedMinutes = Math.floor(elapsed / 60000);
            const remaining = endTime - Date.now();
            const remainingMinutes = Math.ceil(remaining / 60000);

            if (elapsedMinutes > lastMinuteLogged) {
              logger.info(
                `   ⏱️  ${elapsedMinutes}/${waitMinutes} minutes elapsed - ${remainingMinutes} minutes remaining`,
              );
              lastMinuteLogged = elapsedMinutes;
            }

            // Wait 10 seconds before checking again
            await page.waitForTimeout(10000);
          }

          logger.success("");
          logger.success(`✅ Wait period complete! Resuming pipeline...`);
          logger.success("");

          return { closed: true, isRateLimit: true };
        }

        // CHECK 2: System Prompt Modal
        if (
          modalText.includes("Materials Pack System Prompt") ||
          modalText.includes("CRITICAL RULES") ||
          modalText.includes("educational content creator") ||
          modalText.length > 5000 // System prompt is very long
        ) {
          globalModalCounter++;
          modalCounterPerPipeline++;

          logger.warn("");
          logger.warn("🚨 SYSTEM PROMPT MODAL DETECTED!");
          logger.warn(`   Stage: ${stageName}`);
          logger.warn(
            `   Modal appearances in this pipeline: ${modalCounterPerPipeline}`,
          );
          logger.warn(
            `   Total modal appearances (global): ${globalModalCounter}`,
          );
          logger.warn("");

          // Try to find and click close button
          const closeButtonSelectors = [
            'button[aria-label*="Close"]',
            'button[aria-label*="Zamknij"]',
            'button:has-text("Close")',
            'button:has-text("Zamknij")',
            'button:has-text("OK")',
            'button:has-text("✕")',
            'button:has-text("×")',
            '[class*="close"]',
            '[data-testid*="close"]',
          ];

          let closed = false;
          for (const closeSelector of closeButtonSelectors) {
            try {
              const closeButton = modal.locator(closeSelector).first();
              const isCloseVisible = await closeButton
                .isVisible({ timeout: 500 })
                .catch(() => false);

              if (isCloseVisible) {
                await closeButton.click();
                await page.waitForTimeout(500);
                logger.success("✅ System prompt modal closed");
                closed = true;
                break;
              }
            } catch (e) {
              // Try next selector
            }
          }

          if (!closed) {
            logger.info("Attempting to close modal with Escape key...");
            await page.keyboard.press("Escape");
            await page.waitForTimeout(500);
          }

          // Suggest throttle increase
          if (modalCounterPerPipeline >= 2) {
            logger.warn(
              "⚠️  Multiple modals detected - consider increasing throttle delays",
            );
          }

          return { closed: true, isRateLimit: false };
        }
      }
    }

    return { closed: false, isRateLimit: false };
  } catch (error) {
    logger.debug(`Modal detection error: ${error}`);
    return { closed: false, isRateLimit: false };
  }
}

async function closeInitialChatGptModals(page: Page): Promise<void> {
  try {
    await page.waitForTimeout(1500);

    const modalButtonSelectors = [
      'button.btn-primary:has-text("Rozumiem")',
      'button.btn-primary:has-text("I understand")',
      'button.btn-primary:has-text("OK")',
      'button.btn-primary:has-text("Continue")',
      'button.btn-primary:has-text("Kontynuuj")',
      'button:has-text("Rozumiem")',
      'button:has-text("I understand")',
      'button:has-text("OK")',
      'button:has-text("Continue")',
    ];

    for (const selector of modalButtonSelectors) {
      const button = page.locator(selector).first();
      const isVisible = await button
        .isVisible({ timeout: 500 })
        .catch(() => false);

      if (isVisible) {
        logger.info(`Found initial modal button, clicking: ${selector}`);
        await button.click();
        await page.waitForTimeout(1000);
        logger.success("Initial modal closed");
        return;
      }
    }

    logger.debug("No initial ChatGPT modal detected");
  } catch (error) {
    logger.debug(`Initial modal check failed (non-critical): ${error}`);
  }
}

async function waitForTextGenerationToFinish(
  page: Page,
  timeout: number,
): Promise<void> {
  const maxWaitTime = timeout / 1000;
  let waitedTime = 0;

  const stopButtonSelectors = [
    'button[aria-label*="Stop"]',
    'button:has-text("Stop generating")',
    'button[data-testid*="stop"]',
  ];

  logger.info("Waiting for generation to complete...");
  await page.waitForTimeout(1000);

  while (waitedTime < maxWaitTime) {
    let foundStopButton = false;

    for (const selector of stopButtonSelectors) {
      const stopButton = page.locator(selector).first();
      const isVisible = await stopButton
        .isVisible({ timeout: 500 })
        .catch(() => false);

      if (isVisible) {
        foundStopButton = true;
        break;
      }
    }

    if (!foundStopButton) {
      logger.success("Generation completed!");
      await page.waitForTimeout(2000);
      return;
    }

    await page.waitForTimeout(1000);
    waitedTime++;

    if (waitedTime % 5 === 0) {
      const percent = Math.round((waitedTime / maxWaitTime) * 100);
      logger.info(
        `Generating... ${waitedTime}s / ${maxWaitTime}s (${percent}%)`,
      );
    }
  }

  logger.warn(
    `Timeout reached (${maxWaitTime}s) - attempting to extract partial response`,
  );
  await page.waitForTimeout(2000);
}

async function extractLatestAssistantResponse(page: Page): Promise<string> {
  logger.info("Extracting response from ChatGPT");

  const responseElements = await page
    .locator('[data-message-author-role="assistant"]')
    .all();

  if (responseElements.length === 0) {
    throw new Error(
      "No response found from ChatGPT. The page structure may have changed or the session may be invalid.",
    );
  }

  const lastResponse = responseElements[responseElements.length - 1];
  const responseText = await lastResponse.innerText();

  if (!responseText || responseText.trim().length === 0) {
    throw new Error("Received empty response from ChatGPT");
  }

  const errorPatterns = [
    /przekroczono limit czasu/i,
    /timeout/i,
    /try again/i,
    /something went wrong/i,
    /too many requests/i,
    /rate limit/i,
  ];

  for (const pattern of errorPatterns) {
    if (pattern.test(responseText)) {
      throw new Error(
        `ChatGPT returned an error message instead of content. Response: ${responseText.substring(0, 200)}`,
      );
    }
  }

  logger.success("Response received from ChatGPT");
  logger.debug(`Response length: ${responseText.length} characters`);

  return responseText;
}

async function sendPromptAndExtractChatGptResponse(
  page: Page,
  prompt: string,
  options: { timeout: number; stageName: string },
): Promise<string> {
  logger.info("Sending prompt to ChatGPT");
  await pastePromptIntoChatGpt(page, prompt);
  await submitChatGptPrompt(page);
  logger.info("Prompt sent. Waiting for response...");

  const modalResult = await detectAndCloseModals(page, options.stageName);
  if (modalResult.closed) {
    logger.info(
      modalResult.isRateLimit
        ? "Continuing after rate limit wait period..."
        : "Continuing after modal dismissal...",
    );
  }

  await waitForTextGenerationToFinish(page, options.timeout);
  return extractLatestAssistantResponse(page);
}

/**
 * Asks ChatGPT a question using browser automation
 *
 * @param prompt - The prompt to send to ChatGPT
 * @param options - Optional configuration for browser automation
 * @returns The response text from ChatGPT
 */
export async function askChatGptInBrowser(
  prompt: string,
  options: ChatGPTOptions = {},
): Promise<string> {
  const {
    headless = false,
    timeout = 900000, // 15 minutes default (increased for long responses)
    userDataDir = paths.chatgptProfile,
    maxRetries = 3,
    throttleStep = "default",
    stageName = "unknown",
  } = options;

  return withRetry(
    async () => {
      return await askChatGptInBrowserImpl(prompt, {
        headless,
        timeout,
        userDataDir,
        throttleStep,
        stageName,
      });
    },
    {
      retries: maxRetries,
      retryDelay: 5000, // 5s, 10s, 15s...
      taskName: "ChatGPT automation",
    },
  );
}

export async function createChatGptBrowserSession(
  options: ChatGPTOptions = {},
): Promise<ChatGPTBrowserSession> {
  const {
    headless = false,
    timeout = 900000,
    userDataDir = paths.chatgptProfile,
    maxRetries = 3,
    throttleStep = "default",
    stageName = "unknown",
  } = options;

  logger.info("Launching persistent ChatGPT browser session");
  logger.debug(`Headless: ${headless}, Timeout: ${timeout}ms`);

  const profileStatus = ensureBrowserProfileExists(userDataDir);

  if (profileStatus.isFirstRun) {
    logger.separator();
    logger.info("First run detected - browser profile created");
    logger.info(`Profile location: ${userDataDir}`);
    logger.warn("You will need to log in to ChatGPT manually");
    logger.info("Your session will be saved for future runs");
    logger.separator();
  } else {
    logger.debug(`Using existing browser profile: ${userDataDir}`);
  }

  await throttleBrowserLaunch(throttleStep, "chatgpt");

  logger.info(`Opening browser context: ${userDataDir}`);
  const context = await launchPersistentBrowserContext(userDataDir, {
    headless,
    allowHeadlessFallback: true,
    viewport: { width: 1280, height: 720 },
    args: ["--disable-blink-features=AutomationControlled"],
  });

  let closed = false;
  let page: Page;

  try {
    page = await getOrCreateAutomationPage(context);
    page = await navigateToChatGptHome(context, page);
    await ensureChatGptLoggedIn(page);
    await closeInitialChatGptModals(page);
  } catch (error) {
    logger.info("Closing browser context after session startup failure");
    await closeBrowserContext(context, "ChatGPT browser context");
    throw error;
  }

  function getActivePage(): Page {
    if (page.isClosed()) {
      page = recoverActivePage(context);
    }

    return page;
  }

  return {
    async ask(
      prompt: string,
      askOptions: ChatGPTSessionAskOptions = {},
    ): Promise<string> {
      if (closed) {
        throw new Error("ChatGPT browser session is already closed.");
      }

      const askTimeout = askOptions.timeout ?? timeout;
      const askStageName = askOptions.stageName ?? stageName;

      return withRetry(
        async () =>
          sendPromptAndExtractChatGptResponse(getActivePage(), prompt, {
            timeout: askTimeout,
            stageName: askStageName,
          }),
        {
          retries: maxRetries,
          retryDelay: 5000,
          taskName: `ChatGPT automation (${askStageName})`,
        },
      );
    },
    async close(): Promise<void> {
      if (closed) {
        return;
      }

      closed = true;
      logger.info("Closing browser context");
      await closeBrowserContext(context, "ChatGPT browser context");
    },
  };
}

/**
 * Internal implementation of ChatGPT automation
 */
async function askChatGptInBrowserImpl(
  prompt: string,
  options: {
    headless: boolean;
    timeout: number;
    userDataDir: string;
    throttleStep: BrowserThrottleStep;
    stageName: string;
  },
): Promise<string> {
  const { headless, timeout, userDataDir, throttleStep, stageName } = options;

  logger.info("đź¤– Launching ChatGPT browser automation");
  logger.debug(`Prompt length: ${prompt.length} characters`);
  logger.debug(`Headless: ${headless}, Timeout: ${timeout}ms`);

  // Ensure browser profile exists
  const profileStatus = ensureBrowserProfileExists(userDataDir);

  if (profileStatus.isFirstRun) {
    logger.separator();
    logger.info("đź†• First run detected - browser profile created");
    logger.info(`đź“ Profile location: ${userDataDir}`);
    logger.warn("âš ď¸Ź  You will need to log in to ChatGPT manually");
    logger.info("   Your session will be saved for future runs");
    logger.separator();
  } else {
    logger.debug(`Using existing browser profile: ${userDataDir}`);
  }

  let context;

  try {
    await throttleBrowserLaunch(throttleStep, "chatgpt");

    // Launch persistent browser context with saved session
    logger.info(`Opening browser context: ${userDataDir}`);
    context = await launchPersistentBrowserContext(userDataDir, {
      headless,
      allowHeadlessFallback: true,
      viewport: { width: 1280, height: 720 },
      args: ["--disable-blink-features=AutomationControlled"],
    });

    let page = await getOrCreateAutomationPage(context);
    page = await navigateToChatGptHome(context, page);

    // Check if user is logged in
    logger.info("đź” Checking login status...");
    const textboxSelector = CHATGPT_TEXTBOX_SELECTOR;

    const isLoggedIn = await page
      .locator(textboxSelector)
      .isVisible({ timeout: 5000 })
      .catch(() => false);

    if (!isLoggedIn) {
      logger.warn("âš ď¸Ź  You are NOT logged in to ChatGPT!");
      logger.separator();
      logger.info("đź”‘ LOGIN MODE ACTIVATED");
      logger.separator();
      logger.info("Please log in to ChatGPT in the browser window.");
      logger.info("Steps:");
      logger.info("  1. Click 'Log in' or 'Sign up'");
      logger.info("  2. Enter your credentials");
      logger.info("  3. Complete any verification");
      logger.separator();
      logger.info("Waiting 60 seconds for you to log in...");
      logger.info("   (The browser will stay open)");
      logger.separator();

      // Wait 60 seconds for user to log in
      await page.waitForTimeout(60000);

      // Check again if logged in
      const isNowLoggedIn = await page
        .locator(textboxSelector)
        .isVisible({ timeout: 5000 })
        .catch(() => false);

      if (!isNowLoggedIn) {
        logger.separator();
        logger.warn("Still not logged in after 60 seconds.");
        logger.info("Next steps:");
        logger.info("  1. Complete your login in the browser");
        logger.info("  2. Run the command again: pnpm dev");
        logger.info("  3. Your session will be saved for future runs");
        logger.separator();

        throw new Error(
          "Not logged in to ChatGPT. Please log in and try again.",
        );
      }

      logger.success("Login detected! Session will be saved.");
      logger.info("Continuing with content generation...");
      logger.separator();
    } else {
      logger.success("Already logged in to ChatGPT");
    }

    // Check for initial modals (e.g., "Rozumiem" / "I understand" modal)
    logger.debug("Checking for initial modals...");
    try {
      await page.waitForTimeout(1500);

      // Look for common modal patterns with "Rozumiem" or similar buttons
      const modalButtonSelectors = [
        'button.btn-primary:has-text("Rozumiem")',
        'button.btn-primary:has-text("I understand")',
        'button.btn-primary:has-text("OK")',
        'button.btn-primary:has-text("Continue")',
        'button.btn-primary:has-text("Kontynuuj")',
        'button:has-text("Rozumiem")',
        'button:has-text("I understand")',
      ];

      let modalClosed = false;
      for (const btnSelector of modalButtonSelectors) {
        try {
          const button = page.locator(btnSelector).first();
          const isVisible = await button
            .isVisible({ timeout: 500 })
            .catch(() => false);

          if (isVisible) {
            logger.info(
              `Found modal with "${btnSelector}" button, clicking...`,
            );
            await button.click();
            await page.waitForTimeout(1000);
            logger.success("Modal closed successfully");
            modalClosed = true;
            break;
          }
        } catch (e) {
          // Try next selector
        }
      }

      if (!modalClosed) {
        logger.debug("No initial modal detected");
      }
    } catch (e) {
      logger.debug(`Error checking for initial modal (non-critical): ${e}`);
    }

    logger.info("Sending prompt to ChatGPT");
    await pastePromptIntoChatGpt(page, prompt);
    await submitChatGptPrompt(page);
    logger.info("Prompt sent. Waiting for response...");

    // Detect and close modals (rate limit, system prompt, etc.)
    const modalResult = await detectAndCloseModals(page, stageName);
    if (modalResult.closed) {
      if (modalResult.isRateLimit) {
        // Rate limit was handled with automatic wait - continue processing
        logger.info("Continuing after rate limit wait period...");
      } else {
        logger.info("Continuing after modal dismissal...");
      }
    }

    // Wait for generation to complete
    const maxWaitTime = timeout / 1000; // Convert to seconds
    let waitedTime = 0;
    let isGenerating = true;

    // Give it a moment to start generating
    await page.waitForTimeout(1000);

    const stopButtonSelectors = [
      'button[aria-label*="Stop"]',
      'button:has-text("Stop generating")',
      'button[data-testid*="stop"]',
    ];

    logger.info("Waiting for generation to complete...");

    while (isGenerating && waitedTime < maxWaitTime) {
      let foundStopButton = false;

      // Check all possible stop button selectors
      for (const selector of stopButtonSelectors) {
        try {
          const stopButton = page.locator(selector).first();
          const isVisible = await stopButton
            .isVisible({ timeout: 500 })
            .catch(() => false);

          if (isVisible) {
            foundStopButton = true;
            break;
          }
        } catch (e) {
          // Continue checking other selectors
        }
      }

      if (!foundStopButton) {
        // Stop button disappeared - generation complete
        logger.success("Generation completed!");
        isGenerating = false;
        break;
      }

      // Wait and check again
      await page.waitForTimeout(1000);
      waitedTime++;

      // Progress update every 5 seconds
      if (waitedTime % 5 === 0) {
        const percent = Math.round((waitedTime / maxWaitTime) * 100);
        logger.info(
          `Generating... ${waitedTime}s / ${maxWaitTime}s (${percent}%)`,
        );
      }
    }

    if (waitedTime >= maxWaitTime) {
      logger.warn(
        `Timeout reached (${maxWaitTime}s) - attempting to extract partial response`,
      );
    }

    // Wait a bit for final rendering
    await page.waitForTimeout(2000);

    // Extract response from last assistant message
    logger.info("Extracting response from ChatGPT");

    const responseElements = await page
      .locator('[data-message-author-role="assistant"]')
      .all();

    if (responseElements.length === 0) {
      throw new Error(
        "No response found from ChatGPT. The page structure may have changed or the session may be invalid.",
      );
    }

    // Get the last assistant message
    const lastResponse = responseElements[responseElements.length - 1];
    const responseText = await lastResponse.innerText();

    if (!responseText || responseText.trim().length === 0) {
      throw new Error("Received empty response from ChatGPT");
    }

    // Check for ChatGPT error messages
    const errorPatterns = [
      /przekroczono limit czasu/i,
      /timeout/i,
      /try again/i,
      /sprĂłbuj ponownie/i,
      /ponĂłw prĂłbÄ™/i,
      /something went wrong/i,
      /coĹ› poszĹ‚o nie tak/i,
    ];

    for (const pattern of errorPatterns) {
      if (pattern.test(responseText)) {
        throw new Error(
          `ChatGPT returned an error message instead of content. Response: ${responseText.substring(0, 200)}`,
        );
      }
    }

    logger.success("Response received from ChatGPT");
    logger.debug(`Response length: ${responseText.length} characters`);

    return responseText;
  } catch (error) {
    logger.error("ChatGPT automation failed", error as Error);

    // Provide helpful error messages
    if ((error as Error).message.includes("Target page, context or browser")) {
      throw new Error(
        `Browser context was closed unexpectedly. Close Chrome windows using profile "${userDataDir}" and rerun. If needed, refresh login with "pnpm run chatgpt:login" in models package.`,
      );
    }

    if ((error as Error).message.includes("Timeout")) {
      throw new Error(
        `ChatGPT did not respond within ${timeout}ms. Try increasing the timeout or check your internet connection.`,
      );
    }

    throw error;
  } finally {
    // Close browser context
    if (context) {
      logger.info("Closing browser context");
      await closeBrowserContext(context, "ChatGPT browser context");
    }
  }
}

/**
 * Helper: Ensure directory exists
 */
function ensureDirectoryExists(filePath: string): void {
  const dir = path.dirname(filePath);
  ensureDir(dir);
}

const LEADING_IMAGE_PROMPT_PATTERNS = [
  /^(?:image|graphic)\s+prompt\s*:?\s*/i,
  /^(?:please\s+)?(?:generate|create|make|design)\s+an?\s+image\s*:?\s*/i,
  /^(?:please\s+)?(?:generate|create|make|design)\s+an?\s+illustration\s*:?\s*/i,
  /^(?:please\s+)?(?:generate|create|make|design)\s+/i,
  /^(?:wygeneruj|stw[oĂł]rz|utw[oĂł]rz|zaprojektuj)\s+obraz(?:ek)?\s*:?\s*/i,
  /^(?:wygeneruj|stw[oĂł]rz|utw[oĂł]rz|zaprojektuj)\s+ilustracj[Ä™e]\s*:?\s*/i,
  /^(?:wygeneruj|stw[oĂł]rz|utw[oĂł]rz|zaprojektuj)\s+/i,
];

function sanitizeImagePrompt(prompt: string): string {
  let sanitized = prompt.trim().replace(/^["']+|["']+$/g, "");
  let previous = "";

  while (sanitized !== previous) {
    previous = sanitized;

    for (const pattern of LEADING_IMAGE_PROMPT_PATTERNS) {
      sanitized = sanitized.replace(pattern, "").trim();
    }
  }

  return sanitized.replace(/\s+/g, " ");
}

export function buildChatGPTImagePrompt(prompt: string): string {
  const descriptivePrompt = prompt.trim();

  return [
    "Generate an image from the description below.",
    "Output must be IMAGE ONLY using DALL-E.",
    "Do not return text, explanations, or alternatives.",
    "",
    "Image description:",
    descriptivePrompt,
  ].join("\n");
}

/**
 * Generates an image using ChatGPT (DALL-E) via browser automation
 *
 * @param params - Generation parameters including prompt and output path
 * @param options - Optional browser configuration
 * @returns Promise that resolves when image is saved
 */
export async function generateImageInBrowser(
  params: ImageGenerationParams,
  options: ChatGPTOptions = {},
): Promise<void> {
  const {
    prompt,
    outputPath,
    width = 1024,
    height = 1024,
    style = "realistic",
  } = params;

  const {
    headless = false,
    timeout = 300000, // 5 minutes default
    userDataDir = paths.chatgptProfile,
    throttleStep = "graphics",
  } = options;

  logger.info(
    "đźŽ¨ Launching ChatGPT (DALL-E) browser automation for image generation",
  );
  logger.debug(`Prompt: ${prompt.substring(0, 100)}...`);
  logger.debug(`Output: ${outputPath}`);
  logger.debug(`Style: ${style}, Size: ${width}x${height}`);
  logger.debug(`Headless: ${headless}, Timeout: ${timeout}ms`);

  // Ensure browser profile exists
  const profileStatus = ensureBrowserProfileExists(userDataDir);

  if (profileStatus.isFirstRun) {
    logger.separator();
    logger.info("đź†• First run detected - browser profile created");
    logger.info(`đź“ Profile location: ${userDataDir}`);
    logger.warn("âš ď¸Ź  You will need to log in to ChatGPT manually");
    logger.info("   Your session will be saved for future runs");
    logger.separator();
  } else {
    logger.debug(`Using existing browser profile: ${userDataDir}`);
  }

  let context;

  try {
    // Ensure output directory exists
    ensureDirectoryExists(outputPath);

    await throttleBrowserLaunch(throttleStep, "chatgpt");

    // Launch persistent browser context with saved session
    logger.info(`Opening browser context: ${userDataDir}`);
    context = await launchPersistentBrowserContext(userDataDir, {
      headless,
      allowHeadlessFallback: true,
      viewport: { width: 1280, height: 720 },
      acceptDownloads: true,
      args: ["--disable-blink-features=AutomationControlled"],
    });

    let page = await getOrCreateAutomationPage(context);
    page = await navigateToChatGptHome(context, page);

    // Check if user is logged in
    logger.info("đź” Checking login status...");

    // Using same selectors as askChatGptInBrowser
    const textboxSelector = CHATGPT_TEXTBOX_SELECTOR;

    const isLoggedIn = await page
      .locator(textboxSelector)
      .isVisible({ timeout: 5000 })
      .catch(() => false);

    if (!isLoggedIn) {
      logger.separator();
      logger.error("NOT LOGGED IN TO CHATGPT!");
      logger.separator();
      logger.info("You need to log in to ChatGPT first.");
      logger.info("");
      logger.info("đź”‘ RUN THE LOGIN FLOW:");
      logger.info("");
      logger.info("  pnpm run chatgpt:login");
      logger.info("");
      logger.info("This will:");
      logger.info("  1. Open Chrome browser");
      logger.info("  2. Navigate to ChatGPT");
      logger.info("  3. Let you log in manually");
      logger.info("  4. Save your session for future runs");
      logger.info("");
      logger.info("After login, run your pipeline again.");
      logger.separator();

      throw new Error(
        "Not logged in to ChatGPT. Run 'pnpm run chatgpt:login' first.",
      );
    }

    logger.success("Already logged in to ChatGPT");

    // Sanitize and build execution prompt
    const descriptivePrompt = sanitizeImagePrompt(prompt);

    if (!descriptivePrompt) {
      throw new Error("Image prompt is empty after sanitization");
    }

    const executionPrompt = buildChatGPTImagePrompt(descriptivePrompt);

    logger.info("Sending image generation prompt to ChatGPT");
    await withRetry(
      async () => {
        await sendChatGptImagePrompt(page, executionPrompt);
      },
      {
        retries: 3,
        retryDelay: 2000,
        taskName: "Send image prompt",
      },
    );

    // STEP 1: Wait for image generation to start and complete
    logger.info("STEP 1: Waiting for DALL-E image generation...");
    logger.info(`This can take 30-60 seconds`);
    logger.info(`(max ${timeout / 1000}s)`);

    // ChatGPT/DALL-E specific image selectors
    const imageSelectors = [
      'div[class*="imagegen-image"] img', // DALL-E image container (primary)
      'div[id^="image-"] img', // Image by ID prefix
      '[data-message-author-role="assistant"] img', // Images in assistant messages
      '[data-testid="conversation-turn-content"] img', // Content container images
      'div[class*="markdown"] img', // Markdown content images
      'img[src*="oaidalleapiprodscus"]', // DALL-E CDN images
      'img[src*="dalle"]', // DALL-E images
      'img[alt*="dall"]', // Images with DALL-E in alt text
      'img[src*="backend-api/estuary"]', // Estuary CDN images
      "article img", // Images inside article/response containers
      'img[src^="data:image"]', // Base64 images
      'img[src^="blob:"]', // Blob URLs
    ];

    const MIN_IMAGE_SIZE = 200; // Minimum 200x200 to avoid avatars/icons
    let targetImage = null;
    let imageAppeared = false;
    const maxWaitTime = timeout / 1000;
    let waitedTime = 0;

    // Actively wait for a LARGE image to appear
    while (!imageAppeared && waitedTime < maxWaitTime) {
      for (const selector of imageSelectors) {
        const images = await page.locator(selector).all();

        if (images.length > 0) {
          // Check images from newest to oldest (reverse order)
          for (let i = images.length - 1; i >= 0; i--) {
            const img = images[i];

            try {
              const isVisible = await img
                .isVisible({ timeout: 500 })
                .catch(() => false);

              if (!isVisible) continue;

              // Get image dimensions to filter out small images (avatars, icons)
              const box = await img.boundingBox();

              if (
                box &&
                box.width >= MIN_IMAGE_SIZE &&
                box.height >= MIN_IMAGE_SIZE
              ) {
                // Found a large image!
                imageAppeared = true;
                targetImage = img;
                logger.success(
                  `Image appeared! Size: ${box.width}x${box.height} (selector: ${selector})`,
                );
                break;
              }
            } catch (e) {
              // Continue checking
            }
          }

          if (imageAppeared) break;
        }
      }

      if (!imageAppeared) {
        await page.waitForTimeout(2000);
        waitedTime += 2;

        // Progress update every 10 seconds
        if (waitedTime % 10 === 0) {
          const percent = Math.round((waitedTime / maxWaitTime) * 100);
          logger.info(
            `   Waiting for image... ${waitedTime}s / ${maxWaitTime}s (${percent}%)`,
          );
        }
      }
    }

    if (!imageAppeared || !targetImage) {
      throw new Error(
        `Image did not appear after ${waitedTime}s. Generation may have failed or UI selectors need updating.`,
      );
    }

    // STEP 2: Wait for generation to complete
    logger.info("STEP 2: Waiting for generation to complete...");

    // Using same stop button selectors as askChatGptInBrowser
    const stopButtonSelectors = [
      'button[aria-label*="Stop"]',
      'button:has-text("Stop generating")',
      'button[data-testid*="stop"]',
    ];

    let completionWaitTime = 0;
    const maxCompletionWait = 60;
    let isGenerating = true;

    while (isGenerating && completionWaitTime < maxCompletionWait) {
      let foundStopButton = false;

      for (const selector of stopButtonSelectors) {
        try {
          const stopButton = page.locator(selector).first();
          const isVisible = await stopButton
            .isVisible({ timeout: 500 })
            .catch(() => false);

          if (isVisible) {
            foundStopButton = true;
            break;
          }
        } catch (e) {
          // Continue
        }
      }

      if (!foundStopButton) {
        logger.success("Generation appears complete!");
        isGenerating = false;
        break;
      }

      await page.waitForTimeout(1000);
      completionWaitTime++;

      if (completionWaitTime % 5 === 0) {
        logger.info(`   Still generating... ${completionWaitTime}s`);
      }
    }

    // STEP 3: Wait for final rendering
    logger.info("STEP 3: Waiting for image to stabilize...");
    await page.waitForTimeout(5000);

    // Verify image is still there
    logger.info("Verifying image is ready for download...");

    targetImage = null;
    for (const selector of imageSelectors) {
      const images = await page.locator(selector).all();

      if (images.length > 0) {
        for (let i = images.length - 1; i >= 0; i--) {
          const img = images[i];

          try {
            const isVisible = await img
              .isVisible({ timeout: 1000 })
              .catch(() => false);

            if (!isVisible) continue;

            const box = await img.boundingBox();

            if (
              box &&
              box.width >= MIN_IMAGE_SIZE &&
              box.height >= MIN_IMAGE_SIZE
            ) {
              targetImage = img;
              logger.success(
                `Image verified: ${box.width}x${box.height} (selector: ${selector})`,
              );
              break;
            }
          } catch (e) {
            logger.debug(`Error verifying image ${i}: ${(e as Error).message}`);
          }
        }

        if (targetImage) break;
      }
    }

    if (!targetImage) {
      throw new Error(
        `Image disappeared after generation. This is unexpected - check the UI.`,
      );
    }

    // STEP 4: Download the image
    logger.info("Downloading generated image...");

    let imageSaved = false;

    // Strategy 1: Try download button (if available)
    try {
      logger.info("Strategy 1: Looking for download button...");

      // First, click on the image container (role="button") to open modal
      logger.info("  Clicking on image container to open modal...");

      // Find the clickable image container (div with role="button" that contains the image)
      const imageContainerSelectors = [
        'div[class*="imagegen-image"] div[role="button"]',
        'div[id^="image-"] div[role="button"]',
        '[data-testid="image-gen-overlay-actions"]',
      ];

      let imageContainer = null;
      for (const selector of imageContainerSelectors) {
        const container = page.locator(selector).first();
        const visible = await container
          .isVisible({ timeout: 1000 })
          .catch(() => false);

        if (visible) {
          imageContainer = container;
          logger.info(`  Found image container: ${selector}`);
          break;
        }
      }

      if (!imageContainer) {
        // Fallback: click directly on the image
        logger.info(
          "  Image container not found, clicking directly on image...",
        );
        await targetImage.scrollIntoViewIfNeeded();
        await targetImage.click();
      } else {
        await imageContainer.scrollIntoViewIfNeeded();
        await imageContainer.click();
      }

      await page.waitForTimeout(2000); // Wait for modal to appear

      // ChatGPT/DALL-E download button selectors in modal
      // Modal shows buttons: Kopiuj Ĺ‚Ä…cze, X, LinkedIn, Reddit, Pobierz
      const downloadButtonSelectors = [
        'button[aria-label="Pobierz"]', // Polish UI - exact match
        'button[aria-label="Download"]', // English UI - exact match
        'button[aria-label*="Pobierz"]', // Polish UI - partial match
        'button[aria-label*="Download"]', // English UI - partial match
        'button:has-text("Pobierz")', // Polish UI - text fallback
        'button:has-text("Download")', // English UI - text fallback
        'button div:has-text("Pobierz")', // Button with nested div
        'button div:has-text("Download")', // Button with nested div
      ];

      let downloadBtn = null;
      for (const sel of downloadButtonSelectors) {
        const btn = page.locator(sel).first();
        const visible = await btn
          .isVisible({ timeout: 1500 })
          .catch(() => false);

        if (visible) {
          downloadBtn = btn;
          logger.info(`  Download button found: ${sel}`);
          break;
        }
      }

      if (downloadBtn) {
        logger.info("  Clicking download button...");
        const downloadPromise = page.waitForEvent("download", {
          timeout: 30000,
        });
        // Force click even if element is obscured by sidebar
        await downloadBtn.scrollIntoViewIfNeeded();
        await downloadBtn.click({ force: true });
        const download = await downloadPromise;

        logger.info(`  Download started: ${download.suggestedFilename()}`);
        await download.saveAs(outputPath);
        logger.success(`Image saved via download button: ${outputPath}`);
        imageSaved = true;
      } else {
        logger.warn("  Download button not found - trying next strategy");
      }
    } catch (err) {
      logger.warn(`Strategy 1 failed: ${(err as Error).message}`);
    }

    // Strategy 2: Extract image from src attribute
    if (!imageSaved) {
      try {
        const src = await targetImage.getAttribute("src");

        if (src) {
          logger.debug(`Found image src: ${src.substring(0, 100)}...`);

          if (src.startsWith("http")) {
            logger.info("Strategy 2a: Downloading from URL...");
            const response = await page.request.get(src);
            const buffer = await response.body();
            fs.writeFileSync(outputPath, buffer);
            logger.success(`Image saved to: ${outputPath}`);
            imageSaved = true;
          } else if (src.startsWith("data:image")) {
            logger.info("Strategy 2b: Saving base64 image...");
            const base64Data = src.split(",")[1];
            const buffer = Buffer.from(base64Data, "base64");
            fs.writeFileSync(outputPath, buffer);
            logger.success(`Image saved to: ${outputPath}`);
            imageSaved = true;
          } else if (src.startsWith("blob:")) {
            logger.info("Strategy 2c: Extracting blob image...");
            const base64DataUrl: string = await page.evaluate(async blobUrl => {
              const resp = await fetch(blobUrl);
              const arr = await resp.arrayBuffer();
              const bytes = new Uint8Array(arr);
              let binary = "";
              bytes.forEach(b => {
                binary += String.fromCharCode(b);
              });
              return `data:image/png;base64,${btoa(binary)}`;
            }, src);

            const base64Data = base64DataUrl.split(",")[1];
            const buffer = Buffer.from(base64Data, "base64");
            fs.writeFileSync(outputPath, buffer);
            logger.success(`Image saved to: ${outputPath}`);
            imageSaved = true;
          }
        }
      } catch (err) {
        logger.warn(`Strategy 2 failed: ${(err as Error).message}`);
      }
    }

    // Strategy 3: Screenshot as fallback
    if (!imageSaved) {
      logger.warn("All strategies failed - using screenshot as fallback");
      await targetImage.screenshot({ path: outputPath });
      logger.success(`Image saved via screenshot: ${outputPath}`);
      imageSaved = true;
    }

    if (!imageSaved) {
      throw new Error("Failed to save image after all strategies");
    }

    logger.separator();
    logger.success("Image generation complete!");
    logger.info(`đź“ Saved to: ${outputPath}`);
    logger.separator();
  } catch (error) {
    logger.error("ChatGPT image generation failed", error as Error);
    throw error;
  } finally {
    if (context) {
      logger.info("Closing browser context");
      await closeBrowserContext(context, "ChatGPT browser context");
    }
  }
}

interface ImagePromptTask {
  sceneNumber: number | string;
  imagePrompt: string;
}

interface ImagePromptsFile {
  imagePrompts: ImagePromptTask[];
}

export interface GenerateImagesFromOutputOptions extends ChatGPTOptions {
  promptFilePath?: string;
  outputDir?: string;
  conversationUrlFilePath?: string;
  skipExisting?: boolean;
}

const CHATGPT_TEXTBOX_SELECTORS =
  [
    // Selectors from the working D:\siteGenerator implementation.
    'textarea#prompt-textarea',
    'textarea[placeholder*="Message"]',
    // Extra fallbacks for newer ChatGPT composer markup.
    'div#prompt-textarea[contenteditable="true"]',
    '[data-testid="composer-input"] textarea',
    '[data-testid="composer-input"] div[contenteditable="true"]',
    'form textarea[placeholder*="Message"]',
    'form div[contenteditable="true"][role="textbox"]',
    'div.ProseMirror[contenteditable="true"]',
    'div[contenteditable="true"][data-placeholder]',
    'div[contenteditable="true"][role="textbox"]',
    'textarea[placeholder*="Wiadomo"]',
    'textarea[placeholder*="Zapytaj"]',
    'div[contenteditable="true"]',
  ];

const CHATGPT_TEXTBOX_SELECTOR = CHATGPT_TEXTBOX_SELECTORS.join(", ");

const CHATGPT_SEND_BUTTON_SELECTORS = [
  // Selectors from the working D:\siteGenerator implementation.
  'button[data-testid="send-button"]',
  'button[aria-label*="Send"]',
  // Extra fallbacks for newer ChatGPT composer markup.
  'button[data-testid="composer-submit-button"]',
  'button[aria-label*="Submit"]',
  'button[aria-label*="prompt"]',
  'form button[type="submit"]',
  'button[type="submit"]',
];

const CHATGPT_IMAGE_SELECTORS = [
  'div[class*="imagegen-image"] img',
  'div[id^="image-"] img',
  '[data-message-author-role="assistant"] img',
  '[data-testid="conversation-turn-content"] img',
  'div[class*="markdown"] img',
  'img[src*="oaidalleapiprodscus"]',
  'img[src*="oaiusercontent"]',
  'img[src*="sdmnt"]',
  'img[src*="dalle"]',
  'img[alt*="dall"]',
  'img[alt*="Generated"]',
  'img[src*="backend-api/estuary"]',
  "article img",
  'img[src^="data:image"]',
  'img[src^="blob:"]',
];

function assertPageIsOpen(page: Page): void {
  if (page.isClosed()) {
    throw new Error(
      "ChatGPT browser window was closed. Stopping automation and cleaning up.",
    );
  }
}

async function findVisibleLocator(
  page: Page,
  selectors: string[],
  label: string,
  timeoutMs = 15000,
): Promise<{ locator: Locator; selector: string }> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    assertPageIsOpen(page);

    for (const selector of selectors) {
      const locator = page.locator(selector);
      const count = await locator.count().catch(() => 0);

      for (let i = count - 1; i >= 0; i--) {
        const candidate = locator.nth(i);
        const visible = await candidate
          .isVisible({ timeout: 300 })
          .catch(() => false);

        if (visible) {
          return { locator: candidate, selector };
        }
      }
    }

    await page.waitForTimeout(500);
  }

  throw new Error(`Could not find visible ${label} within ${timeoutMs}ms`);
}

async function findChatGptTextbox(
  page: Page,
  timeoutMs = 15000,
): Promise<Locator> {
  const { locator, selector } = await findVisibleLocator(
    page,
    CHATGPT_TEXTBOX_SELECTORS,
    "ChatGPT prompt input",
    timeoutMs,
  );

  logger.debug(`Using ChatGPT input selector: ${selector}`);
  return locator;
}

function normalizePromptText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function isPromptTextInserted(expected: string, actual: string): boolean {
  const expectedText = normalizePromptText(expected);
  const actualText = normalizePromptText(actual);

  if (!expectedText) {
    return true;
  }

  if (actualText === expectedText || actualText.includes(expectedText)) {
    return true;
  }

  const minLength = Math.max(
    1,
    Math.floor(
      expectedText.length < 120
        ? expectedText.length * 0.95
        : expectedText.length * 0.9,
    ),
  );

  return actualText.length >= minLength;
}

async function clearChatGptTextbox(page: Page, textbox: Locator): Promise<void> {
  const modifier = process.platform === "darwin" ? "Meta" : "Control";

  await textbox.click();
  await page.keyboard.press(`${modifier}+A`).catch(() => undefined);
  await page.keyboard.press("Backspace").catch(() => undefined);
  await page.waitForTimeout(200);
}

async function getPromptTextFromLocator(textbox: Locator): Promise<string> {
  return textbox.evaluate((el: any) => {
    if (el.tagName === "TEXTAREA") {
      return el.value || "";
    }

    return el.innerText || el.textContent || "";
  });
}

function loadImagePromptTasks(promptFilePath: string): ImagePromptTask[] {
  if (!fs.existsSync(promptFilePath)) {
    logger.info(`Image prompt file not found: ${promptFilePath}`);
    return [];
  }

  const raw = readJsonFile<ImagePromptsFile>(promptFilePath);

  if (!raw || !Array.isArray(raw.imagePrompts)) {
    throw new Error(
      `Invalid image prompts file. Expected { "imagePrompts": [...] } in ${promptFilePath}`,
    );
  }

  return raw.imagePrompts.map((task, index) => {
    if (
      task.sceneNumber === undefined ||
      task.sceneNumber === null ||
      !String(task.sceneNumber).trim()
    ) {
      throw new Error(`Missing sceneNumber for image prompt at index ${index}`);
    }

    if (!task.imagePrompt || !task.imagePrompt.trim()) {
      throw new Error(
        `Missing imagePrompt for scene "${String(task.sceneNumber)}"`,
      );
    }

    return task;
  });
}

async function ensureChatGptLoggedIn(page: Page): Promise<void> {
  logger.info("Checking ChatGPT login status...");

  const isLoggedIn = Boolean(
    await findChatGptTextbox(page, 5000).catch(() => null),
  );

  if (isLoggedIn) {
    logger.success("Already logged in to ChatGPT");
    return;
  }

  logger.warn("ChatGPT input is not visible yet.");
  logger.info("If the browser shows a login screen, log in there now.");
  logger.info("Waiting up to 10 minutes for the chat input...");

  await findChatGptTextbox(page, 10 * 60 * 1000);

  logger.success("ChatGPT input detected");
}

async function pastePromptIntoChatGpt(page: Page, prompt: string): Promise<void> {
  const textbox = await findChatGptTextbox(page, 15000);
  await textbox.scrollIntoViewIfNeeded();
  await textbox.click();
  await page.waitForTimeout(300);

  const modifier = process.platform === "darwin" ? "Meta" : "Control";

  logger.info("Trying ChatGPT input fill using working siteGenerator flow...");
  try {
    await clearChatGptTextbox(page, textbox);
    await textbox.fill(prompt);
    await page.waitForTimeout(700);
  } catch (error) {
    logger.warn(`Playwright fill failed: ${(error as Error).message}`);
  }

  let pastedText = await getPromptTextFromLocator(textbox).catch(() => "");

  if (isPromptTextInserted(prompt, pastedText)) {
    logger.success(`Prompt inserted (${pastedText.length} characters)`);
    return;
  }

  try {
    await clearChatGptTextbox(page, textbox);
    await page.evaluate(async (text: string) => {
      // @ts-ignore - this callback runs in the browser context.
      await window.navigator.clipboard.writeText(text);
    }, prompt);
    await page.keyboard.press(`${modifier}+V`);
    await page.waitForTimeout(700);
    pastedText = await getPromptTextFromLocator(textbox).catch(() => "");
  } catch (error) {
    logger.warn(`Clipboard paste failed: ${(error as Error).message}`);
  }

  if (!isPromptTextInserted(prompt, pastedText)) {
    logger.info("Trying direct keyboard insert...");
    await textbox.click();
    await clearChatGptTextbox(page, textbox);
    await page.keyboard.insertText(prompt);
    await page.waitForTimeout(700);
    pastedText = await getPromptTextFromLocator(textbox).catch(() => "");
  }

  if (!isPromptTextInserted(prompt, pastedText)) {
    logger.info("Trying DOM input fallback...");
    await textbox.evaluate((el: any, text: string) => {
      el.focus();

      if (el.tagName === "TEXTAREA") {
        el.value = text;
      } else {
        el.textContent = text;
      }

      const InputEventConstructor = (globalThis as any).InputEvent;
      const createInputEvent = (type: string) =>
        InputEventConstructor
          ? new InputEventConstructor(type, {
              bubbles: true,
              cancelable: true,
              data: text,
              inputType: "insertText",
            })
          : new Event(type, { bubbles: true, cancelable: true });

      el.dispatchEvent(createInputEvent("beforeinput"));
      el.dispatchEvent(createInputEvent("input"));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    }, prompt);
    await page.waitForTimeout(700);
    pastedText = await getPromptTextFromLocator(textbox).catch(() => "");
  }

  if (!isPromptTextInserted(prompt, pastedText)) {
    throw new Error(
      `Failed to type prompt into ChatGPT input. Typed ${pastedText.length}/${prompt.length} characters.`,
    );
  }

  logger.success(`Prompt inserted (${pastedText.length} characters)`);
}

async function submitChatGptPrompt(page: Page): Promise<void> {
  for (const selector of CHATGPT_SEND_BUTTON_SELECTORS) {
    const button = page.locator(selector).first();
    const visible = await button
      .isVisible({ timeout: 1500 })
      .catch(() => false);

    if (!visible) {
      continue;
    }

    const enabled = await button.isEnabled().catch(() => true);
    const ariaDisabled = await button
      .getAttribute("aria-disabled")
      .catch(() => null);

    if (enabled && ariaDisabled !== "true") {
      await button.click();
      return;
    }
  }

  await page.keyboard.press("Enter");
}
async function sendChatGptImagePrompt(page: Page, prompt: string): Promise<void> {
  await pastePromptIntoChatGpt(page, prompt);
  await submitChatGptPrompt(page);
  logger.info("Prompt sent. Waiting for generated image...");
}

interface LargeImageEntry {
  image: Locator;
  signature: string;
}

async function getLargeImageEntries(page: Page): Promise<LargeImageEntry[]> {
  const minImageSize = 200;
  const entries: LargeImageEntry[] = [];
  const seenSignatures = new Set<string>();

  for (const selector of CHATGPT_IMAGE_SELECTORS) {
    const images = await page.locator(selector).all();

    for (let i = images.length - 1; i >= 0; i--) {
      const image = images[i];
      const visible = await image.isVisible({ timeout: 500 }).catch(() => false);

      if (!visible) {
        continue;
      }

      const box = await image.boundingBox();

      if (box && box.width >= minImageSize && box.height >= minImageSize) {
        const signature = await image
          .evaluate((el: any) => {
            const src = el.currentSrc || el.src || "";
            const alt = el.alt || "";
            const width = Math.round(el.naturalWidth || el.width || 0);
            const height = Math.round(el.naturalHeight || el.height || 0);

            return [src, alt, width, height].join("|");
          })
          .catch(
            () =>
              `${selector}|${i}|${Math.round(box.width)}x${Math.round(box.height)}`,
          );

        if (!seenSignatures.has(signature)) {
          seenSignatures.add(signature);
          entries.push({ image, signature });
        }
      }
    }
  }

  return entries;
}

async function findLatestLargeImage(page: Page): Promise<Locator | null> {
  const [entry] = await getLargeImageEntries(page);
  return entry?.image || null;
}

async function collectLargeImageSignatures(page: Page): Promise<Set<string>> {
  return new Set(
    (await getLargeImageEntries(page)).map(entry => entry.signature),
  );
}

async function waitForLatestChatGptImage(
  page: Page,
  timeout: number,
  previousImageSignatures = new Set<string>(),
): Promise<Locator> {
  const maxWaitSeconds = Math.ceil(timeout / 1000);
  let waitedSeconds = 0;

  while (waitedSeconds < maxWaitSeconds) {
    assertPageIsOpen(page);

    const [entry] = (await getLargeImageEntries(page)).filter(
      imageEntry => !previousImageSignatures.has(imageEntry.signature),
    );

    if (entry) {
      logger.success("Generated image appeared");
      return entry.image;
    }

    await page.waitForTimeout(2000);
    waitedSeconds += 2;

    if (waitedSeconds % 10 === 0) {
      logger.info(`Waiting for image... ${waitedSeconds}s / ${maxWaitSeconds}s`);
    }
  }

  throw new Error(`Image did not appear within ${maxWaitSeconds}s`);
}

async function waitForChatGptGenerationToFinish(page: Page): Promise<void> {
  const stopButtonSelectors = [
    'button[aria-label*="Stop"]',
    'button:has-text("Stop generating")',
    'button[data-testid*="stop"]',
  ];

  for (let i = 0; i < 90; i++) {
    let isGenerating = false;

    for (const selector of stopButtonSelectors) {
      const visible = await page
        .locator(selector)
        .first()
        .isVisible({ timeout: 500 })
        .catch(() => false);

      if (visible) {
        isGenerating = true;
        break;
      }
    }

    if (!isGenerating) {
      await page.waitForTimeout(5000);
      return;
    }

    await page.waitForTimeout(1000);
  }

  logger.warn("Generation completion wait timed out; trying to save image anyway");
}

async function saveChatGptImageFromElement(
  page: Page,
  targetImage: any,
  outputPath: string,
): Promise<void> {
  ensureDirectoryExists(outputPath);
  let openedImageDialog = false;

  try {
    await targetImage.scrollIntoViewIfNeeded();
    await targetImage.click();
    openedImageDialog = true;
    await page.waitForTimeout(2000);

    const downloadButtonSelectors = [
      'button[aria-label="Pobierz"]',
      'button[aria-label="Download"]',
      'button[aria-label*="Pobierz"]',
      'button[aria-label*="Download"]',
      'button:has-text("Pobierz")',
      'button:has-text("Download")',
    ];

    for (const selector of downloadButtonSelectors) {
      const button = page.locator(selector).first();
      const visible = await button
        .isVisible({ timeout: 1200 })
        .catch(() => false);

      if (!visible) {
        continue;
      }

      const downloadPromise = page.waitForEvent("download", {
        timeout: 30000,
      });
      await button.click({ force: true });
      const download = await downloadPromise;
      await download.saveAs(outputPath);
      logger.success(`Image saved: ${outputPath}`);
      await page.keyboard.press("Escape").catch(() => undefined);
      return;
    }
  } catch (error) {
    logger.warn(`Native download failed: ${(error as Error).message}`);
  } finally {
    if (openedImageDialog) {
      await page.keyboard.press("Escape").catch(() => undefined);
      await page.waitForTimeout(500).catch(() => undefined);
    }
  }

  const src = await targetImage.getAttribute("src");

  if (src?.startsWith("http")) {
    const response = await page.request.get(src);
    fs.writeFileSync(outputPath, await response.body());
    logger.success(`Image saved from URL: ${outputPath}`);
    return;
  }

  if (src?.startsWith("data:image")) {
    fs.writeFileSync(outputPath, Buffer.from(src.split(",")[1], "base64"));
    logger.success(`Image saved from data URL: ${outputPath}`);
    return;
  }

  if (src?.startsWith("blob:")) {
    const base64DataUrl: string = await page.evaluate(async blobUrl => {
      const response = await fetch(blobUrl);
      const arrayBuffer = await response.arrayBuffer();
      const bytes = new Uint8Array(arrayBuffer);
      let binary = "";
      bytes.forEach(byte => {
        binary += String.fromCharCode(byte);
      });
      return `data:image/png;base64,${btoa(binary)}`;
    }, src);

    fs.writeFileSync(
      outputPath,
      Buffer.from(base64DataUrl.split(",")[1], "base64"),
    );
    logger.success(`Image saved from blob: ${outputPath}`);
    return;
  }

  await targetImage.screenshot({ path: outputPath });
  logger.success(`Image saved from screenshot fallback: ${outputPath}`);
}

function getChatGptConversationUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    const isChatGptHost =
      parsed.hostname === "chatgpt.com" || parsed.hostname === "chat.openai.com";

    if (!isChatGptHost || !parsed.pathname.startsWith("/c/")) {
      return null;
    }

    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return null;
  }
}

function readSavedConversationUrl(filePath: string): string | null {
  if (!fs.existsSync(filePath)) {
    return null;
  }

  const rawUrl = fs.readFileSync(filePath, "utf8").trim();
  const conversationUrl = getChatGptConversationUrl(rawUrl);

  if (!conversationUrl) {
    logger.warn(`Saved ChatGPT conversation URL is invalid: ${filePath}`);
    return null;
  }

  return conversationUrl;
}

function saveCurrentConversationUrl(
  page: Page,
  filePath: string,
  stageName: string,
): void {
  const conversationUrl = getChatGptConversationUrl(page.url());

  if (!conversationUrl) {
    logger.debug(`No ChatGPT conversation URL available yet for ${stageName}`);
    return;
  }

  ensureDirectoryExists(filePath);
  fs.writeFileSync(filePath, `${conversationUrl}\n`, "utf8");
  logger.info(`Saved ChatGPT conversation URL: ${filePath}`);
}

async function navigateToSavedChatGptConversation(
  context: BrowserContext,
  page: Page,
  conversationUrl: string,
): Promise<Page> {
  logger.info(`Opening saved ChatGPT conversation: ${conversationUrl}`);
  await page.goto(conversationUrl, { waitUntil: "domcontentloaded" });
  await sleep(3000);

  if (page.isClosed()) {
    logger.warn("Browser tab closed after opening saved conversation, recovering...");
    page = recoverActivePage(context);
  }

  logger.success("Saved ChatGPT conversation loaded");
  return page;
}

function hasExistingOutputFile(filePath: string): boolean {
  if (!fs.existsSync(filePath)) {
    return false;
  }

  const stats = fs.statSync(filePath);
  return stats.isFile() && stats.size > 0;
}

export async function generateImagesFromOutputFile(
  options: GenerateImagesFromOutputOptions = {},
): Promise<void> {
  const {
    headless = false,
    timeout = 300000,
    userDataDir = paths.chatgptProfile,
    throttleStep = "graphics",
    promptFilePath = path.join(paths.output, "image-prompts.json"),
    outputDir = path.join(paths.output, "images"),
    conversationUrlFilePath = path.join(
      paths.output,
      "chatgpt-images-chat-url.txt",
    ),
    skipExisting = true,
  } = options;

  ensureDir(outputDir);

  const tasks = loadImagePromptTasks(promptFilePath);

  if (tasks.length === 0) {
    logger.info("No image prompts to process.");
    return;
  }

  ensureBrowserProfileExists(userDataDir);

  await throttleBrowserLaunch(throttleStep, "chatgpt");

  logger.info(`Opening ChatGPT browser context: ${userDataDir}`);
  const context = await launchPersistentBrowserContext(userDataDir, {
    headless,
    allowHeadlessFallback: true,
    viewport: { width: 1280, height: 720 },
    acceptDownloads: true,
    args: ["--disable-blink-features=AutomationControlled"],
  });

  try {
    let page = await getOrCreateAutomationPage(context);
    page = await navigateToChatGptHome(context, page);
    await ensureChatGptLoggedIn(page);

    const savedConversationUrl = readSavedConversationUrl(
      conversationUrlFilePath,
    );

    if (savedConversationUrl) {
      page = await navigateToSavedChatGptConversation(
        context,
        page,
        savedConversationUrl,
      );
      await ensureChatGptLoggedIn(page);
    }

    saveCurrentConversationUrl(
      page,
      conversationUrlFilePath,
      "image generation startup",
    );

    logger.info(`Loaded ${tasks.length} image prompts from ${promptFilePath}`);

    for (const [index, task] of tasks.entries()) {
      const sceneNumber = String(task.sceneNumber).trim();
      const outputPath = path.join(outputDir, `${sceneNumber}.png`);

      if (skipExisting && hasExistingOutputFile(outputPath)) {
        logger.info(
          `Skipping scene ${sceneNumber}; output already exists: ${outputPath}`,
        );
        continue;
      }

      const descriptivePrompt = sanitizeImagePrompt(task.imagePrompt);
      const executionPrompt = buildChatGPTImagePrompt(descriptivePrompt);

      logger.separator();
      logger.info(
        `Generating scene ${sceneNumber} (${index + 1}/${tasks.length})`,
      );

      const previousImageSignatures = await collectLargeImageSignatures(page);
      await sendChatGptImagePrompt(page, executionPrompt);
      saveCurrentConversationUrl(
        page,
        conversationUrlFilePath,
        `image scene ${sceneNumber}`,
      );
      await detectAndCloseModals(page, `image scene ${sceneNumber}`);

      let image = await waitForLatestChatGptImage(
        page,
        timeout,
        previousImageSignatures,
      );
      await waitForChatGptGenerationToFinish(page);
      image = (await findLatestLargeImage(page)) || image;
      await saveChatGptImageFromElement(page, image, outputPath);
      saveCurrentConversationUrl(
        page,
        conversationUrlFilePath,
        `image scene ${sceneNumber}`,
      );

      logger.info("Waiting 3 seconds before next prompt...");
      await sleep(3000);
    }

    logger.separator();
    logger.success(`All images generated in ${outputDir}`);
  } finally {
    logger.info("Closing ChatGPT browser context");
    await closeBrowserContext(context, "ChatGPT browser context");
  }
}
