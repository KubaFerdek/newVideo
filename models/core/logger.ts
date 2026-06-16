function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.stack || error.message;
  }

  return String(error);
}

export const logger = {
  debug(message: string): void {
    if (process.env.DEBUG) {
      console.debug(`[debug] ${message}`);
    }
  },
  info(message: string): void {
    console.log(message);
  },
  warn(message: string): void {
    console.warn(message);
  },
  error(message: string, error?: unknown): void {
    console.error(message);
    if (error) {
      console.error(formatError(error));
    }
  },
  success(message: string): void {
    console.log(message);
  },
  separator(): void {
    console.log("=".repeat(72));
  },
};
