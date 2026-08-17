import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parse } from "yaml";
import { AdmissionCoordinator, ChangeSetInput } from "../src/admission.js";
import { ConflictRadar } from "../src/conflictRadar.js";
import { extractOpenApiMembers } from "../src/contracts/openapi.js";
import { HydraClient, hydraConfigFromEnv } from "../src/hydra/client.js";

const providerRoot = path.resolve("stress-repos/ehr-record-api");
const consumerRoot = path.resolve("stress-repos/clinic-dashboard");
const providerSpec = path.join(providerRoot, "openapi.yaml");
const baselineSource = await readFile(providerSpec, "utf8");
const breakingSource = baselineSource
  .replace("      required: [recordId, patientId, allergies]", "      required: [recordId, patientId]")
  .replace("        allergies:\n          type: array\n          items:\n            type: string\n", "");

for (const [root, key] of [[providerRoot, "stress.local/ehr-record-api"], [consumerRoot, "stress.local/clinic-dashboard"]] as const) {
  execFileSync(process.execPath, ["dist/extractor/extractSymbols.js", root, "--repository-key", key], { stdio: "inherit" });
  execFileSync(process.execPath, ["dist/extractor/ingestContracts.js", root], { stdio: "inherit" });
}

const baseline = extractOpenApiMembers(parse(baselineSource)).find((member) => member.memberKey === "operation:getRecord")!;
const breaking = extractOpenApiMembers(parse(breakingSource)).find((member) => member.memberKey === "operation:getRecord")!;
const client = new HydraClient(hydraConfigFromEnv());
const radar = new ConflictRadar(client);
const coordinator = new AdmissionCoordinator(client);

function change(repositoryKey: string, externalChangeId: string, role: "provider" | "consumer", afterSnapshot: string): ChangeSetInput {
  return {
    provider: "stress",
    repositoryKey,
    externalChangeId,
    headSha: `head-${externalChangeId}`,
    baseSha: "base",
    providerCreatedAt: new Date().toISOString(),
    impacts: [{ coordinate: "openapi:stress/ehr-records", memberKey: "operation:getRecord", memberKind: "operation", role, impactKind: role === "provider" ? "contract-delta" : "symbol-use", beforeSnapshot: baseline.snapshot, afterSnapshot }],
  };
}

try {
  await radar.releaseTask("ehr-provider-agent");
  await radar.releaseTask("ehr-consumer-agent");
  await radar.claimTask({ agentId: "ehr-provider-agent", repositoryKey: "stress.local/ehr-record-api", taskDescription: "Remove allergies from the EHR response", symbols: ["getRecord"] });
  await radar.claimTask({ agentId: "ehr-consumer-agent", repositoryKey: "stress.local/clinic-dashboard", taskDescription: "Render patient allergies", symbols: ["renderRecord"] });
  await writeFile(providerSpec, breakingSource, "utf8");
  const live = await radar.checkConflicts("ehr-provider-agent", "strong");
  const finding = live.conflicts.find((conflict) => conflict.scope === "cross-repo");
  console.log("LIVE_COLLISION", JSON.stringify(finding, null, 2));
  if (finding?.severity !== "verified-breaking" || finding.path.join(" -> ") !== "getRecord -> operation:getRecord -> renderRecord") {
    throw new Error("Fresh EHR repositories did not produce the expected verified-breaking path");
  }

  let correctRounds = 0;
  for (let round = 0; round < 10; round += 1) {
    const suffix = `${Date.now()}-${round}`;
    const consumer = change("stress.local/clinic-dashboard", `consumer-${suffix}`, "consumer", baseline.snapshot);
    const provider = change("stress.local/ehr-record-api", `provider-${suffix}`, "provider", breaking.snapshot);
    const [consumerResult, providerResult] = await Promise.all([coordinator.admit(consumer), coordinator.admit(provider)]);
    if (consumerResult.status === "admitted" && providerResult.status === "blocked") correctRounds += 1;
    await coordinator.finalize(consumer.provider, consumer.repositoryKey, consumer.externalChangeId, "closed");
    await coordinator.finalize(provider.provider, provider.repositoryKey, provider.externalChangeId, "closed");
  }
  console.log(JSON.stringify({ admissionRounds: 10, correctRounds }, null, 2));
  if (correctRounds !== 10) throw new Error(`Admission stress failed in ${10 - correctRounds} round(s)`);
} finally {
  await writeFile(providerSpec, baselineSource, "utf8");
  await radar.releaseTask("ehr-provider-agent");
  await radar.releaseTask("ehr-consumer-agent");
  await client.close();
}
