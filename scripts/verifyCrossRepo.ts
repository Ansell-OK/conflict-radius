import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { ConflictRadar, Conflict } from "../src/conflictRadar.js";
import { HydraClient, hydraConfigFromEnv } from "../src/hydra/client.js";

const providerRoot = path.resolve("scripts/fixtures/cross-repo-provider");
const consumerRoot = path.resolve("scripts/fixtures/cross-repo-consumer");
const providerSpec = path.join(providerRoot, "openapi.yaml");
const baseline = await readFile(providerSpec, "utf8");
const compatible = baseline.replace("                  status:\n                    type: string", "                  status:\n                    type: string\n                  displayName:\n                    type: string");
const breaking = baseline
  .replace("                required: [patientId, status]", "                required: [patientId]")
  .replace("                  status:\n                    type: string\n", "");

execFileSync(process.execPath, ["dist/extractor/extractSymbols.js", providerRoot, "--repository-key", "github.com/conflict-radar-fixtures/patient-api"], { stdio: "inherit" });
execFileSync(process.execPath, ["dist/extractor/extractSymbols.js", consumerRoot, "--repository-key", "github.com/conflict-radar-fixtures/patient-web"], { stdio: "inherit" });
execFileSync(process.execPath, ["dist/extractor/ingestContracts.js", providerRoot], { stdio: "inherit" });
execFileSync(process.execPath, ["dist/extractor/ingestContracts.js", consumerRoot], { stdio: "inherit" });

const client = new HydraClient(hydraConfigFromEnv());
const radar = new ConflictRadar(client);

async function release(): Promise<void> {
  await radar.releaseTask("cross-provider");
  await radar.releaseTask("cross-consumer");
}

async function runCase(label: string, source: string, expected: Conflict["severity"]): Promise<void> {
  await writeFile(providerSpec, baseline, "utf8");
  await release();
  await radar.claimTask({ agentId: "cross-provider", repositoryKey: "github.com/conflict-radar-fixtures/patient-api", taskDescription: `${label} provider`, symbols: ["getPatient"] });
  await radar.claimTask({ agentId: "cross-consumer", repositoryKey: "github.com/conflict-radar-fixtures/patient-web", taskDescription: `${label} consumer`, symbols: ["fetchPatient"] });
  await writeFile(providerSpec, source, "utf8");
  const result = await radar.checkConflicts("cross-provider", "strong");
  const finding = result.conflicts.find((conflict) => conflict.scope === "cross-repo");
  console.log(label.toUpperCase(), JSON.stringify(finding, null, 2));
  if (!finding || finding.severity !== expected || finding.path.length !== 3) {
    throw new Error(`${label}: expected ${expected} cross-repo finding, received ${finding?.severity ?? "none"}`);
  }
}

try {
  await runCase("unchanged", baseline, "reachable-unverified");
  await runCase("compatible", compatible, "verified-compatible");
  await runCase("breaking", breaking, "verified-breaking");
} finally {
  await writeFile(providerSpec, baseline, "utf8");
  await release();
  await client.close();
}
