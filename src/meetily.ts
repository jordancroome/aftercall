// Read Meetily's local database. Read-only: aftercall must never change Meetily.
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { MeetilyRow } from "./core.ts";

export const DEFAULT_DB = join(homedir(), "Library", "Application Support", "com.meetily.ai", "meeting_minutes.sqlite");

export function readMeetings(path: string): MeetilyRow[] {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return db
      .prepare(
        `select m.id, m.title, m.created_at, coalesce(s.status, 'none') as status, s.result
           from meetings m
           left join summary_processes s on s.meeting_id = m.id
          order by m.created_at desc`,
      )
      .all() as unknown as MeetilyRow[];
  } finally {
    db.close();
  }
}

/** The verbatim transcript, in order. Only read when --use-transcript asks for it. */
export function readTranscript(path: string, meetingId: string): string {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const rows = db
      .prepare(`select transcript from transcripts where meeting_id = ? order by coalesce(audio_start_time, 0), timestamp`)
      .all(meetingId) as { transcript: string }[];
    return rows.map((r) => r.transcript.trim()).filter(Boolean).join("\n");
  } finally {
    db.close();
  }
}
