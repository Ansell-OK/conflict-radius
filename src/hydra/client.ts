import neo4j, { Driver, Integer, QueryResult, Record as Neo4jRecord } from "neo4j-driver";

export type ConsistencyMode = "causal" | "strong";

export interface HydraConfig {
  uri: string;
  token: string;
  database: string;
  timeoutMs: number;
}

function normalize(value: unknown): unknown {
  if (Integer.isInteger(value)) return (value as Integer).toNumber();
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === "object") {
    if ("properties" in value && typeof (value as { properties: unknown }).properties === "object") {
      return normalize((value as { properties: unknown }).properties);
    }
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, normalize(item)]));
  }
  return value;
}

function toBolt(value: unknown): unknown {
  if (typeof value === "number" && Number.isSafeInteger(value)) return neo4j.int(value);
  if (Array.isArray(value)) return value.map(toBolt);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, toBolt(item)]));
  }
  return value;
}

function rows(result: QueryResult): Array<Record<string, unknown>> {
  return result.records.map((record: Neo4jRecord) =>
    Object.fromEntries(record.keys.map((key) => [String(key), normalize(record.get(key))])),
  );
}

export class HydraClient {
  private readonly driver: Driver;

  constructor(private readonly config: HydraConfig) {
    this.driver = neo4j.driver(config.uri, neo4j.auth.basic("neo4j", config.token), {
      connectionTimeout: config.timeoutMs,
      disableLosslessIntegers: false,
    });
  }

  async query(
    query: string,
    parameters: Record<string, unknown> = {},
    consistency: ConsistencyMode = "causal",
  ): Promise<Array<Record<string, unknown>>> {
    const maxAttempts = 5;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const session = this.driver.session({ database: this.config.database });
      try {
        const result = await session.run(query, toBolt(parameters), {
          timeout: this.config.timeoutMs,
          metadata: { "hydradb.consistency": consistency },
        });
        return rows(result);
      } catch (error) {
        const offsetFailure = error instanceof RangeError
          && ((error as NodeJS.ErrnoException).code === "ERR_OUT_OF_RANGE" || error.message.includes('"offset" is out of range'));
        if (offsetFailure && attempt < maxAttempts - 1) continue;
        throw error;
      } finally {
        await session.close();
      }
    }
    throw new Error(`HydraDB query retry exhausted after ${maxAttempts} attempts`);
  }

  async close(): Promise<void> {
    await this.driver.close();
  }
}

export function hydraConfigFromEnv(): HydraConfig {
  return {
    uri: process.env.HYDRADB_URI ?? "bolt://127.0.0.1:17687",
    token: process.env.HYDRADB_TOKEN ?? "local-development-token-32-bytes",
    database: process.env.HYDRADB_GRAPH_ID ?? "default",
    timeoutMs: Number(process.env.HYDRADB_TIMEOUT_MS ?? 10_000),
  };
}
