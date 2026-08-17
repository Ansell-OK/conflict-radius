import { cp, mkdir } from "node:fs/promises";

await mkdir("dist/extractor/queries", { recursive: true });
await cp("extractor/queries", "dist/extractor/queries", { recursive: true });
