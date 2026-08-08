/**
 * Chat — channel identity and mention resolution (phase 5).
 *
 * Separate from `messages.ts` because two of these are not schemas at all: the
 * channel id format and the mention scanner are *algorithms* the client and the
 * server must agree on exactly, and a disagreement in either is silent. A client
 * that spells the direct channel differently files replies into a thread nobody
 * is reading; a client that finds a mention the server did not highlights a name
 * that was never notified.
 *
 * Both are pure. This package imports no Node and no DOM APIs, which is what
 * lets the browser, the server and the bots share one definition (ADR 0001).
 */

import { z } from 'zod';

// ─────────────────────────────────────────────────────────────────────────────
// Scopes
// ─────────────────────────────────────────────────────────────────────────────

export const chatScopeSchema = z.enum(['room', 'nearby', 'zone', 'direct']);
export type ChatScope = z.infer<typeof chatScopeSchema>;

/**
 * `FR-5.11` — which scopes retain history, and which are delivered and forgotten.
 *
 * The list, not a boolean per message, because retention is a property of the
 * *channel* and `FR-5.13` is a guarantee about a channel rather than about the
 * message that happened to arrive. A per-message flag would let one ephemeral
 * message be stored by a caller that forgot to set it, and "ephemeral" is not a
 * property you can be mostly right about.
 *
 * `nearby` and `zone` are absent deliberately: their recipient set is a snapshot
 * of who was standing where at one instant (`FR-5.9`), so a stored copy could
 * only ever be replayed to the wrong audience.
 */
export const PERSISTENT_SCOPES: readonly ChatScope[] = ['room', 'direct'];

export function scopePersists(scope: ChatScope): boolean {
  return PERSISTENT_SCOPES.includes(scope);
}

// ─────────────────────────────────────────────────────────────────────────────
// Channel identity
//
// One string names a channel everywhere: on the wire, in the history store, in
// the read-state table and in the client's unread map. Deriving it from the
// scope plus its subject means the four places cannot drift.
// ─────────────────────────────────────────────────────────────────────────────

export const ROOM_CHANNEL_ID = 'room';
export const NEARBY_CHANNEL_ID = 'nearby';

export function zoneChannelId(zoneId: string): string {
  return `zone:${zoneId}`;
}

/**
 * The direct channel with one peer, named from the *reader's* point of view.
 *
 * Asymmetric on purpose: Ana's thread with Bea is `direct:<bea>` and Bea's is
 * `direct:<ana>`, so the server addresses each copy of a message to the channel
 * its recipient will look for it in. A shared, order-independent id (the pair,
 * sorted) reads as tidier and is wrong here — it would make the channel name
 * depend on who you are talking to *and* who you are, which the client would
 * then have to undo to show a thread list.
 */
export function directChannelId(peerSessionId: string): string {
  return `direct:${peerSessionId}`;
}

/**
 * The *storage* key for a direct conversation — order-independent.
 *
 * The counterpart to `directChannelId`, and the reason both exist. On the wire a
 * direct channel is named from the reader's side, because each side files the
 * thread under the other person. In storage it must be one row set shared by
 * both, or each participant would scroll back through only their own half of the
 * conversation. Sorting the two ids is what makes the key the same from either
 * end.
 */
export function directConversationKey(a: string, b: string): string {
  return a < b ? `dm:${a}|${b}` : `dm:${b}|${a}`;
}

/**
 * The *storage* key for a Map's room channel — phase 8.
 *
 * The counterpart to `ROOM_CHANNEL_ID`, and the reason both exist. On the wire
 * the room channel is called `room` and always has been: a client has exactly
 * one of them at a time, and renaming it per Map would break every stored read
 * marker for the sake of a string nobody looks at.
 *
 * In storage it has to name the Map, because a Space now has several and room
 * history belongs to the room. Two Maps sharing one key would put the meeting
 * room's conversation into the atrium's scrollback.
 *
 * ── Keyed by Map, not by Instance, and that is deliberate ───────────────────
 *
 * `FR-8.10` isolates instances from each other *live*: two copies of a room
 * cannot see or hear one another, and a message sent in one is not delivered to
 * the other. History is a different question. An instance is a capacity
 * mechanism with a lifetime measured in minutes (`FR-8.11` reaps empty ones),
 * and keying retained history to something that is reclaimed would mean walking
 * into a busy room and finding it had never been spoken in. The room remembers;
 * which copy of it you were standing in does not.
 */
