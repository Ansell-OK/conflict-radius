import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ConflictRadar } from "./conflictRadar.js";
import { HydraClient, hydraConfigFromEnv } from "./hydra/client.js";
import { checkConflicts, checkConflictsSchema } from "./tools/checkConflicts.js";
import { claimTask, claimTaskSchema } from "./tools/claimTask.js";
import { releaseTask, releaseTaskSchema } from "./tools/releaseTask.js";

const client = new HydraClient(hydraConfigFromEnv());
const radar = new ConflictRadar(client);
const server = new McpServer({ name: "conflict-radar-mcp", version: "0.1.0" });

server.registerTool("claim_task", {
  description: "Registers what you are about to work on so other parallel agents can be warned. Call this before making edits.",
  inputSchema: claimTaskSchema,
}, async (input) => ({ content: [{ type: "text", text: JSON.stringify(await claimTask(radar, input), null, 2) }] }));

server.registerTool("check_conflicts", {
  description: "Checks whether your active work overlaps or is graph-reachable from another agent's work. Call periodically and before finishing or merging.",
  inputSchema: checkConflictsSchema,
}, async (input) => {
  const result = await checkConflicts(radar, input);
  const text = result.conflicts.length === 0 ? `No active conflicts found.\n${JSON.stringify(result, null, 2)}` : JSON.stringify(result, null, 2);
  return { content: [{ type: "text", text }] };
});

server.registerTool("release_task", {
  description: "Marks this agent's active claim complete or abandoned.",
  inputSchema: releaseTaskSchema,
}, async (input) => ({ content: [{ type: "text", text: JSON.stringify(await releaseTask(radar, input), null, 2) }] }));

await server.connect(new StdioServerTransport());
