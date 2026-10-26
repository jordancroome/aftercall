import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  extractSummary,
  fileName,
  isProcessable,
  noDashes,
  parseConfig,
  parseFollowUp,
  parseSort,
  renderNote,
  type Call,
} from "../src/core.ts";
import { readMeetings, readTranscript } from "../src/meetily.ts";

const config = parseConfig({
  me: { name: "Sam" },
  clients: [
    { slug: "acme", name: "Acme Co", contacts: [{ name: "Priya Shah", email: "priya@acme.example" }] },
    { slug: "globex", name: "Globex" },
  ],
});
const acme = config.clients[0];

describe("parseConfig", () => {
  it("needs a name to sign with", () => {
    expect(() => parseConfig({ me: {}, clients: [{ slug: "a", name: "A" }] })).toThrow(/me.name/);
  });
  it("rejects a bad or repeated slug", () => {
    expect(() => parseConfig({ me: { name: "S" }, clients: [{ slug: "Acme Co", name: "A" }] })).toThrow(/slug/);
    expect(() => parseConfig({ me: { name: "S" }, clients: [{ slug: "a", name: "A" }, { slug: "a", name: "B" }] })).toThrow(/twice/);
  });
  it("defaults contacts and notes", () => {
    expect(config.clients[1]).toEqual({ slug: "globex", name: "Globex", contacts: [], notes: "" });
  });
});

describe("Meetily rows", () => {
  const done = (title: string) => ({ id: "1", title, created_at: "2026-10-26T01:00:00Z", status: "completed", result: JSON.stringify({ markdown: "# Hi" }) });
  it("prefers the english_cache copy", () => {
    expect(extractSummary(JSON.stringify({ english_cache: { markdown: "A" }, markdown: "B" }))).toBe("A");
    expect(extractSummary("not json")).toBeNull();
  });
  it("never processes a private call", () => {
    expect(isProcessable(done("Kickoff with Acme"))).toBe(true);
    expect(isProcessable(done("Private: GP appointment"))).toBe(false);
    expect(isProcessable(done("confidential - legal"))).toBe(false);
  });
  it("skips a summary still running", () => {
    expect(isProcessable({ ...done("Acme"), status: "processing" })).toBe(false);
  });
});

describe("parseSort", () => {
  it("accepts a known slug", () => {
    expect(parseSort('{"client": "acme", "why": "named Acme"}', config.clients)).toEqual({ client: "acme", why: "named Acme" });
  });
  it("treats an invented slug as unsorted", () => {
    expect(parseSort('{"client": "initech", "why": "x"}', config.clients).client).toBeNull();
  });
  it("treats junk as unsorted", () => {
    expect(parseSort("I think it was Acme", config.clients).client).toBeNull();
  });
});

describe("parseFollowUp", () => {
  const reply = JSON.stringify({
    actions: [
      { owner: "me", task: "Send the scope — and a price", due: "2026-10-29" },
      { owner: "them", task: "Send five listings", due: "Wednesday" },
      { owner: "boss", task: "", due: null },
    ],
    email: { to: "priya shah", subject: "Trial – next steps", body: "Two to three weeks: 2–3 agents." },
    questions: ["Who approves drafts?"],
  });

  it("keeps real actions and drops empty ones", () => {
    const f = parseFollowUp(reply, acme)!;
    expect(f.actions).toEqual([
      { owner: "me", task: "Send the scope, and a price", due: "2026-10-29" },
      { owner: "them", task: "Send five listings", due: null },
    ]);
  });
  it("only addresses a known contact of the filed client", () => {
    expect(parseFollowUp(reply, acme)!.email.to?.email).toBe("priya@acme.example");
    expect(parseFollowUp(reply, null)!.email.to).toBeNull();
  });
  it("strips dashes from the draft", () => {
    const f = parseFollowUp(reply, acme)!;
    expect(f.email.subject).toBe("Trial, next steps");
    expect(f.email.body).toBe("Two to three weeks: 2 to 3 agents.");
  });
  it("returns null with no JSON", () => {
    expect(parseFollowUp("sorry", acme)).toBeNull();
  });
});

describe("renderNote", () => {
  const call: Call = { id: "x", title: "Kickoff: Acme / trial", date: "2026-10-26", summary: "We talked." };
  it("makes a safe file name", () => {
    expect(fileName(call)).toBe("2026-10-26 Kickoff Acme trial.md");
  });
  it("puts the draft under a not-sent heading and signs it", () => {
    const md = renderNote(call, { client: "acme", why: "named" }, acme, config.me, parseFollowUp(
      JSON.stringify({ actions: [], email: { to: "Priya Shah", subject: "S", body: "B" }, questions: [] }),
      acme,
    ));
    expect(md).toContain("## Draft follow-up (not sent)");
    expect(md).toContain("**To:** Priya Shah <priya@acme.example>");
    expect(md).toMatch(/B\n\nSam\n/);
  });
  it("does not sign twice when the draft already signs off", () => {
    const md = renderNote(call, { client: "acme", why: "named" }, acme, config.me, parseFollowUp(
      JSON.stringify({ actions: [], email: { to: null, subject: "S", body: "Thanks again,\nSam" }, questions: [] }),
      acme,
    ));
    expect(md.match(/Sam/g)).toHaveLength(1);
  });
});

describe("Meetily database", () => {
  it("reads meetings and the transcript in order, read-only", () => {
    const path = join(mkdtempSync(join(tmpdir(), "aftercall-")), "m.sqlite");
    const db = new DatabaseSync(path);
    db.exec(`
      create table meetings (id text primary key, title text, created_at text, updated_at text);
      create table summary_processes (meeting_id text primary key, status text, created_at text, updated_at text, result text);
      create table transcripts (id text primary key, meeting_id text, transcript text, timestamp text, audio_start_time real);
      insert into meetings values ('m1', 'Acme kickoff', '2026-10-26T01:00:00Z', '');
      insert into summary_processes values ('m1', 'completed', '', '', '{"markdown":"# Sum"}');
      insert into transcripts values ('t2', 'm1', 'second', '', 5), ('t1', 'm1', 'first', '', 1);
    `);
    db.close();
    const rows = readMeetings(path);
    expect(rows).toHaveLength(1);
    expect(isProcessable(rows[0])).toBe(true);
    expect(readTranscript(path, "m1")).toBe("first\nsecond");
  });
});

describe("noDashes", () => {
  it("turns ranges into 'to' and other dashes into commas", () => {
    expect(noDashes("30–40 listings — mostly spring")).toBe("30 to 40 listings, mostly spring");
  });
});
