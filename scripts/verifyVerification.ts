import { execFileSync, spawnSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { ConflictRadar, Conflict } from "../src/conflictRadar.js";
import { HydraClient, hydraConfigFromEnv } from "../src/hydra/client.js";

const fixtureRoot = path.resolve("scripts/fixtures/verification-repo");
const repositoryFile = path.join(fixtureRoot, "clinicalRepository.js");
const baseline = `export function crReadClinicalRecord(patientId) {
  return { patientId, status: 'active' };
}
`;

function changedSignature(parameters: string): string {
  return `export function crReadClinicalRecord(${parameters}) {
  return { patientId, status: 'active' };
}
`;
}

const repositoryKey = "fixtures/verification-repo";
execFileSync(process.execPath, ["dist/extractor/extractSymbols.js", fixtureRoot, "--repository-key", repositoryKey], { cwd: process.cwd(), stdio: "inherit" });
const client = new HydraClient(hydraConfigFromEnv());
const radar = new ConflictRadar(client);

async function release(): Promise<void> {
  await radar.releaseTask("verification-callee");
  await radar.releaseTask("verification-caller");
}

async function runCase(label: string, source: string, expected: Conflict["severity"]): Promise<void> {
  await writeFile(repositoryFile, baseline, "utf8");
  await release();
  await radar.claimTask({ agentId: "verification-callee", repositoryKey, taskDescription: `${label} callee`, symbols: ["crReadClinicalRecord"] });
  await radar.claimTask({ agentId: "verification-caller", repositoryKey, taskDescription: `${label} caller`, symbols: ["crPrepareClinicalView"] });

  const snapshots = await client.query(
    "MATCH (s:Symbol {name: $name}) RETURN s.signature_snapshot AS snapshot",
    { name: "crReadClinicalRecord" },
    "strong",
  );
  if (!snapshots.some((row) => typeof row.snapshot === "string" && row.snapshot.includes("patientId"))) {
    throw new Error(`${label}: claim_task did not capture signature_snapshot`);
  }

  await writeFile(repositoryFile, source, "utf8");
  const result = await radar.checkConflicts("verification-callee", "strong");
  const finding = result.conflicts.find((conflict) => conflict.conflictingAgent === "verification-caller");
  console.log(label.toUpperCase(), JSON.stringify(finding, null, 2));
  if (!finding || finding.severity !== expected) {
    throw new Error(`${label}: expected ${expected}, received ${finding?.severity ?? "no finding"}`);
  }
}

async function runCiCase(label: string, source: string, expectedExit: number, expectedSeverity: Conflict["severity"]): Promise<void> {
  await writeFile(repositoryFile, source, "utf8");
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const result = spawnSync(process.execPath, ["dist/src/ci.js"], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        CONFLICT_RADAR_CHANGED_SYMBOLS: "crReadClinicalRecord",
        CONFLICT_RADAR_REPOSITORY_KEY: repositoryKey,
        CONFLICT_RADAR_OPEN_PRS: "scripts/fixtures/verification-open-prs.json",
      },
    });
    const output = `${result.stdout}${result.stderr}`;
    if (output.includes('"offset" is out of range') && attempt < 5) continue;
    console.log(`CI_${label.toUpperCase()}`, output.trim());
    if (result.status !== expectedExit || !output.includes(expectedSeverity)) {
      throw new Error(`${label} CI: expected exit ${expectedExit} and ${expectedSeverity}, received exit ${result.status}`);
    }
    return;
  }
}

try {
  await runCase("unchanged", baseline, "reachable-unverified");
  await runCase("compatible", changedSignature("patientId, options = {}"), "verified-compatible");
  await runCase("breaking", changedSignature("patientId, actorId"), "verified-breaking");
  await release();
  await writeFile(repositoryFile, baseline, "utf8");
  execFileSync(process.execPath, ["dist/extractor/extractSymbols.js", fixtureRoot, "--repository-key", repositoryKey], { cwd: process.cwd(), stdio: "inherit" });
  await runCiCase("unchanged", baseline, 0, "reachable-unverified");
  await runCiCase("compatible", changedSignature("patientId, options = {}"), 0, "verified-compatible");
  await runCiCase("breaking", changedSignature("patientId, actorId"), 1, "verified-breaking");
} finally {
  await writeFile(repositoryFile, baseline, "utf8");
  await release();
  await client.close();
}
