import { hasScope } from "@/lib/microsoft/config";
import { GraphError, type GraphClient } from "@/lib/microsoft/graph";

/**
 * Teams transcripts through Microsoft Graph, and what to do when there is none.
 *
 * What Graph actually offers (v1.0):
 * - Calendar events carry Teams metadata only (isOnlineMeeting, join URL).
 *   They never include recordings or transcripts.
 * - Transcripts: GET /me/onlineMeetings/{id}/transcripts and .../content in
 *   text/vtt, with speaker names. Delegated access needs
 *   OnlineMeetingTranscript.Read.All (admin consent), works only for meetings
 *   the signed-in user organized, only when transcription was turned on in
 *   Teams, and not for personal accounts.
 * - Recordings: .../recordings needs OnlineMeetingRecording.Read.All. We do not
 *   ask for it: the transcript is all the notes need, and not storing audio
 *   keeps retention and disclosure simpler.
 * - Non-Teams meetings (phone, on site, Zoom) have nothing to fetch.
 *
 * Every path that cannot produce a transcript returns a reason, and the UI
 * falls back to typed notes.
 */

export type TranscriptUnavailable =
  | "NO_CONSENT"
  | "SCOPE_NOT_GRANTED"
  | "NOT_A_TEAMS_MEETING"
  | "NOT_ORGANIZER"
  | "PERMISSION_DENIED"
  | "NO_TRANSCRIPT"
  | "MEETING_EXPIRED";

export interface Segment {
  start: string;
  end: string;
  speaker: string | null;
  text: string;
}

export type TranscriptFetch =
  | { ok: true; transcriptId: string; onlineMeetingId: string; segments: Segment[] }
  | { ok: false; reason: TranscriptUnavailable };

const CUE = /^(\d{2}:\d{2}:\d{2}\.\d{3})\s+-->\s+(\d{2}:\d{2}:\d{2}\.\d{3})/;

/** Parses Teams WebVTT. Speaker comes from <v Name> voice tags when present. */
export function parseVtt(vtt: string): Segment[] {
  const out: Segment[] = [];
  const blocks = vtt.replace(/\r/g, "").split(/\n\n+/);
  for (const block of blocks) {
    const lines = block.split("\n").filter(Boolean);
    const cueIndex = lines.findIndex((l) => CUE.test(l));
    if (cueIndex < 0) continue;
    const [, start, end] = lines[cueIndex].match(CUE)!;
    const raw = lines.slice(cueIndex + 1).join(" ");
    const voice = raw.match(/<v\s+([^>]+)>/);
    const text = raw.replace(/<\/?v[^>]*>/g, "").replace(/<[^>]+>/g, "").trim();
    if (!text) continue;
    const prev = out[out.length - 1];
    const speaker = voice?.[1]?.trim() ?? null;
    // Teams splits sentences into many short cues; merge runs by the same speaker.
    if (prev && prev.speaker === speaker) {
      prev.text = `${prev.text} ${text}`;
      prev.end = end;
    } else out.push({ start, end, speaker, text });
  }
  return out;
}

export function segmentsToText(segments: Segment[]): string {
  return segments.map((s) => `${s.speaker ? `${s.speaker}: ` : ""}${s.text}`).join("\n");
}

export async function fetchTeamsTranscript(
  graph: GraphClient,
  meeting: { isOnline: boolean; joinUrl: string | null; onlineMeetingId: string | null },
  grantedScopes: string[],
  hasConsent: boolean
): Promise<TranscriptFetch> {
  if (!hasConsent) return { ok: false, reason: "NO_CONSENT" };
  if (!hasScope(grantedScopes, "OnlineMeetingTranscript.Read.All")) return { ok: false, reason: "SCOPE_NOT_GRANTED" };
  if (!meeting.isOnline || !meeting.joinUrl) return { ok: false, reason: "NOT_A_TEAMS_MEETING" };

  try {
    const onlineMeetingId = meeting.onlineMeetingId ?? (await graph.findOnlineMeeting(meeting.joinUrl))?.id;
    // /me/onlineMeetings only returns meetings this user organized.
    if (!onlineMeetingId) return { ok: false, reason: "NOT_ORGANIZER" };
    const transcripts = await graph.listTranscripts(onlineMeetingId);
    if (!transcripts.length) return { ok: false, reason: "NO_TRANSCRIPT" };
    const latest = [...transcripts].sort((a, b) => b.createdDateTime.localeCompare(a.createdDateTime))[0];
    const vtt = await graph.transcriptVtt(onlineMeetingId, latest.id);
    return { ok: true, transcriptId: latest.id, onlineMeetingId, segments: parseVtt(vtt) };
  } catch (error) {
    if (error instanceof GraphError) {
      if (error.isPermissionDenied || error.status === 401) return { ok: false, reason: "PERMISSION_DENIED" };
      if (error.isNotFound) return { ok: false, reason: "NOT_ORGANIZER" };
      if (error.status === 410) return { ok: false, reason: "MEETING_EXPIRED" };
    }
    throw error;
  }
}

export const UNAVAILABLE_TEXT: Record<TranscriptUnavailable, string> = {
  NO_CONSENT: "Record transcription consent before importing a transcript.",
  SCOPE_NOT_GRANTED: "Transcript access is not enabled for this mailbox. An admin has to approve it; typed notes still work.",
  NOT_A_TEAMS_MEETING: "This is not a Teams meeting, so there is no transcript to import. Use typed notes.",
  NOT_ORGANIZER: "Microsoft only shares transcripts with the meeting organizer.",
  PERMISSION_DENIED: "Microsoft refused access to this transcript. Typed notes still work.",
  NO_TRANSCRIPT: "Teams has no transcript for this meeting. Transcription may not have been turned on.",
  MEETING_EXPIRED: "This Teams meeting has expired, so its transcript is no longer available.",
};
