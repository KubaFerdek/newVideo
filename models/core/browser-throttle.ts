export type BrowserThrottleStep = "default" | "graphics";

const throttleDelays: Record<BrowserThrottleStep, number> = {
  default: 1000,
  graphics: 3000,
};

export async function throttleBrowserLaunch(
  step: BrowserThrottleStep = "default",
  label = "browser",
): Promise<void> {
  const delay = throttleDelays[step] ?? throttleDelays.default;

  if (delay > 0) {
    console.log(`Waiting ${delay / 1000}s before launching ${label}...`);
    await new Promise(resolve => setTimeout(resolve, delay));
  }
}
