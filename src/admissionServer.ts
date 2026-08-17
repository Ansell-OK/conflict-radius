import { createServer } from "node:http";
import { AdmissionCoordinator, ChangeSetInput } from "./admission.js";
import { HydraClient, hydraConfigFromEnv } from "./hydra/client.js";

const client = new HydraClient(hydraConfigFromEnv());
const coordinator = new AdmissionCoordinator(client);
const port = Number(process.env.CONFLICT_RADAR_ADMISSION_PORT ?? 17840);

async function body(request: import("node:http").IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

const server = createServer(async (request, response) => {
  response.setHeader("Content-Type", "application/json");
  try {
    if (request.method === "GET" && request.url === "/health") {
      response.end(JSON.stringify({ ok: true }));
      return;
    }
    if (request.method === "POST" && request.url === "/admit") {
      const result = await coordinator.admit(await body(request) as ChangeSetInput);
      response.statusCode = result.status === "admitted" ? 200 : 409;
      response.end(JSON.stringify(result));
      return;
    }
    if (request.method === "POST" && request.url === "/finalize") {
      const input = await body(request) as { provider: string; repositoryKey: string; externalChangeId: string; status: "merged" | "closed" };
      await coordinator.finalize(input.provider, input.repositoryKey, input.externalChangeId, input.status);
      response.end(JSON.stringify({ ok: true }));
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: "not found" }));
  } catch (error) {
    response.statusCode = 500;
    response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
  }
});

server.listen(port, "127.0.0.1", () => console.log(`conflict-radar admission coordinator listening on http://127.0.0.1:${port}`));

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => server.close(async () => { await client.close(); process.exit(0); }));
}
