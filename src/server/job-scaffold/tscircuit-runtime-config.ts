const local_engine_url = new URL("./local-ngspice-engine.ts", import.meta.url).href

export function createTscircuitRuntimeConfig(input?: { schematic_disabled?: boolean }): string {
  return `import { createLocalNgspiceSpiceEngine } from ${JSON.stringify(local_engine_url)}

const ngspiceSpiceEngine = await createLocalNgspiceSpiceEngine()

export default {
  platformConfig: {
    ${input?.schematic_disabled ? "schematicDisabled: true," : ""}
    spiceEngineMap: {
      ngspice: ngspiceSpiceEngine,
    },
  },
}
`
}

export const TSCIRCUIT_RUNTIME_CONFIG = createTscircuitRuntimeConfig()
