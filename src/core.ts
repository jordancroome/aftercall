// The pure half of aftercall: config, prompts, parsing and the note itself.
//
// Everything here is a plain function over plain data, so the behaviour that
// matters (which client a call is filed under, what the draft says it will do)
// is testable without a recorder, a database or an API key. cli.ts does the IO.

export type Contact = { name: string; email?: string };
export type Client = { slug: string; name: string; contacts: Contact[]; notes: string };
export type Me = { name: string; business: string; voice: string };
export type Config = { me: Me; clients: Client[] };

/** One call, from whichever source. `summary` is always present by the time we sort. */
export type Call = {
  id: string;
  title: string;
  /** YYYY-MM-DD, the day the call happened. */
  date: string;
  summary: string;
  transcript?: string;
};

export type Sorted = { client: string | null; why: string };

export type Action = { owner: "me" | "them"; task: string; due: string | null };
export type FollowUp = {
  actions: Action[];
  email: { to: Contact | null; subject: string; body: string };
  questions: string[];
};

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const SLUG = /^[a-z0-9][a-z0-9-]*$/;

/** Validate clients.yaml once, up front, with errors a person can act on. */
export function parseConfig(raw: unknown): Config {
  const fail = (msg: string): never => {
    throw new Error(`clients.yaml: ${msg}`);
  };
  if (!raw || typeof raw !== "object") fail("is empty or not a mapping");
  const o = raw as Record<string, unknown>;

  const meRaw = (o.me ?? {}) as Record<string, unknown>;
  const name = str(meRaw.name);
  if (!name) fail("me.name is missing. It signs the draft emails.");
  const me: Me = { name, business: str(meRaw.business), voice: str(meRaw.voice) };

  if (!Array.isArray(o.clients) || o.clients.length === 0) fail("clients is missing or empty");
  const seen = new Set<string>();
  const clients = (o.clients as unknown[]).map((c, i) => {
    const r = (c ?? {}) as Record<string, unknown>;
    const slug = str(r.slug);
    if (!SLUG.test(slug)) fail(`clients[${i}].slug '${slug}' must be lower case letters, numbers and hyphens`);
    if (seen.has(slug)) fail(`clients[${i}].slug '${slug}' is used twice`);
    seen.add(slug);
    const clientName = str(r.name);
    if (!clientName) fail(`clients[${i}].name is missing`);
    const contacts = Array.isArray(r.contacts)
      ? (r.contacts as unknown[]).map((k) => {
          const kr = (k ?? {}) as Record<string, unknown>;
          return { name: str(kr.name), email: str(kr.email) || undefined };
        }).filter((k) => k.name)
      : [];
    return { slug, name: clientName, contacts, notes: str(r.notes) };
  });
  return { me, clients };
}

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

// ---------------------------------------------------------------------------
// Meetily
// ---------------------------------------------------------------------------

/** A row out of Meetily's sqlite, joined to its summary process. */
export type MeetilyRow = { id: string; title: string; created_at: string; status: string; result: string | null };

/**
 * Pull the markdown report out of summary_processes.result.
 *
 * Meetily writes {"english_cache": {"markdown": "..."}, "markdown": "..."}. The
 * english_cache copy is the one its UI shows. Fall back to the top-level key so
 * a shape change upstream degrades to "still works", not to silence.
 */
export function extractSummary(result: string | null): string | null {
  if (!result) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(result);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const o = parsed as Record<string, unknown>;
  const cache = o.english_cache as Record<string, unknown> | undefined;
  const md = (cache && typeof cache.markdown === "string" && cache.markdown) || (typeof o.markdown === "string" && o.markdown);
  const text = typeof md === "string" ? md.trim() : "";
  return text.length ? text : null;
}

/**
 * Calls that must never leave the machine: the title starts with private,
 * personal or confidential. The title is set before or during the recording,
 * which is the one moment that decision is reliably made. Deliberately not a
 * list of sensitive words: guessing at what is sensitive is not the tool's call.
 */
const PRIVATE_PREFIX = /^\s*(private|personal|confidential)\b[:\s-]*/i;

export function isPrivate(title: string | null | undefined): boolean {
  return PRIVATE_PREFIX.test(title ?? "");
}

