import { spawn } from "child_process";
import { logger } from "./logger.js";

export const defaultCdpPort = process.env.CHATGPT_CDP_PORT || "9222";
export const defaultCdpUrl = `http://127.0.0.1:${defaultCdpPort}`;

const chatGptUrl = "https://chatgpt.com/";

function isWindowsHost(): boolean {
  return process.platform === "win32";
}

function runForeground(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", chunk => {
      stdout += String(chunk);
    });
    child.stderr.on("data", chunk => {
      stderr += String(chunk);
    });
    child.once("error", reject);
    child.once("close", code => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(
        new Error(
          `${command} exited with code ${code}\n${stdout.trim()}\n${stderr.trim()}`.trim(),
        ),
      );
    });
  });
}

function powershellArgs(script: string): string[] {
  const encodedCommand = Buffer.from(script, "utf16le").toString("base64");

  return [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-EncodedCommand",
    encodedCommand,
  ];
}

async function openWindowsBrowser(port: string): Promise<void> {
  const script = `
$port = "${port}"
$profile = Join-Path $env:LOCALAPPDATA "ChatGPTAutomationProfile"
New-Item -ItemType Directory -Force -Path $profile | Out-Null

Get-CimInstance Win32_Process |
  Where-Object {
    ($_.Name -eq "chrome.exe" -or $_.Name -eq "msedge.exe") -and
    $_.CommandLine -and (
      $_.CommandLine -like "*ChatGPTAutomationProfile*" -or
      $_.CommandLine -like "*remote-debugging-port=$port*"
    )
  } |
  ForEach-Object {
    try { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue } catch {}
  }

$args = @(
  "--remote-debugging-port=$port",
  "--remote-debugging-address=127.0.0.1",
  "--remote-allow-origins=*",
  "--user-data-dir=$profile",
  "--no-first-run",
  "--new-window",
  "${chatGptUrl}"
)

$programFiles = [Environment]::GetEnvironmentVariable("ProgramFiles")
$programFilesX86 = [Environment]::GetEnvironmentVariable("ProgramFiles(x86)")
$browsers = @(
  (Join-Path $programFiles "Google\\Chrome\\Application\\chrome.exe"),
  (Join-Path $programFilesX86 "Google\\Chrome\\Application\\chrome.exe"),
  (Join-Path $programFiles "Microsoft\\Edge\\Application\\msedge.exe"),
  (Join-Path $programFilesX86 "Microsoft\\Edge\\Application\\msedge.exe")
)

foreach ($browser in $browsers) {
  if (Test-Path $browser) {
    Start-Process -FilePath $browser -ArgumentList $args -ErrorAction Stop
    exit 0
  }
}

throw "Chrome or Edge executable not found."
`;

  await runForeground("powershell.exe", powershellArgs(script));
}

export async function openExternalAutomationBrowser(
  port = defaultCdpPort,
): Promise<void> {
  if (!isWindowsHost()) {
    throw new Error(
      "External ChatGPT browser automation is Windows-only. Run it from Windows PowerShell.",
    );
  }

  await openWindowsBrowser(port);
  logger.success("Browser opened for ChatGPT automation.");
}

export async function closeExternalAutomationBrowser(
  port = defaultCdpPort,
): Promise<void> {
  if (!isWindowsHost()) {
    throw new Error(
      "External ChatGPT browser cleanup is Windows-only. Run it from Windows PowerShell.",
    );
  }

  const script = `
$port = "${port}"
Get-CimInstance Win32_Process |
  Where-Object {
    ($_.Name -eq "chrome.exe" -or $_.Name -eq "msedge.exe") -and
    $_.CommandLine -and (
      $_.CommandLine -like "*ChatGPTAutomationProfile*" -or
      $_.CommandLine -like "*remote-debugging-port=$port*"
    )
  } |
  ForEach-Object {
    try { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue } catch {}
  }

`;

  await runForeground("powershell.exe", powershellArgs(script)).catch(
    () => undefined,
  );
}

export function getCdpEndpointCandidates(port = defaultCdpPort): string[] {
  return [`http://127.0.0.1:${port}`, `http://localhost:${port}`];
}

export async function waitForCdpEndpoint(
  endpoint = defaultCdpUrl,
  timeoutMs = 60000,
): Promise<string> {
  const startedAt = Date.now();
  const endpoints =
    endpoint === defaultCdpUrl ? getCdpEndpointCandidates() : [endpoint];

  while (Date.now() - startedAt < timeoutMs) {
    for (const candidate of endpoints) {
      try {
        const response = await fetch(`${candidate}/json/version`);

        if (response.ok) {
          const version = (await response.json()) as {
            webSocketDebuggerUrl?: string;
          };

          if (version.webSocketDebuggerUrl) {
            const candidateUrl = new URL(candidate);
            const websocketUrl = new URL(version.webSocketDebuggerUrl);
            websocketUrl.hostname = candidateUrl.hostname;
            websocketUrl.port = candidateUrl.port;
            websocketUrl.protocol = "ws:";

            return websocketUrl.toString();
          }

          return candidate;
        }
      } catch {
        // Browser is still starting or this endpoint is not reachable.
      }
    }

    await new Promise(resolve => setTimeout(resolve, 1000));
  }

  throw new Error(
    `Could not connect to browser debugging endpoint. Tried: ${endpoints.join(", ")}. Close old automation browser windows and try again.`,
  );
}
