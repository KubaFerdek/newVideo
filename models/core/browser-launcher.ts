import { chromium, type BrowserContext } from "playwright";
import { logger } from "./logger.js";
import { trackBrowserContext } from "./browser-cleanup.js";

type LaunchOptions = NonNullable<
  Parameters<typeof chromium.launchPersistentContext>[1]
>;

export type PersistentBrowserLaunchOptions = LaunchOptions & {
  allowHeadlessFallback?: boolean;
};

const stableChromiumArgs = [
  "--disable-crash-reporter",
  "--disable-crashpad",
  "--disable-features=Crashpad",
];

const windowsBrowserChannels = ["chrome", "msedge"] as const;

function withStableArgs(
  options: PersistentBrowserLaunchOptions,
): PersistentBrowserLaunchOptions {
  const args = new Set([...(options.args ?? []), ...stableChromiumArgs]);

  return {
    ...options,
    args: [...args],
  };
}

function isMissingChromeError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);

  return (
    message.includes("Chromium distribution 'chrome' is not found") ||
    message.includes("Chromium distribution 'msedge' is not found") ||
    message.includes("chrome is not found") ||
    message.includes("msedge is not found")
  );
}

async function launchPlaywrightChromium(
  userDataDir: string,
  options: PersistentBrowserLaunchOptions,
): Promise<BrowserContext> {
  const {
    allowHeadlessFallback,
    channel: _channel,
    ...fallbackOptions
  } = options as PersistentBrowserLaunchOptions & {
    channel?: string;
  };

  void allowHeadlessFallback;

  return trackBrowserContext(
    await chromium.launchPersistentContext(userDataDir, fallbackOptions),
  );
}

async function launchWindowsChromeOrEdge(
  userDataDir: string,
  options: PersistentBrowserLaunchOptions,
): Promise<BrowserContext> {
  const { allowHeadlessFallback: _allowHeadlessFallback, ...chromeOptions } =
    options;

  for (const channel of windowsBrowserChannels) {
    try {
      logger.info(`Opening Windows browser channel: ${channel}`);
      return trackBrowserContext(
        await chromium.launchPersistentContext(userDataDir, {
          ...chromeOptions,
          channel,
        }),
      );
    } catch (error) {
      if (!isMissingChromeError(error)) {
        throw error;
      }
    }
  }

  logger.warn(
    "Google Chrome or Microsoft Edge was not found; falling back to Playwright Chromium.",
  );

  return launchPlaywrightChromium(userDataDir, options);
}

export async function launchPersistentBrowserContext(
  userDataDir: string,
  options: PersistentBrowserLaunchOptions,
): Promise<BrowserContext> {
  if (process.platform !== "win32") {
    throw new Error(
      "GPT browser automation in this project is Windows-only. Run it from Windows PowerShell.",
    );
  }

  const launchOptions = withStableArgs(options);

  return launchWindowsChromeOrEdge(userDataDir, launchOptions);
}
