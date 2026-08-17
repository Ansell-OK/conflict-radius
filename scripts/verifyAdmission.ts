import { readFile } from "node:fs/promises";
import path from "node:path";
import { parse } from "yaml";
import { AdmissionCoordinator, ChangeSetInput } from "../src/admission.js";
import { extractOpenApiMembers } from "../src/contracts/openapi.js";
import { HydraClient, hydraConfigFromEnv } from "../src/hydra/client.js";

const providerSpec = path.resolve("scripts/fixtures/cross-repo-provider/openapi.yaml");
const baselineSource = await readFile(providerSpec, "utf8");
const breakingSource = baselineSource
  .replace("                required: [patientId, status]", "                required: [patientId]")
  .replace("                  status:\n                    type: string\n", "");
const baseline = extractOpenApiMembers(parse(baselineSource)).find((member) => member.memberKey === "operation:getPatient")!;
const breaking = extractOpenApiMembers(parse(breakingSource)).find((member) => member.memberKey === "operation:getPatient")!;
const runId = `${Date.now()}`;

function input(repositoryKey: string, externalChangeId: string, role: "provider" | "consumer", afterSnapshot: string): ChangeSetInput {
  return {
    provider: "fixture",
    repositoryKey,
    externalChangeId,
    headSha: `head-${externalChangeId}`,
    baseSha: "base",
    providerCreatedAt: new Date().toISOString(),
    impacts: [{
      coordinate: "openapi:fixtures/patient-records",
      memberKey: "operation:getPatient",
      memberKind: "operation",
      role,
      impactKind: role === "provider" ? "contract-delta" : "symbol-use",
      beforeSnapshot: baseline.snapshot,
      afterSnapshot,
    }],
  };
}

const consumer = input("github.com/conflict-radar-fixtures/patient-web", `consumer-${runId}`, "consumer", baseline.snapshot);
const provider = input("github.com/conflict-radar-fixtures/patient-api", `provider-${runId}`, "provider", breaking.snapshot);
const client = new HydraClient(hydraConfigFromEnv());
const coordinator = new AdmissionCoordinator(client);

try {
  const [consumerResult, providerResult] = await Promise.all([coordinator.admit(consumer), coordinator.admit(provider)]);
  console.log("CONCURRENT", JSON.stringify({ consumerResult, providerResult }, null, 2));
  if (consumerResult.status !== "admitted" || providerResult.status !== "blocked" || providerResult.blockers.length !== 1) {
    throw new Error("Expected consumer admission and incompatible provider block");
  }
  await coordinator.finalize(consumer.provider, consumer.repositoryKey, consumer.externalChangeId, "closed");
  const retry = await coordinator.admit(provider);
  console.log("RETRY", JSON.stringify(retry, null, 2));
  if (retry.status !== "admitted") throw new Error("Expected provider admission after blocker closed");
  await coordinator.finalize(provider.provider, provider.repositoryKey, provider.externalChangeId, "closed");
} finally {
  await client.close();
}
