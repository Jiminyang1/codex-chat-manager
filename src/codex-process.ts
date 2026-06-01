import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

type CodexProcess = { pid: number; command: string };

export async function getCodexDesktopProcesses(): Promise<CodexProcess[]> {
  if (process.platform !== "darwin") return [];
  const { stdout } = await execFileAsync("ps", ["-axo", "pid=,comm="], { maxBuffer: 1024 * 1024 });
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const match = line.match(/^(\d+)\s+(.+)$/);
      return match ? { pid: Number(match[1]), command: match[2] } : null;
    })
    .filter((proc): proc is CodexProcess => proc !== null)
    .filter((proc) => proc.command.endsWith("/Applications/Codex.app/Contents/MacOS/Codex"));
}

export async function isCodexDesktopRunning() {
  const processes = await getCodexDesktopProcesses();
  return { running: processes.length > 0, processes };
}

export async function quitCodexDesktop() {
  if (process.platform !== "darwin") return { requested: false, reason: "unsupported-platform" };
  await execFileAsync("osascript", ["-e", 'tell application "Codex" to quit']);
  return { requested: true };
}