export function roomChannelKey(mapId: string): string {
  return `room:${mapId}`;
}

export interface ParsedChannel {
  scope: ChatScope;
  /** Zone id for `zone`, peer session id for `direct`; absent otherwise. */
  targetId?: string;
}

/** Returns null for anything this build does not recognise, which a caller must
 *  treat as "no such channel" rather than guessing a scope. */
export function parseChannelId(channelId: string): ParsedChannel | null {
  if (channelId === ROOM_CHANNEL_ID) return { scope: 'room' };
  if (channelId === NEARBY_CHANNEL_ID) return { scope: 'nearby' };

  const separator = channelId.indexOf(':');
  if (separator <= 0) return null;
  const prefix = channelId.slice(0, separator);
  const targetId = channelId.slice(separator + 1);
  if (targetId.length === 0) return null;

  if (prefix === 'zone') return { scope: 'zone', targetId };
  if (prefix === 'direct') return { scope: 'direct', targetId };
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Mentions — FR-5.15
// ─────────────────────────────────────────────────────────────────────────────

export interface MentionCandidate {
  /** Instance-local id, so a highlight can be matched to a roster entry. */
  id: number;
  sessionId: string;
  name: string;
}

export interface MentionHit {
  /** Index of the `@`. */
  start: number;
  /** Index one past the last character of the matched name. */
  end: number;
  name: string;
}

/**
 * Every `@name` in the body that matches one of `names`.
 *
 * Matching against a supplied list rather than a pattern, because display names
 * contain spaces — "Guest 4821" is two tokens and `@\w+` finds "Guest". A
 * pattern would either stop at the space (mentioning nobody) or run to the end
 * of the line (mentioning everybody). So the scanner asks "does any known name
 * start here", longest first, which resolves "@Ana" and "@Ana Lima" standing in
 * one room to the longer of the two.
 *
 * Case-insensitive, and only at a word boundary: an email address is not four
 * mentions of whoever is called `example`.
 */
export function scanMentions(body: string, names: readonly string[]): MentionHit[] {
  // Longest first, so a prefix of another name never wins.
  const ordered = [...new Set(names.filter((name) => name.length > 0))].sort(
    (a, b) => b.length - a.length,
  );
  if (ordered.length === 0) return [];

  const lower = body.toLowerCase();
  const hits: MentionHit[] = [];

  for (let i = 0; i < body.length; i++) {
    if (body[i] !== '@') continue;
    // `a@b` is an address, not a mention of `b`.
    const before = i > 0 ? body[i - 1]! : ' ';
    if (/[\p{L}\p{N}_]/u.test(before)) continue;

    for (const name of ordered) {
      const start = i + 1;
      if (lower.startsWith(name.toLowerCase(), start)) {
        const end = start + name.length;
        // Refuse a partial match: "@Ana" must not fire for a person called
        // "Anabel" when the body reads "@Anabel".
        const after = end < body.length ? body[end]! : ' ';
        if (/[\p{L}\p{N}_]/u.test(after)) continue;
        hits.push({ start: i, end, name });
        i = end - 1;
        break;
      }
    }
  }

  return hits;
}

/**
 * The candidates actually mentioned in the body.
 *
 * **Callers must pass only eligible recipients.** Phase 5's Rules require that a
 * mention cannot leak a message outside its scope, and the only way to hold that
 * is to resolve mentions *after* the audience is known — passing the whole
 * roster and filtering afterwards is precisely the ordering that tells someone
 * out of range that a message about them exists.
 */
export function resolveMentions(
  body: string,
  candidates: readonly MentionCandidate[],
): MentionCandidate[] {
  const hits = scanMentions(
    body,
    candidates.map((candidate) => candidate.name),
  );
  if (hits.length === 0) return [];

  const byName = new Map<string, MentionCandidate>();
  // Later duplicates lose, so two people with identical display names resolve
  // to one of them deterministically rather than to both.
  for (const candidate of candidates) {
    const key = candidate.name.toLowerCase();
    if (!byName.has(key)) byName.set(key, candidate);
  }

  const resolved = new Map<string, MentionCandidate>();
  for (const hit of hits) {
    const candidate = byName.get(hit.name.toLowerCase());
    if (candidate) resolved.set(candidate.sessionId, candidate);
  }
  return [...resolved.values()];
}
