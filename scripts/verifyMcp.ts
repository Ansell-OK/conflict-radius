import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({ command: process.execPath, args: ["dist/src/index.js"] });
const client = new Client({ name: "conflict-radar-checkpoint", version: "0.1.0" });
await client.connect(transport);

const tools = await client.listTools();
console.log("TOOLS", tools.tools.map((tool) => tool.name).join(", "));
for (const required of ["claim_task", "check_conflicts", "release_task"]) {
  if (!tools.tools.some((tool) => tool.name === required)) throw new Error(`Missing MCP tool ${required}`);
}

await client.callTool({ name: "release_task", arguments: { agentId: "mcp-agent-a" } });
await client.callTool({ name: "release_task", arguments: { agentId: "mcp-agent-b" } });
const claimA = await client.callTool({
  name: "claim_task",
  arguments: { agentId: "mcp-agent-a", repositoryKey: "github.com/ansell-ok/conflict-radius", taskDescription: "Change getUser signature", symbols: ["getUser"] },
});
const claimB = await client.callTool({
  name: "claim_task",
  arguments: { agentId: "mcp-agent-b", repositoryKey: "github.com/ansell-ok/conflict-radius", taskDescription: "Add order creation", symbols: ["createOrder"] },
});
console.log("CLAIM_A", JSON.stringify(claimA));
console.log("CLAIM_B", JSON.stringify(claimB));
if (claimA.isError || claimB.isError) throw new Error("MCP claim_task returned an error");
const result = await client.callTool({ name: "check_conflicts", arguments: { agentId: "mcp-agent-a", mode: "strong" } });
const content = result.content as Array<{ type: string; text?: string }>;
const text = content.find((item) => item.type === "text")?.text ?? "";
console.log("CHECK", text);
if (!text.includes("mcp-agent-b") || !text.includes("indirect")) throw new Error("MCP check did not surface the expected conflict");

await client.callTool({ name: "release_task", arguments: { agentId: "mcp-agent-a" } });
await client.callTool({ name: "release_task", arguments: { agentId: "mcp-agent-b" } });
await transport.close();
