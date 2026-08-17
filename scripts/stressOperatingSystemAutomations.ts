import { homedir } from "node:os";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { parse } from "yaml";
import { AdmissionCoordinator, ChangeSetInput } from "../src/admission.js";
import { extractOpenApiMembers } from "../src/contracts/openapi.js";
import { HydraClient, hydraConfigFromEnv } from "../src/hydra/client.js";

const documents = path.join(homedir(), "Documents");
const providerSpec = path.join(documents, "operating-system-automations", "openapi", "automation.yaml");
const changedProviderSpec = path.join(
  documents,
  "operating-system-automations-worktrees",
  "scheduler-agent",
  "openapi",
  "automation.yaml",
);
const consumerSpec = path.join(documents, "operating-system-automations-console", "automation-api.yaml");

async function operationSnapshot(specPath: string): Promise<string> {
  const source = await readFile(specPath, "utf8");
  const operation = extractOpenApiMembers(parse(source)).find((member) => member.memberKey === "operation:admitJob");
  if (!operation) throw new Error(`operation:admitJob was not found in ${specPath}`);
  return operation.snapshot;
}

const [baselineSnapshot, breakingSnapshot, consumerSnapshot] = await Promise.all([
  operationSnapshot(providerSpec),
  operationSnapshot(changedProviderSpec),
  operationSnapshot(consumerSpec),
]);

function change(
  repositoryKey: string,
  externalChangeId: string,
  role: "provider" | "consumer",
  beforeSnapshot: string,
  afterSnapshot: string,
): ChangeSetInput {
  return {
    provider: "os-automation-stress",
    repositoryKey,
    externalChangeId,
    headSha: `head-${externalChangeId}`,
    baseSha: "a717693",
    providerCreatedAt: new Date().toISOString(),
    impacts: [{
      coordinate: "openapi:stress/os-automations",
      memberKey: "operation:admitJob",
      memberKind: "operation",
      role,
      impactKind: role === "provider" ? "contract-delta" : "symbol-use",
      beforeSnapshot,
      afterSnapshot,
    }],
  };
}

const client = new HydraClient(hydraConfigFromEnv());
const coordinator = new AdmissionCoordinator(client);
let correctRounds = 0;

try {
  for (let round = 0; round < 10; round += 1) {
    const suffix = `${Date.now()}-${round}`;
    const consumer = change(
      "stress.local/operating-system-automations-console",
      `consumer-${suffix}`,
      "consumer",
      consumerSnapshot,
      consumerSnapshot,
    );
    const provider = change(
      "stress.local/operating-system-automations",
      `provider-${suffix}`,
      "provider",
      baselineSnapshot,
      breakingSnapshot,
    );

    const [consumerResult, providerResult] = await Promise.all([
      coordinator.admit(consumer),
      coordinator.admit(provider),
    ]);
    if (
      consumerResult.status === "admitted"
      && providerResult.status === "blocked"
      && providerResult.blockers.some((blocker) => blocker.repositoryKey === consumer.repositoryKey)
    ) {
      correctRounds += 1;
    }

    await coordinator.finalize(consumer.provider, consumer.repositoryKey, consumer.externalChangeId, "closed");
    await coordinator.finalize(provider.provider, provider.repositoryKey, provider.externalChangeId, "closed");
  }

  console.log(JSON.stringify({ admissionRounds: 10, correctRounds }, null, 2));
  if (correctRounds !== 10) throw new Error(`Admission stress failed in ${10 - correctRounds} round(s)`);
} finally {
  await client.close();
}
