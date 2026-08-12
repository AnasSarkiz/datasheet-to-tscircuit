import { expect, test } from "bun:test"
import {
  compareModelFitScores,
  modelFitSeriesKey,
  readModelFitParameterDeclarations,
  replaceModelFitParameters,
  scoreModelFitValidation,
  searchModelParameters,
} from "@/server/model-workflow/model-parameter-fit"
import type { ValidationRunResult } from "@/server/spice-validation"

test("numeric .param declarations are explicit, case-insensitive, and replaced without touching comments", () => {
  const source = [
    ".param LOOP_GAIN=2.5 ; tuned",
    ".PARAM tau = 1e-6",
    "B1 out 0 V={LOOP_GAIN*V(in)}",
    "* .param COMMENTED=9",
    "",
  ].join("\n")

  expect(readModelFitParameterDeclarations(source)).toEqual([
    { name: "LOOP_GAIN", value: 2.5 },
    { name: "tau", value: 1e-6 },
  ])
  const replaced = replaceModelFitParameters(source, { loop_gain: 3, TAU: 2e-6 })
  expect(replaced).toContain(".param LOOP_GAIN=3e+0 ; tuned")
  expect(replaced).toContain(".PARAM tau = 2e-6")
  expect(replaced).toContain("* .param COMMENTED=9")
})

test("bounded parameter search explores globally and refines deterministically", async () => {
  const source = ".param A=0.1\n.param B=10\n"
  const result = await searchModelParameters({
    source,
    ranges: [
      { name: "A", min: -2, max: 2, scale: "linear" },
      { name: "B", min: 1, max: 100, scale: "log" },
    ],
    max_evaluations: 48,
    evaluate: async (candidate) => {
      const values = Object.fromEntries(
        readModelFitParameterDeclarations(candidate).map(({ name, value }) => [name, value]),
      )
      const error = Math.abs(values.A - 1.1) + Math.abs(Math.log(values.B / 20))
      return {
        runnable: true,
        failed_series_count: error > 0.1 ? 1 : 0,
        worst_normalized_max_error: error,
        mean_normalized_rmse: error / 2,
      }
    },
  })

  expect(result.evaluations).toBeLessThanOrEqual(48)
  expect(result.best.score.worst_normalized_max_error).toBeLessThan(0.18)
  expect(result.best.values.A).toBeGreaterThan(0.9)
  expect(result.best.values.A).toBeLessThan(1.3)
  expect(result.best.values.B).toBeGreaterThan(16)
  expect(result.best.values.B).toBeLessThan(25)
  expect(result.improvements.length).toBeGreaterThan(1)
})

test("bounded fitting moves a synthetic first-order time constant toward the known target", async () => {
  const target_tau = 1e-3
  const sample_times = [2.5e-4, 5e-4, 1e-3, 2e-3, 4e-3]
  const target = sample_times.map((time) => 1 - Math.exp(-time / target_tau))
  const result = await searchModelParameters({
    source: ".param TAU_MAIN=5e-3\n",
    ranges: [{ name: "TAU_MAIN", min: 2e-4, max: 1e-2, scale: "log" }],
    max_evaluations: 32,
    evaluate: async (candidate) => {
      const tau = readModelFitParameterDeclarations(candidate)[0]!.value
      const errors = sample_times.map((time, index) => Math.abs(1 - Math.exp(-time / tau) - target[index]!))
      const rmse = Math.sqrt(errors.reduce((sum, value) => sum + value ** 2, 0) / errors.length)
      return {
        runnable: true,
        failed_series_count: Math.max(...errors) > 0.05 ? 1 : 0,
        worst_normalized_max_error: Math.max(...errors),
        mean_normalized_rmse: rmse,
      }
    },
  })

  expect(result.best.score.mean_normalized_rmse).toBeLessThan(result.initial.score.mean_normalized_rmse)
  expect(result.best.values.TAU_MAIN).toBeGreaterThan(8e-4)
  expect(result.best.values.TAU_MAIN).toBeLessThan(1.25e-3)
})

