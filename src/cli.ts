#!/usr/bin/env -S npx tsx
/**
 * aftercall: recorded call in, notes and a draft follow-up out.
 *
 *   npx tsx src/cli.ts                         every new Meetily call
 *   npx tsx src/cli.ts --file call.txt --title "Kickoff" [--date 2026-10-26]
 *
 * Options:
 *   --config <path>     clients file (default clients.yaml)
 *   --out <dir>         where notes go (default out)
 *   --db <path>         Meetily database (default: the macOS app's own)
 *   --use-transcript    also send Meetily's verbatim transcript to Claude (off by default)
 *   --redo              process calls that already have a note
 *   --dry               list what would be processed, call nothing
 *
 * Nothing is ever sent. Each call becomes one markdown file you read first.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  buildFollowUpPrompt,
  buildSortPrompt,
  buildSummaryPrompt,
  extractSummary,
  fileName,
  isProcessable,
  parseConfig,
  parseFollowUp,
  parseSort,
  renderNote,
  type Call,
} from "./core.ts";
import { ask } from "./llm.ts";
import { DEFAULT_DB, readMeetings, readTranscript } from "./meetily.ts";

function loadEnv() {
  if (!existsSync(".env")) return;
  for (const line of readFileSync(".env", "utf8").split("\n")) {
    const m = line.match(/^\s*([\w.]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

type State = Record<string, { client: string | null; file: string; at: string }>;

async function main() {
  loadEnv();
  const args = process.argv.slice(2);
  const configPath = flag(args, "config") ?? "clients.yaml";
  const outDir = flag(args, "out") ?? "out";
  const dbPath = flag(args, "db") ?? (process.env.MEETILY_DB || DEFAULT_DB);
  const file = flag(args, "file");
  const useTranscript = args.includes("--use-transcript");
  const redo = args.includes("--redo");
  const dry = args.includes("--dry");

  if (!existsSync(configPath)) {
    throw new Error(`No ${configPath}. Copy clients.example.yaml to clients.yaml and fill in your clients.`);
  }
  const config = parseConfig(parseYaml(readFileSync(configPath, "utf8")));

  // Gather the calls, from a file or from Meetily.
  let calls: (Call & { needsSummary?: boolean })[];
  if (file) {
    const transcript = readFileSync(file, "utf8");
    const title = flag(args, "title") ?? file.replace(/^.*\//, "").replace(/\.\w+$/, "");
    const date = flag(args, "date") ?? new Date().toISOString().slice(0, 10);
    const id = `file:${createHash("sha1").update(transcript).digest("hex").slice(0, 16)}`;
    calls = [{ id, title, date, summary: "", transcript, needsSummary: true }];
  } else {
    if (!existsSync(dbPath)) throw new Error(`No Meetily database at ${dbPath}. Has Meetily recorded anything here? Or use --file.`);
    calls = readMeetings(dbPath)
      .filter(isProcessable)
      .map((r) => ({ id: r.id, title: r.title, date: new Date(r.created_at).toISOString().slice(0, 10), summary: extractSummary(r.result)! }));
  }

  const statePath = join(outDir, ".aftercall-state.json");
  const state: State = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : {};
  const todo = calls.filter((c) => redo || !state[c.id]);
  console.log(`${calls.length} call(s) found, ${todo.length} to process`);
  if (dry) {
    for (const c of todo) console.log(`  ${c.date}  ${c.title}`);
    return;
  }
  if (todo.length && !process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY is not set. Put it in .env.");

  for (const call of todo) {
    if (call.needsSummary) call.summary = await ask(buildSummaryPrompt(call.transcript!), 1500);
    if (useTranscript && !file) call.transcript = readTranscript(dbPath, call.id);

    const sorted = parseSort(await ask(buildSortPrompt(call, config.clients), 300), config.clients);
    const client = config.clients.find((c) => c.slug === sorted.client) ?? null;
    const followUp = parseFollowUp(await ask(buildFollowUpPrompt(call, client, config.me, useTranscript || !!file), 2000), client);

    const dir = join(outDir, client?.slug ?? "unsorted");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, fileName(call));
    writeFileSync(path, renderNote(call, sorted, client, config.me, followUp));
    state[call.id] = { client: client?.slug ?? null, file: path, at: new Date().toISOString() };
    writeFileSync(statePath, JSON.stringify(state, null, 2));

    const n = followUp?.actions.length ?? 0;
    console.log(`  ${client ? client.name : "UNSORTED"}  ${call.title}  (${n} action item${n === 1 ? "" : "s"})  ${path}`);
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
