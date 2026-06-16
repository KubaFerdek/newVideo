import { logger } from "./core/logger.js";
import { generateImagesFromOutputFile } from "./chatgpt-browser.js";

async function main(): Promise<void> {
  logger.info("Starting ChatGPT image generation in one Windows browser session...");
  await generateImagesFromOutputFile();
}

main().catch(error => {
  logger.error("ChatGPT image generation failed", error);
  process.exit(1);
});
