import { execFileSync } from "node:child_process";
import path from "node:path";
import { HydraClient, hydraConfigFromEnv } from "../src/hydra/client.js";

const fixtureRoot = path.resolve("scripts/fixtures/typescript-repo");
execFileSync(process.execPath, ["dist/extractor/extractSymbols.js", fixtureRoot, "--repository-key", "fixtures/typescript-repo"], { cwd: process.cwd(), stdio: "inherit" });

const client = new HydraClient(hydraConfigFromEnv());
try {
  const symbols = await client.query(
    "MATCH (s:Symbol {language: $language})-[:DEFINED_IN]->(f:File)-[:PART_OF]->(r:Repo {path: $repoPath}) RETURN DISTINCT s.name AS name, s.signature_snapshot AS snapshot",
    { language: "typescript", repoPath: fixtureRoot },
    "strong",
  );
  const names = new Set(symbols.map((row) => row.name));
  const readPatient = symbols.find((row) => row.name === "crTsReadPatient");
  const summary = symbols.find((row) => row.name === "crTsBuildPatientSummary");
  if (!names.has("crTsReadPatient") || !names.has("crTsBuildPatientSummary")) throw new Error("TypeScript definitions were not extracted");
  if (typeof readPatient?.snapshot !== "string" || !readPatient.snapshot.includes("patientId") || !readPatient.snapshot.includes("active")) {
    throw new Error("TypeScript parameter or return type missing from crTsReadPatient signature_snapshot");
  }
  if (typeof summary?.snapshot !== "string" || !summary.snapshot.includes("includeStatus") || !summary.snapshot.includes("optional\":true")) {
    throw new Error("TypeScript arrow-function/default-parameter signature was not captured");
  }

  const edges = await client.query(
    "MATCH (caller:Symbol {name: $caller})-[:CALLS]->(callee:Symbol {name: $callee}) MATCH (caller)-[:DEFINED_IN]->(f:File)-[:PART_OF]->(r:Repo {path: $repoPath}) RETURN DISTINCT caller.name AS caller, callee.name AS callee",
    { caller: "crTsBuildPatientSummary", callee: "crTsReadPatient", repoPath: fixtureRoot },
    "strong",
  );
  if (edges.length !== 1) throw new Error(`Expected one TypeScript CALLS edge, received ${edges.length}`);
  console.log(JSON.stringify({ symbols: [...names].sort(), callEdge: edges[0], typedSignatures: true }, null, 2));
} finally {
  await client.close();
}
