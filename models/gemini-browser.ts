import { launchPersistentBrowserContext } from "./core/browser-launcher.js";
import fs from "fs";
import path from "path";
import { logger } from "./core/logger.js";
import {
  ensureDir,
  ensureBrowserProfileExists,
} from "./core/file-utils.js";
import { paths } from "./config/paths.js";
import {
  throttleBrowserLaunch,
  type BrowserThrottleStep,
} from "./core/browser-throttle.js";

/**
 * Gemini Browser Automation Service for Image Generation
 *
 * Real implementation using Playwright browser automation.
 * Launches a persistent browser context with saved Google/Gemini session,
 * sends image prompts, and downloads generated images.
 */

export interface ImageGenerationParams {
  prompt: string;
  outputPath: string;
  width?: number;
  height?: number;
  style?: "realistic" | "artistic" | "minimalist" | "technical";
}

export interface GeminiOptions {
  headless?: boolean;
  timeout?: number;
  userDataDir?: string;
  throttleStep?: BrowserThrottleStep;
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
        logger.info(`Retrying in ${options.retryDelay / 1000}s...`);
        await new Promise(resolve => setTimeout(resolve, options.retryDelay));
      }
    }
  }

  throw lastError!;
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

export function buildGeminiExecutionPrompt(prompt: string): string {
  const descriptivePrompt = prompt.trim();

  return [
    "Generate the requested image from the description below.",
    "Output must be IMAGE ONLY.",
    "Do not return text, markdown, JSON, code fences, captions, explanations, or help.",
    "Do not ask questions or provide alternatives.",
    "If the output is anything other than an image, it is invalid.",
    "",
    "Image description:",
    descriptivePrompt,
  ].join("\n");
}

/**
 * Generates an image using Gemini via browser automation
 *
 * @param params - Generation parameters including prompt and output path
 * @param options - Optional browser configuration
 * @returns Promise that resolves when image is saved
 */