/** Only a completed, non-private summary is worth anything. A private one is never read. */
export function isProcessable(row: MeetilyRow): boolean {
  if (isPrivate(row.title)) return false;
  return row.status === "completed" && extractSummary(row.result) !== null;
}

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

/** Trim to a character budget without cutting mid-line. */
export function truncate(md: string, maxChars: number): string {
  if (md.length <= maxChars) return md;
  const cut = md.slice(0, maxChars);
  const lastBreak = cut.lastIndexOf("\n");
  const body = lastBreak > maxChars * 0.5 ? cut.slice(0, lastBreak) : cut;
  return `${body.trimEnd()}\n(truncated)`;
}

const NO_DASHES = "Never use em dashes or en dashes. Use a comma, a full stop or brackets instead.";

/** Used only for a transcript file. Meetily summarises on the machine itself. */
export function buildSummaryPrompt(transcript: string): string {
  return [
    "Summarise this call transcript for the person who was on it.",
    "",
    "Write markdown with three short sections: ## Summary (two or three sentences),",
    "## Decisions (bullets), ## Mentioned (bullets: names, numbers, dates, tools, anything specific).",
    "Only write what was said. Do not add advice.",
    NO_DASHES,
    "",
    "TRANSCRIPT",
    truncate(transcript, 60000),
  ].join("\n");
}

export function buildSortPrompt(call: Call, clients: Client[]): string {
  const lines = ["Which client was this call with?", "", "CLIENTS"];
  for (const c of clients) lines.push(`- ${c.slug}: ${c.name}${c.notes ? ` (${truncate(c.notes, 200).replace(/\n/g, " ")})` : ""}`);
  lines.push("", `CALL TITLE: ${call.title}`, `DATE: ${call.date}`, "", "SUMMARY", truncate(call.summary, 3000), "");
  lines.push('Reply with JSON only: {"client": "<slug>" or null, "why": "<one short sentence>"}');
  lines.push(
    "Use null when you are not confident. A call filed under the wrong client sends the follow-up to the wrong " +
      "people, which is worse than leaving it unsorted for a person to file.",
  );
  lines.push(NO_DASHES);
  return lines.join("\n");
}

/** Validate the sort. A slug the model invented is treated as a refusal. */
export function parseSort(text: string, clients: Client[]): Sorted {
  const decline = (why: string): Sorted => ({ client: null, why });
  const json = firstJson(text);
  if (!json) return decline("the model returned no JSON");
  const why = str(json.why);
  const slug = str(json.client);
  if (!slug || slug === "null") return decline(why || "not confident which client this was");
  if (!clients.some((c) => c.slug === slug)) return decline(`the model said '${slug}', which is not in clients.yaml`);
  return { client: slug, why: why || "sorted automatically" };
}

export function buildFollowUpPrompt(call: Call, client: Client | null, me: Me, useTranscript: boolean): string {
  const lines = [
    `You are drafting for ${me.name}${me.business ? ` (${me.business})` : ""}, straight after a call.`,
    "Work out what each side said they would do, and draft the follow-up email.",
    "",
  ];
  if (client) {
    lines.push(`CLIENT: ${client.name}`);
    if (client.notes) lines.push(`ABOUT THEM: ${client.notes}`);
    if (client.contacts.length) lines.push(`CONTACTS: ${client.contacts.map((c) => c.name).join(", ")}`);
  } else {
    lines.push("CLIENT: unknown. Do not guess a name.");
  }
  lines.push("", `CALL: ${call.title}`, `DATE OF CALL: ${call.date}`, "", "SUMMARY", truncate(call.summary, 6000));
  if (useTranscript && call.transcript) lines.push("", "TRANSCRIPT", truncate(call.transcript, 50000));
  lines.push("");
  lines.push("Rules:");
  lines.push(`- Only include commitments somebody actually made on the call. Never invent a promise for ${me.name}.`);
  lines.push("- owner is \"me\" for the person you are drafting for, \"them\" for the client.");
  lines.push("- due is YYYY-MM-DD only when a day was said or clearly implied, worked out from the date of the call. Otherwise null.");
  lines.push("- The email thanks them briefly, confirms what was agreed and who does what, and asks any open question. Short. No sign-off line, it is added after.");
  lines.push("- to is the contact the email is for, using a name from CONTACTS exactly, or null.");
  lines.push(`- ${NO_DASHES}`);
  if (me.voice) lines.push("", "HOW I WRITE", me.voice);
  lines.push(
    "",
    'Reply with JSON only: {"actions": [{"owner": "me" | "them", "task": "...", "due": "YYYY-MM-DD" | null}], ' +
      '"email": {"to": "<contact name>" | null, "subject": "...", "body": "..."}, "questions": ["anything the call left open"]}',
  );
  return lines.join("\n");
}

