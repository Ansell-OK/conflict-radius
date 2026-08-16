import { z } from "zod";
import { ConflictRadar } from "../conflictRadar.js";

export const checkConflictsSchema = {
  agentId: z.string().min(1),
  mode: z.enum(["causal", "strong"]).default("causal"),
};

export function checkConflicts(radar: ConflictRadar, input: z.infer<z.ZodObject<typeof checkConflictsSchema>>) {
  return radar.checkConflicts(input.agentId, input.mode);
}
