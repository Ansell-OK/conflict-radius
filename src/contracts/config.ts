import { readFile } from "node:fs/promises";
import path from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { normalizeRepositoryKey } from "../repository.js";

const bindingSchema = z.object({
  member: z.string().min(1),
  symbol: z.string().min(1),
});

const contractSchema = z.object({
  coordinate: z.string().startsWith("openapi:"),
  role: z.enum(["provider", "consumer"]),
  document: z.string().min(1),
  bindings: z.array(bindingSchema).min(1),
});

const configSchema = z.object({
  repository: z.object({ key: z.string().min(1) }),
  contracts: z.array(contractSchema).min(1),
});

export type ConflictRadarConfig = z.infer<typeof configSchema>;

export async function loadConflictRadarConfig(repoRoot: string, configPath = ".conflict-radar.yml"): Promise<ConflictRadarConfig> {
  const absolute = path.resolve(repoRoot, configPath);
  const parsed = configSchema.parse(parse(await readFile(absolute, "utf8")));
  return {
    ...parsed,
    repository: { key: normalizeRepositoryKey(parsed.repository.key) },
  };
}