/**
 * Parse and tidy the draft. Anything malformed becomes empty rather than
 * throwing, because a half-useful note is better than no note, and the person
 * reads it before anything is sent.
 */
export function parseFollowUp(text: string, client: Client | null): FollowUp | null {
  const json = firstJson(text);
  if (!json) return null;
  const actions: Action[] = Array.isArray(json.actions)
    ? (json.actions as unknown[]).flatMap((a) => {
        const r = (a ?? {}) as Record<string, unknown>;
        const task = noDashes(str(r.task));
        if (!task) return [];
        const owner = r.owner === "them" ? "them" : "me";
        const due = /^\d{4}-\d{2}-\d{2}$/.test(str(r.due)) ? str(r.due) : null;
        return [{ owner, task, due } as Action];
      })
    : [];
  const e = (json.email ?? {}) as Record<string, unknown>;
  // The recipient must be a known contact of the client this call was filed under.
  const toName = str(e.to);
  const to = client?.contacts.find((c) => c.name.toLowerCase() === toName.toLowerCase()) ?? null;
  const questions = Array.isArray(json.questions) ? (json.questions as unknown[]).map((q) => noDashes(str(q))).filter(Boolean) : [];
  return { actions, email: { to, subject: noDashes(str(e.subject)), body: noDashes(str(e.body)) }, questions };
}

function firstJson(text: string): Record<string, unknown> | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const v = JSON.parse(text.slice(start, end + 1));
    return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Belt and braces on the no-dash rule: a range becomes "to", anything else a comma. */
export function noDashes(s: string): string {
  return s
    .replace(/(\d)\s*[–—]\s*(\d)/g, "$1 to $2")
    .replace(/\s*[–—]\s*/g, ", ");
}

// ---------------------------------------------------------------------------
// The note
// ---------------------------------------------------------------------------

export function fileName(call: Call): string {
  const safe = call.title.replace(/[\\/:*?"<>|]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 80) || "call";
  return `${call.date} ${safe}.md`;
}

export function renderNote(call: Call, sorted: Sorted, client: Client | null, me: Me, followUp: FollowUp | null): string {
  const out: string[] = [];
  out.push(`# ${call.title}`, "");
  out.push(`**Date:** ${call.date}  `);
  out.push(`**Client:** ${client ? client.name : "Unsorted"} (${sorted.why})`, "");

  if (followUp) {
    const mine = followUp.actions.filter((a) => a.owner === "me");
    const theirs = followUp.actions.filter((a) => a.owner === "them");
    const item = (a: Action) => `- [ ] ${a.task}${a.due ? ` (by ${a.due})` : ""}`;
    out.push("## I said I would", ...(mine.length ? mine.map(item) : ["- Nothing"]), "");
    out.push("## They said they would", ...(theirs.length ? theirs.map(item) : ["- Nothing"]), "");
    if (followUp.questions.length) out.push("## Still open", ...followUp.questions.map((q) => `- ${q}`), "");

    const to = followUp.email.to;
    out.push("## Draft follow-up (not sent)", "");
    out.push(`**To:** ${to ? `${to.name}${to.email ? ` <${to.email}>` : ""}` : "(choose a recipient)"}  `);
    out.push(`**Subject:** ${followUp.email.subject}`, "");
    // The prompt asks for no sign-off, but models add one anyway. Only sign when it has not.
    const body = followUp.email.body;
    const signed = new RegExp(`\\b${me.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`).test(body);
    out.push(body, "", ...(signed ? [] : [me.name, ""]));
  } else {
    out.push("_No follow-up drafted: the draft step returned nothing usable. Run again with --redo._", "");
  }

  out.push("## Call notes", "", call.summary, "");
  return out.join("\n");
}
