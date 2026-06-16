import { type BrowserContext } from "playwright";
import { logger } from "./logger.js";

const trackedContexts = new Set<BrowserContext>();
let handlersInstalled = false;
let cleanupPromise: Promise<void> | null = null;

function closeTimeout(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function closeWithTimeout(
  context: BrowserContext,
  label: string,
): Promise<void> {
  await Promise.race([
    context.close(),
    closeTimeout(10000).then(() => {
      throw new Error(`${label} close timed out after 10s`);
    }),
  ]);
}

export function trackBrowserContext(context: BrowserContext): BrowserContext {
  trackedContexts.add(context);
  context.once("close", () => {
    trackedContexts.delete(context);
  });
  installBrowserCleanupHandlers();

  return context;
}

export async function closeBrowserContext(
  context: BrowserContext | null | undefined,
  label = "browser context",
): Promise<void> {
  if (!context) {
    return;
  }

  trackedContexts.delete(context);

  try {
    await closeWithTimeout(context, label);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    if (
      message.includes("Target page, context or browser") ||
      message.includes("has been closed")
    ) {
      return;
    }

    logger.warn(`Could not close ${label}: ${message}`);
  }
}

export async function closeTrackedBrowserContexts(): Promise<void> {
  if (cleanupPromise) {
    return cleanupPromise;
  }

  cleanupPromise = (async () => {
    const contexts = [...trackedContexts];
    trackedContexts.clear();

    await Promise.all(
      contexts.map(context => closeBrowserContext(context, "tracked browser")),
    );
  })().finally(() => {
    cleanupPromise = null;
  });

  return cleanupPromise;
}

function exitCodeForSignal(signal: NodeJS.Signals): number {
  return signal === "SIGINT" ? 130 : 143;
}

export function installBrowserCleanupHandlers(): void {
  if (handlersInstalled) {
    return;
  }

  handlersInstalled = true;

  const handleSignal = (signal: NodeJS.Signals) => {
    logger.warn(`Received ${signal}. Closing browser automation...`);

    void closeTrackedBrowserContexts().finally(() => {
      process.exit(exitCodeForSignal(signal));
    });
  };

  process.once("SIGINT", handleSignal);
  process.once("SIGTERM", handleSignal);
}
