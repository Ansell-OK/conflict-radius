import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { parse } from "yaml";
import { extractOpenApiMembers } from "../src/contracts/openapi.js";

const port = 17842;
const baseUrl = `http://127.0.0.1:${port}`;
const child = spawn(process.execPath, ["dist/src/admissionServer.js"], {
  cwd: process.cwd(),
  env: { ...process.env, CONFLICT_RADAR_ADMISSION_PORT: String(port) },
  stdio: ["ignore", "pipe", "pipe"],
});
child.stdout.on("data", (chunk) => process.stdout.write(chunk));
child.stderr.on("data", (chunk) => process.stderr.write(chunk));

async function waitForHealth(): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return;
    } catch {
      // Process startup is asynchronous.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Admission server did not become healthy");
}

try {
  await waitForHealth();
  const source = await readFile("scripts/fixtures/cross-repo-consumer/patient-api.yaml", "utf8");
  const member = extractOpenApiMembers(parse(source)).find((item) => item.memberKey === "operation:getPatient")!;
  const externalChangeId = `http-${Date.now()}`;
  const payload = {
    provider: "fixture-http",
    repositoryKey: "github.com/conflict-radar-fixtures/http-consumer",
    externalChangeId,
    headSha: `head-${externalChangeId}`,
    baseSha: "base",
    providerCreatedAt: new Date().toISOString(),
    impacts: [{ coordinate: "openapi:fixtures/patient-records", memberKey: member.memberKey, memberKind: member.memberKind, role: "consumer", impactKind: "symbol-use", beforeSnapshot: member.snapshot, afterSnapshot: member.snapshot }],
  };
  const admission = await fetch(`${baseUrl}/admit`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
  const result = await admission.json() as { status?: string; error?: string };
  console.log("HTTP_ADMISSION", JSON.stringify(result, null, 2));
  if (!admission.ok || result.status !== "admitted") throw new Error(result.error ?? "HTTP admission failed");
  const finalized = await fetch(`${baseUrl}/finalize`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ provider: payload.provider, repositoryKey: payload.repositoryKey, externalChangeId, status: "closed" }) });
  if (!finalized.ok) throw new Error(`HTTP finalize failed: ${await finalized.text()}`);
} finally {
  child.kill("SIGTERM");
  await new Promise<void>((resolve) => child.once("exit", () => resolve()));
}
