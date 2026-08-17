import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export function normalizeRepositoryKey(value: string): string {
  const trimmed = value.trim().replaceAll("\\", "/").replace(/\.git$/, "");
  const ssh = trimmed.match(/^git@([^:]+):(.+)$/);
  if (ssh) return `${ssh[1]}/${ssh[2]}`.toLowerCase();
  try {
    const url = new URL(trimmed);
    return `${url.host}${url.pathname}`.replace(/\/$/, "").toLowerCase();
  } catch {
    return trimmed.replace(/^\/+|\/+$/g, "").toLowerCase();
  }
}

export async function repositoryKeyForRoot(repoRoot: string, explicit?: string): Promise<string> {
  if (explicit) return normalizeRepositoryKey(explicit);
  try {
    const { stdout } = await execFileAsync("git", ["config", "--get", "remote.origin.url"], { cwd: repoRoot });
    if (stdout.trim()) return normalizeRepositoryKey(stdout);
  } catch {
    // A fixture or local-only repository may not have a remote.
  }
  return `local:${path.resolve(repoRoot).replaceAll(path.sep, "/").toLowerCase()}`;
}
