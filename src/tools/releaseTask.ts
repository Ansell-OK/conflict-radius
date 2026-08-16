import { z } from "zod";
import { ConflictRadar } from "../conflictRadar.js";

export const releaseTaskSchema = { agentId: z.string().min(1) };

export function releaseTask(radar: ConflictRadar, input: z.infer<z.ZodObject<typeof releaseTaskSchema>>) {
  return radar.releaseTask(input.agentId);
}
