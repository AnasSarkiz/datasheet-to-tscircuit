import { join } from "node:path"
import { createTscircuitRuntimeConfig } from "./tscircuit-runtime-config"

export async function ensureJobTscircuitRuntimeConfig(
  job_dir: string,
  input?: { schematic_disabled?: boolean },
): Promise<void> {
  await Bun.write(join(job_dir, "tscircuit.config.ts"), createTscircuitRuntimeConfig(input))
}
