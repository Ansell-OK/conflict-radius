#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { ConflictRadar } from "./conflictRadar.js";
import { HydraClient, hydraConfigFromEnv } from "./hydra/client.js";
import { AdmissionResult, ChangeSetInput } from "./admission.js";

interface OpenPr {
  id: string;
  taskDescription: string;
  symbols: string[];
}

interface GitHubPullRequest {
  number: number;
  title: string;
}

interface GitHubFile {
  filename: string;
}

function changedFiles(base: string): string[] {
  const output = execFileSync("git", ["diff", "--name-only", `${base}...HEAD`], { encoding: "utf8" });
  return output.split(/\r?\n/).map((file) => file.trim().replaceAll("\\", "/")).filter(Boolean);
}

async function symbolsForFiles(client: HydraClient, files: string[]): Promise<string[]> {
  const symbols: string[] = [];
  for (const file of files) {
    const rows = await client.query("MATCH (s:Symbol {file_path: $file}) RETURN s.name AS name", { file });
    symbols.push(...rows.flatMap((row) => (typeof row.name === "string" ? [row.name] : [])));
  }
  return [...new Set(symbols)];
}

async function githubJson<T>(path: string): Promise<T> {
  const repository = process.env.GITHUB_REPOSITORY;
  const token = process.env.GITHUB_TOKEN;
  if (!repository || !token) throw new Error("GITHUB_REPOSITORY and GITHUB_TOKEN are required to discover open PRs");
  const response = await fetch(`https://api.github.com/repos/${repository}${path}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "User-Agent": "conflict-radar-ci" },
  });
  if (!response.ok) throw new Error(`GitHub API failed (${response.status}): ${await response.text()}`);
  return response.json() as Promise<T>;
}

async function discoverOpenPrs(client: HydraClient): Promise<OpenPr[]> {
  if (!process.env.GITHUB_REPOSITORY || !process.env.GITHUB_TOKEN) return [];
  const current = Number(process.env.GITHUB_EVENT_NUMBER ?? 0);
  const pulls = await githubJson<GitHubPullRequest[]>("/pulls?state=open&per_page=100");
  const result: OpenPr[] = [];
  for (const pull of pulls.filter((item) => item.number !== current)) {
    const files = await githubJson<GitHubFile[]>(`/pulls/${pull.number}/files?per_page=100`);
    result.push({
      id: `pr-${pull.number}`,
      taskDescription: `PR #${pull.number}: ${pull.title}`,
      symbols: await symbolsForFiles(client, files.map((file) => file.filename)),
    });
  }
  return result;
}

async function requestAdmission(): Promise<AdmissionResult | null> {
  const payloadPath = process.env.CONFLICT_RADAR_CHANGE_SET;
  if (!payloadPath) return null;
  const admissionUrl = process.env.CONFLICT_RADAR_ADMISSION_URL;
  if (!admissionUrl) throw new Error("CONFLICT_RADAR_ADMISSION_URL is required when CONFLICT_RADAR_CHANGE_SET is configured");
  const payload = JSON.parse(await readFile(payloadPath, "utf8")) as ChangeSetInput;
  const response = await fetch(`${admissionUrl.replace(/\/$/, "")}/admit`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const result = await response.json() as AdmissionResult & { error?: string };
  if (response.status === 409) return result;
  if (!response.ok) throw new Error(`Cross-repository admission failed (${response.status}): ${result.error ?? JSON.stringify(result)}`);
  return result;
}

const base = process.env.GITHUB_BASE_REF ? `origin/${process.env.GITHUB_BASE_REF}` : process.env.CONFLICT_RADAR_BASE ?? "main";
const explicitSymbols = process.env.CONFLICT_RADAR_CHANGED_SYMBOLS?.split(",").map((symbol) => symbol.trim()).filter(Boolean);
const client = new HydraClient(hydraConfigFromEnv());
const currentSymbols = explicitSymbols?.length ? explicitSymbols : await symbolsForFiles(client, changedFiles(base));
const prs: OpenPr[] = process.env.CONFLICT_RADAR_OPEN_PRS
  ? JSON.parse(await readFile(process.env.CONFLICT_RADAR_OPEN_PRS, "utf8")) as OpenPr[]
  : await discoverOpenPrs(client);

if (currentSymbols.length === 0) {
  console.error("conflict-radar-ci: no changed symbols resolved; refusing to pass silently");
  process.exitCode = 2;
  await client.close();
} else {
  const radar = new ConflictRadar(client);
  const repositoryKey = process.env.CONFLICT_RADAR_REPOSITORY_KEY;
  const currentId = `ci-current-${process.env.GITHUB_SHA ?? Date.now()}`;
  await radar.releaseTask(currentId);
  await radar.claimTask({ agentId: currentId, repositoryKey, taskDescription: "CI changed symbols", symbols: currentSymbols, captureSnapshot: false });

  const claimed: string[] = [];
  try {
    for (const pr of prs) {
      await radar.releaseTask(pr.id);
      await radar.claimTask({ agentId: pr.id, repositoryKey, taskDescription: pr.taskDescription, symbols: pr.symbols, captureSnapshot: false });
      claimed.push(pr.id);
    }
    const result = await radar.checkConflicts(currentId, "strong");
    const blocking = result.conflicts.filter((conflict) => conflict.severity === "verified-breaking");
    if (blocking.length > 0) {
      console.error("conflict-radar-ci: desynchronization detected");
      console.error(JSON.stringify(result, null, 2));
      process.exitCode = 1;
    } else {
      const admission = await requestAdmission();
      if (admission?.status === "blocked") {
        console.error("conflict-radar-ci: cross-repository admission blocked");
        console.error(JSON.stringify(admission, null, 2));
        process.exitCode = 1;
      } else {
        console.log(`conflict-radar-ci: clear (${result.conflicts.length} advisory finding(s))`);
        if (admission) console.log(JSON.stringify({ admission }, null, 2));
        if (result.conflicts.length > 0) console.log(JSON.stringify(result, null, 2));
      }
    }
  } finally {
    await radar.releaseTask(currentId);
    for (const id of claimed) await radar.releaseTask(id);
    await client.close();
  }
}
