import path from "node:path";
import { loadConflictRadarConfig } from "../src/contracts/config.js";
import { ingestContracts } from "../src/contracts/ingest.js";
import { HydraClient, hydraConfigFromEnv } from "../src/hydra/client.js";

const repoRoot = path.resolve(process.argv[2] ?? ".");
const config = await loadConflictRadarConfig(repoRoot, process.argv[3]);
const client = new HydraClient(hydraConfigFromEnv());
try {
  const result = await ingestContracts(client, repoRoot, config, process.env.GITHUB_SHA ?? "working-tree");
  console.log(JSON.stringify({ repositoryKey: config.repository.key, ...result }, null, 2));
} finally {
  await client.close();
}
