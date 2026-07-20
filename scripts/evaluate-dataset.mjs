import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { evaluateDataset } from "../packages/evaluation/dist/index.js";

const datasetPath = resolve(process.env.TRACEY_EVAL_DATASET ?? "evaluation/captured/production-baseline.v1.json");
const dataset = JSON.parse(await readFile(datasetPath, "utf8"));
const report = evaluateDataset(dataset);
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);

if (!report.gates.minimumDatasetSize.passed || !report.gates.allScenariosCovered || !report.gates.payloadIntegrity) {
  process.stderr.write("Evaluation release gates are incomplete or failed.\n");
  process.exitCode = 2;
}
