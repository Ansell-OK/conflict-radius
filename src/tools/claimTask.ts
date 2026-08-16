import { z } from "zod";
import { ConflictRadar } from "../conflictRadar.js";

export const claimTaskSchema = {
  agentId: z.string().min(1).describe("A stable identifier for this agent/session."),
  taskDescription: z.string().min(1),
  symbols: z.array(z.string()).optional(),
  files: z.array(z.string()).optional(),
};

export function claimTask(radar: ConflictRadar, input: z.infer<z.ZodObject<typeof claimTaskSchema>>) {
  return radar.claimTask(input);
}