export async function generateImageInBrowser(
  params: ImageGenerationParams,
  options: GeminiOptions = {},
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
    userDataDir = paths.geminiProfile,
    throttleStep = "graphics",
  } = options;

  logger.info("đźŽ¨ Launching Gemini browser automation");
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
    logger.warn("âš ď¸Ź  You will need to log in to Google/Gemini manually");
    logger.info("   Your session will be saved for future runs");
    logger.separator();
  } else {
    logger.debug(`Using existing browser profile: ${userDataDir}`);
  }

  let context;

  try {
    // Ensure output directory exists
    ensureDirectoryExists(outputPath);

    await throttleBrowserLaunch(throttleStep, "gemini");

    // Launch persistent browser context with saved session
    logger.info(`Opening browser context: ${userDataDir}`);
    context = await launchPersistentBrowserContext(userDataDir, {
      headless,
      allowHeadlessFallback: true,
      viewport: { width: 1280, height: 720 },
      acceptDownloads: true,
      args: ["--disable-blink-features=AutomationControlled"],
    });

    const page = context.pages()[0] || (await context.newPage());

    // Navigate to Gemini
    logger.info("Navigating to https://gemini.google.com/");
    await page.goto("https://gemini.google.com/", {
      waitUntil: "domcontentloaded",
    });
    await page.waitForTimeout(3000);

    logger.success("Gemini page loaded");

    // Check if user is logged in
    // Gemini requires Google login - check for textarea or prompt input
    logger.info("đź” Checking login status...");

    const inputSelectors = [
      'textarea[placeholder*="Enter a prompt"]',
      'textarea[aria-label*="prompt"]',
      'div[contenteditable="true"][role="textbox"]',
      "textarea.ql-editor",
      "rich-textarea",
    ];

    let isLoggedIn = false;
    let inputSelector = "";

    for (const selector of inputSelectors) {
      const visible = await page
        .locator(selector)
        .first()
        .isVisible({ timeout: 3000 })
        .catch(() => false);

      if (visible) {
        isLoggedIn = true;
        inputSelector = selector;
        break;
      }
    }

    if (!isLoggedIn) {
      logger.separator();
      logger.error("NOT LOGGED IN TO GEMINI!");
      logger.separator();
      logger.info("You need to log in to Google/Gemini first.");
      logger.info("");
      logger.info("đź”‘ RUN THE LOGIN FLOW:");
      logger.info("");
      logger.info("  pnpm run gemini:login");
      logger.info("");
      logger.info("This will:");
      logger.info("  1. Open Chrome browser");
      logger.info("  2. Navigate to Gemini");
      logger.info("  3. Let you log in manually");
      logger.info("  4. Save your session for future runs");
      logger.info("");
      logger.info("After login, run your pipeline again.");
      logger.separator();

      throw new Error(
        "Not logged in to Gemini. Run 'pnpm run gemini:login' first.",
      );
    }

    logger.success("Already logged in to Gemini");

    // Content stores only the descriptive image prompt.
    // Runtime adds Gemini-specific execution instructions right before submission.
    const descriptivePrompt = sanitizeImagePrompt(prompt);

    if (!descriptivePrompt) {
      throw new Error("Image prompt is empty after sanitization");
    }

    const executionPrompt = buildGeminiExecutionPrompt(descriptivePrompt);

    // Fill prompt input with retry
    logger.info("Sending image generation prompt to Gemini");
    await withRetry(
      async () => {
        const input = page.locator(inputSelector).first();
        await input.click();
        await input.fill(executionPrompt);
        await page.waitForTimeout(500);
      },
      {
        retries: 3,
        retryDelay: 2000,
        taskName: "Fill prompt input",
      },
    );

    logger.success("Prompt filled");

    // Submit prompt (Enter key or button)
    logger.info("Submitting prompt...");
    await withRetry(
      async () => {
        // Try Enter key first
        await page.keyboard.press("Enter");
        await page.waitForTimeout(1000);

        // Alternatively, look for submit button
        const submitButtons = [
          'button[aria-label*="Send"]',
          'button[type="submit"]',
          'button:has-text("Generate")',
        ];

        for (const btnSelector of submitButtons) {
          const btn = page.locator(btnSelector).first();
          const visible = await btn
            .isVisible({ timeout: 1000 })
            .catch(() => false);
          if (visible) {
            await btn.click();
            break;
          }
        }
      },
      {
        retries: 2,
        retryDelay: 2000,
        taskName: "Submit prompt",
      },
    );

    logger.success("Prompt submitted");

    // STEP 1: Wait for image to APPEAR (not just check if exists, but actively wait)
    logger.info("STEP 1: Waiting for image to appear...");
    logger.info(`This can take 30-60 seconds for image generation`);
    logger.info(`(max ${timeout / 1000}s)`);

    const imageSelectors = [
      "article img", // Images inside article/response containers (FIRST - most specific)
      'img[src*="googleusercontent"]', // Google's CDN
      'img[src*="google.com"]', // Google domains
      'img[src^="data:image"]', // Base64 images
      'img[src^="blob:"]', // Blob URLs
      'div[data-test-id*="image"] img', // Test ID patterns
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

    // STEP 2: Image appeared, now wait for generation to COMPLETE
    logger.info(
      "STEP 2: Image appeared, waiting for generation to complete...",
    );
    logger.info("   Monitoring for completion indicators...");

    // Reset timer for completion check
    let completionWaitTime = 0;
    const maxCompletionWait = 60; // 60 seconds max to complete after image appears
    let isGenerating = true;

    // Selectors that indicate generation is still in progress
    const generatingIndicators = [
      'div[aria-label*="Generating"]',
      'div[aria-label*="Loading"]',
      'button[aria-label*="Stop"]',
      'button:has-text("Stop generating")',
      'div:has-text("Generating")',
      ".generating",
      '[data-test-id*="generating"]',
      "div.spinner",
      'div[role="progressbar"]',
      'div[class*="loading"]',
      'div[class*="spinner"]',
    ];

    // Wait for all generating indicators to disappear
    while (isGenerating && completionWaitTime < maxCompletionWait) {
      let foundIndicator = false;

      // Check if any generating indicator is still visible
      for (const selector of generatingIndicators) {
        try {
          const indicator = page.locator(selector).first();
          const isVisible = await indicator
            .isVisible({ timeout: 500 })
            .catch(() => false);

          if (isVisible) {
            foundIndicator = true;
            logger.debug(`Still generating (found indicator: ${selector})`);
            break;
          }
        } catch (e) {
          // Selector not found or error - continue
        }
      }

      if (!foundIndicator) {
        // No generating indicators visible - generation likely complete
        logger.success(
          "No generating indicators found - generation appears complete!",
        );
        isGenerating = false;
        break;
      }

      // Wait and check again
      await page.waitForTimeout(1000);
      completionWaitTime++;

      // Progress update every 5 seconds
      if (completionWaitTime % 5 === 0) {
        logger.info(`   Still generating... ${completionWaitTime}s`);
      }
    }

    if (completionWaitTime >= maxCompletionWait) {
      logger.warn(
        `Completion wait timeout (${maxCompletionWait}s) - proceeding anyway`,
      );
    }

    // STEP 3: Wait for final rendering and image stabilization
    logger.info("STEP 3: Waiting for image to stabilize...");
    await page.waitForTimeout(5000); // 5 seconds for final rendering

    // Verify image is still there and get final reference
    logger.info("Verifying image is ready for download...");

    targetImage = null;
    for (const selector of imageSelectors) {
      const images = await page.locator(selector).all();

      if (images.length > 0) {
        // Check images from newest to oldest (reverse order)
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

    // Download/save the generated image
    logger.info("Downloading generated image...");

    let imageSaved = false;

    // â”€â”€ Strategy 1: Gemini native download button (highest quality, full size) â”€â”€
    // Hover over the image â†’ "Pobierz w peĹ‚nym rozmiarze" button appears â†’
    // use Playwright download event to capture the file.
    try {
      logger.info("Strategy 1: Hovering to reveal Gemini download button...");
      await targetImage.scrollIntoViewIfNeeded();
      await targetImage.hover();
      await page.waitForTimeout(800); // give hover buttons time to appear

      // Selectors for the download button (Gemini UI, may vary by locale).
      // From DevTools: single-image.generated-image .generated-image-button
      //                mat-icon[fonticon="download"]
      const downloadButtonSelectors = [
        'single-image.generated-image button[aria-label*="Download"]',
        'single-image.generated-image button[aria-label*="Pobierz"]',
        'button[aria-label*="Download in full"]',
        'button[aria-label*="Pobierz w peĹ‚nym"]',
        'single-image.generated-image button:has(mat-icon[fonticon="download"])',
        '.generated-image-button button:has(mat-icon[fonticon="download"])',
        // last button in the action row is always download
        "single-image.generated-image .generated-image-button:last-of-type button",
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
        logger.info("  Clicking download button and waiting for file...");
        const downloadPromise = page.waitForEvent("download", {
          timeout: 30000,
        });
        await downloadBtn.click();
        const download = await downloadPromise;

        logger.info(`  Download started: ${download.suggestedFilename()}`);
        await download.saveAs(outputPath);
        logger.success(`Image saved via native download button: ${outputPath}`);
        imageSaved = true;
      } else {
        logger.warn("  Download button not found â€” trying next strategy");
      }
    } catch (err) {
      logger.warn(`Strategy 1 failed: ${(err as Error).message}`);
    }

    // â”€â”€ Strategy 2: Get image src and download / extract â”€â”€
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
            // Blob URL â€” must be fetched inside the browser context (same-origin)
            logger.info(
              "Strategy 2c: Extracting blob image data via page.evaluate()...",
            );
            try {
              const base64DataUrl: string = await page.evaluate(
                async blobUrl => {
                  const resp = await fetch(blobUrl);
                  const arr = await resp.arrayBuffer();
                  const bytes = new Uint8Array(arr);
                  let binary = "";
                  bytes.forEach(b => {
                    binary += String.fromCharCode(b);
                  });
                  return "data:image/png;base64," + btoa(binary);
                },
                src,
              );

              const base64Data = base64DataUrl.split(",")[1];
              if (!base64Data) throw new Error("Empty base64 data from blob");

              const buffer = Buffer.from(base64Data, "base64");
              fs.writeFileSync(outputPath, buffer);
              logger.success(`Blob image saved to: ${outputPath}`);
              imageSaved = true;
            } catch (blobErr) {
              logger.warn(
                `Blob extraction failed: ${(blobErr as Error).message}`,
              );
            }
          }
        }
      } catch (err) {
        logger.debug(`Strategy 2 failed: ${(err as Error).message}`);
      }
    }

    // â”€â”€ Strategy 3: Clipped page screenshot (last resort) â”€â”€
    if (!imageSaved) {
      logger.warn("âš ď¸Ź  Falling back to screenshot strategy");
      try {
        await targetImage.scrollIntoViewIfNeeded();
        await page.waitForTimeout(800);
        const box = await targetImage.boundingBox();

        if (box && box.width > 10 && box.height > 10) {
          logger.info(
            `Taking clipped screenshot (${Math.round(box.width)}x${Math.round(box.height)})...`,
          );
          await page.screenshot({
            path: outputPath,
            type: "png",
            clip: { x: box.x, y: box.y, width: box.width, height: box.height },
          });
          logger.success(`Clipped screenshot saved to: ${outputPath}`);
          imageSaved = true;
        } else {
          await targetImage.screenshot({ path: outputPath, type: "png" });
          logger.success(`Element screenshot saved to: ${outputPath}`);
          imageSaved = true;
        }
      } catch (err) {
        logger.error(`Screenshot failed: ${(err as Error).message}`);
      }
    }

    if (!imageSaved) {
      throw new Error(
        "Failed to save image. Could not download or screenshot the generated image.",
      );
    }

    // Verify file was saved
    if (!fs.existsSync(outputPath)) {
      throw new Error(`Image file was not created at: ${outputPath}`);
    }

    const stats = fs.statSync(outputPath);
    const fileSizeKB = (stats.size / 1024).toFixed(2);
    const fileSizeBytes = stats.size;

    // Validate image size to ensure it's not an avatar/icon
    const MIN_FILE_SIZE = 10 * 1024; // 10 KB minimum (avatars are usually < 5KB)

    if (fileSizeBytes < MIN_FILE_SIZE) {
      logger.error(
        `Downloaded image is too small (${fileSizeKB} KB) - likely an avatar or icon`,
      );
      logger.error("Deleting invalid file...");
      fs.unlinkSync(outputPath);
      throw new Error(
        `Downloaded file is too small (${fileSizeKB} KB, minimum ${(MIN_FILE_SIZE / 1024).toFixed(0)} KB). This is likely an avatar or icon, not a generated image. Check image selectors.`,
      );
    }

    logger.success("Image generation completed!");
    logger.info(`   File: ${outputPath}`);
    logger.info(`   Size: ${fileSizeKB} KB`);
    logger.info(
      `   Size validation passed (> ${(MIN_FILE_SIZE / 1024).toFixed(0)} KB)`,
    );
  } catch (error) {
    logger.error("Gemini automation failed", error as Error);

    // Provide helpful error messages
    if ((error as Error).message.includes("Target page, context or browser")) {
      throw new Error(
        "Browser context was closed unexpectedly. Please check if you're logged in to Gemini.",
      );
    }

    if ((error as Error).message.includes("timeout")) {
      throw new Error(
        `Gemini did not generate image within ${timeout}ms. Try increasing the timeout or check your internet connection.`,
      );
    }

    throw error;
  } finally {
    // Close browser context
    if (context) {
      logger.info("Closing browser context");
      await context.close();
    }
  }
}