test("fit scoring rejects simulator failures before comparing numeric residuals", () => {
  const validation = (runnable: boolean, normalized_error: number): ValidationRunResult => ({
    version: 1,
    passed: false,
    hashes: {
      plan_sha256: "a".repeat(64),
      model_sha256: "b".repeat(64),
      manifest_sha256: "c".repeat(64),
    },
    cases: [
      {
        case_id: "transient",
        status: "failed",
        analysis: "transient",
        series: [
          {
            observation_id: "vout",
            type: "voltage",
            unit: "V",
            scale: "linear",
            points: [],
            metrics: {
              sample_count: 1,
              normalized_max_error: normalized_error,
              normalized_rmse: normalized_error / 2,
            },
            passed: false,
            errors: [],
          },
        ],
        errors: [],
        elapsed_ms: 1,
        netlist_sha256: "d".repeat(64),
      },
    ],
    errors: runnable ? [] : [{ kind: "simulator", code: "failed", message: "not runnable" }],
  })
  const stable = scoreModelFitValidation(validation(true, 0.4))
  const broken = scoreModelFitValidation(validation(false, 0.01))

  expect(stable.runnable).toBe(true)
  expect(broken.runnable).toBe(false)
  expect(compareModelFitScores(stable, broken)).toBeLessThan(0)
})

test("fit scoring can exclude server-owned stimulus series from the parameter objective", () => {
  const series = (observation_id: string, normalized_error: number) => ({
    observation_id,
    type: "voltage" as const,
    unit: "V" as const,
    scale: "linear" as const,
    points: [],
    metrics: {
      sample_count: 1,
      normalized_max_error: normalized_error,
      normalized_rmse: normalized_error / 2,
    },
    passed: normalized_error <= 0.1,
    errors: [],
  })
  const result: ValidationRunResult = {
    version: 1,
    passed: false,
    hashes: {
      plan_sha256: "a".repeat(64),
      model_sha256: "b".repeat(64),
      manifest_sha256: "c".repeat(64),
    },
    cases: [
      {
        case_id: "transient",
        status: "failed",
        analysis: "transient",
        series: [series("vout", 0.2), series("vin_stimulus", 1.5)],
        errors: [],
        elapsed_ms: 1,
        netlist_sha256: "d".repeat(64),
      },
    ],
    errors: [],
  }

  expect(
    scoreModelFitValidation(result, {
      included_series: new Set([modelFitSeriesKey("transient", "vout")]),
    }),
  ).toEqual({
    runnable: true,
    failed_series_count: 1,
    worst_normalized_max_error: 0.2,
    mean_normalized_rmse: 0.1,
  })
})

test("fit scoring prefers more passing public series before smaller residuals", () => {
  expect(
    compareModelFitScores(
      {
        runnable: true,
        failed_series_count: 0,
        worst_normalized_max_error: 0.2,
        mean_normalized_rmse: 0.1,
      },
      {
        runnable: true,
        failed_series_count: 1,
        worst_normalized_max_error: 0.01,
        mean_normalized_rmse: 0.005,
      },
    ),
  ).toBeLessThan(0)
})

test("fitting rejects validation-coordinate parameter names", async () => {
  await expect(
    searchModelParameters({
      source: ".SUBCKT X A B\n.param graph7_t3=1\nB1 B 0 V={graph7_t3*V(A)}\n.ENDS X\n",
      ranges: [{ name: "graph7_t3", min: 0.5, max: 2, scale: "linear" }],
      max_evaluations: 3,
      evaluate: async () => ({
        runnable: true,
        failed_series_count: 0,
        worst_normalized_max_error: 0,
        mean_normalized_rmse: 0,
      }),
    }),
  ).rejects.toThrow("physically meaningful model parameters")
})

test("fitted R/C/L parameters require a positive search domain", async () => {
  await expect(
    searchModelParameters({
      source: ".SUBCKT X A B\n.param R_VALUE=10\nR1 A B {R_VALUE}\n.ENDS X\n",
      ranges: [{ name: "R_VALUE", min: -1, max: 20, scale: "linear" }],
      max_evaluations: 3,
      evaluate: async () => ({
        runnable: true,
        failed_series_count: 0,
        worst_normalized_max_error: 0,
        mean_normalized_rmse: 0,
      }),
    }),
  ).rejects.toThrow("strictly positive lower bound")
})
