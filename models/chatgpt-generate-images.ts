import { generateImagesFromOutputFile } from "./chatgpt-browser.js";

generateImagesFromOutputFile().catch(error => {
  console.error(error);
  process.exit(1);
});
