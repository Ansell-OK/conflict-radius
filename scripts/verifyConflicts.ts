import { execFileSync } from "node:child_process";
import path from "node:path";
import { ConflictRadar } from "../src/conflictRadar.js";
import { HydraClient, hydraConfigFromEnv } from "../src/hydra/client.js";

const repositoryKey = "github.com/ansell-ok/conflict-radius";
execFileSync(process.execPath, ["dist/extractor/extractSymbols.js", path.resolve("demo-repo"), "--repository-key", repositoryKey], { stdio: "inherit" });
const client = new HydraClient(hydraConfigFromEnv());
const radar = new ConflictRadar(client);

await radar.releaseTask("checkpoint-agent-a");
await radar.releaseTask("checkpoint-agent-b");

await radar.claimTask({ agentId: "checkpoint-agent-a", repositoryKey, taskDescription: "Change getUser signature", symbols: ["getUser"] });
await radar.claimTask({ agentId: "checkpoint-agent-b", repositoryKey, taskDescription: "Submit an order", symbols: ["submitOrder"] });
const collision = await radar.checkConflicts("checkpoint-agent-a", "strong");
console.log("COLLISION", JSON.stringify(collision, null, 2));
if (!collision.conflicts.some((conflict) => conflict.conflictingAgent === "checkpoint-agent-b")) {
  throw new Error("Expected graph-reachable conflict was not detected");
}
if (!collision.conflicts.some((conflict) => conflict.path.join(" -> ") === "getUser -> createOrder -> submitOrder")) {
  throw new Error("Expected two-hop path was not returned");
}

await radar.releaseTask("checkpoint-agent-b");
await radar.claimTask({ agentId: "checkpoint-agent-b", repositoryKey, taskDescription: "Format an order", symbols: ["formatOrder"] });
const clear = await radar.checkConflicts("checkpoint-agent-a", "strong");
console.log("CLEAR", JSON.stringify(clear, null, 2));
if (clear.conflicts.some((conflict) => conflict.conflictingAgent === "checkpoint-agent-b")) {
  throw new Error("Independent claims produced a false positive");
}

await radar.releaseTask("checkpoint-agent-a");
await radar.releaseTask("checkpoint-agent-b");
await client.close();
