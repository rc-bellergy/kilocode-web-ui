/**
 * Jev eval runner: run the labelled corpus (scripts/jev-eval-corpus.jsonl)
 * through the SAME router call the server makes — imports server/src/env.js
 * (repo .env) and server/src/jev.ts's redactSecrets + classifyScores — and
 * writes scripts/jev-eval-results.jsonl with one
 * {"command", "expected", "tag", "scores", "model", "error"} row per line.
 * Risk mapping, the blocklist and threshold sweeps happen in
 * scripts/jev-eval-report.ts so they share the production logic.
 *
 * Manual, real REQUESTY_JEV_KEY + network; run via `npm run eval:jev`
 * (never in CI/e2e).
 */

import "../server/src/env.js"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { classifyScores, redactSecrets, type JevRisk } from "../server/src/jev.js"

interface CorpusRow {
  command: string
  expected: JevRisk
  tag?: string
}

const HERE = path.dirname(fileURLToPath(import.meta.url))
const corpusFile = path.join(HERE, "jev-eval-corpus.jsonl")
const resultsFile = path.join(HERE, "jev-eval-results.jsonl")

const corpus = fs
  .readFileSync(corpusFile, "utf8")
  .split("\n")
  .filter(Boolean)
  .map((line) => JSON.parse(line) as CorpusRow)

if (corpus.length === 0) {
  console.error(`no rows in ${corpusFile}`)
  process.exit(2)
}
if (!process.env.REQUESTY_JEV_KEY && process.env.JEV_MOCK !== "1") {
  console.error("REQUESTY_JEV_KEY not set; put it in .env or export it first")
  process.exit(2)
}
if (process.env.JEV_MOCK === "1") {
  console.error(
    "WARNING: JEV_MOCK=1 — rows will carry synthetic mock scores, NOT real model output; do not tune JEV_T_* against them",
  )
}

const rows: Record<string, unknown>[] = []
let failures = 0
for (const item of corpus) {
  const row: Record<string, unknown> = { command: item.command, expected: item.expected, tag: item.tag ?? "" }
  try {
    const { scores, model } = await classifyScores(redactSecrets(item.command))
    row.scores = scores
    row.model = model
  } catch (err) {
    row.scores = null
    row.model = null
    row.error = err instanceof Error ? err.message : String(err)
    failures++
  }
  rows.push(row)
  console.error(`[${rows.length}/${corpus.length}] ${item.expected.padEnd(6)} ${item.command.slice(0, 60)}`)
}

fs.writeFileSync(resultsFile, `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`)
console.error(`wrote ${rows.length} rows to ${resultsFile} (${failures} call failures)`)
