import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const rootDir = path.resolve(__dirname, "..");
const projectRoot = path.resolve(rootDir, "..");

export const paths = {
  root: rootDir,
  projectRoot,
  output: path.join(projectRoot, "output"),
  browserProfiles: {
    root: path.join(rootDir, "browser-profiles"),
    chatgpt: path.join(rootDir, "browser-profiles", "chatgpt"),
    gemini: path.join(rootDir, "browser-profiles", "gemini"),
  },
  // Legacy compatibility
  chatgptProfile: path.join(rootDir, "browser-profiles", "chatgpt"),
  geminiProfile: path.join(rootDir, "browser-profiles", "gemini"),
} as const;

export type Paths = typeof paths;
