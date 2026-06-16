import fs from "fs";

export function ensureDir(dirPath: string): void {
  fs.mkdirSync(dirPath, { recursive: true });
}

export function ensureBrowserProfileExists(userDataDir: string): {
  isFirstRun: boolean;
} {
  const isFirstRun = !fs.existsSync(userDataDir);
  ensureDir(userDataDir);

  return { isFirstRun };
}

export function readJsonFile<T = unknown>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
}
