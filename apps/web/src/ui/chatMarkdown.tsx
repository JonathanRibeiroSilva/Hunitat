/**
 * Markdown-lite rendering — `FR-5.14`, `FR-5.15`.
 *
 * Line breaks, `*emphasis*`, `**strong**`, `` `code` ``, clickable URLs, and
 * highlighted mentions. Nothing more: this is a chat line, not a document.
 *
 * ── Why there is no DOMPurify here ──────────────────────────────────────────
 *
 * The Phase 5 implementation notes suggest sanitising with DOMPurify, on the
 * grounds that "rendering untrusted text is the injection surface here". That
 * is exactly right about the risk and this file takes the stronger option: it
 * **never builds an HTML string at all**. The tokenizer emits React elements,
 * and React escapes every text node it renders. There is no
 * `dangerouslySetInnerHTML` for a sanitizer to stand in front of, so there is no
 * markup for a message to inject into.
 *
 * Sanitising is a filter over a dangerous representation. Not producing that
 * representation is better than filtering it, and it removes a dependency whose
 * bypasses are a recurring CVE class. The one attack this does not close for
 * free is the `javascript:` URL, because a link's `href` is an attribute rather
 * than a text node — so link protocols are allow-listed explicitly below, which
 * is the check DOMPurify would have been doing.
 *
 * The parser is deliberately not recursive. Emphasis inside a link inside code
 * is a document format's problem; here it would be a way to spend evaluation
 * time on a 2000-character message from someone who is not being friendly.
 */

import { Fragment, type ReactNode } from 'react';
import { scanMentions, type ChatMentionDto } from '@hubitat/protocol';

/**
 * Protocols a message may link to.
 *
 * An allow-list, not a block-list. `javascript:` is the one everybody
 * remembers; `data:` renders arbitrary documents, and `vbscript:` still works in
 * more places than it should. Anything not named here renders as plain text —
 * visible, inert, and obvious to whoever pasted it.
 */
const SAFE_PROTOCOLS = new Set(['http:', 'https:', 'mailto:']);

/** Bare `www.` is linked too, since people write it and mean a URL. */
const URL_PATTERN = /\b(?:https?:\/\/|www\.)[^\s<>()[\]{}"']+[^\s<>()[\]{}"'.,;:!?]/gi;

export interface ChatBodyProps {
  body: string;
  /** Resolved by the server, against the recipient set (`FR-5.15`). Never
   *  recomputed here — a client that found its own mentions would highlight
   *  names the server never notified. */
  mentions: readonly ChatMentionDto[];
  /** The reader's session id, so a mention *of them* reads differently from a
   *  mention of somebody else in the same line. */
  selfSessionId: string;
}

export function ChatBody({ body, mentions, selfSessionId }: ChatBodyProps): ReactNode {
  // `FR-5.14` — line breaks are the one piece of formatting every chat has.
  const lines = body.split('\n');

  return lines.map((line, index) => (
    <Fragment key={index}>
      {index > 0 && <br />}
      {renderLine(line, mentions, selfSessionId)}
    </Fragment>
  ));
}

/**
 * One line, in three passes: mentions, then links, then inline emphasis.
 *
 * Ordered by how much each pass can be fooled by the next. Mentions come from
 * the server with known names, so they are matched first and their spans are
 * taken off the table; links are matched against the remainder; emphasis runs
 * last, over what is left, where a stray asterisk can do no harm.
 */
function renderLine(
  line: string,
  mentions: readonly ChatMentionDto[],
  selfSessionId: string,
): ReactNode[] {
  const hits = scanMentions(
    line,
    mentions.map((mention) => mention.name),
  );

  const nodes: ReactNode[] = [];
  let cursor = 0;

  for (const [index, hit] of hits.entries()) {
    if (hit.start > cursor) {
      nodes.push(...renderLinks(line.slice(cursor, hit.start), `t${index}`));
    }
    const mentioned = mentions.find(
      (candidate) => candidate.name.toLowerCase() === hit.name.toLowerCase(),
    );
    nodes.push(
      <mark
        key={`m${index}`}
        className={
          mentioned?.sessionId === selfSessionId
            ? 'rounded bg-amber-400/25 px-1 font-medium text-amber-100'
            : 'rounded bg-sky-400/15 px-1 font-medium text-sky-200'
        }
      >
        {line.slice(hit.start, hit.end)}
      </mark>,
    );
    cursor = hit.end;
  }

  if (cursor < line.length) nodes.push(...renderLinks(line.slice(cursor), 'tail'));
  return nodes;
}

/** `FR-5.14` — URLs render as clickable links. */
function renderLinks(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let cursor = 0;

  // `matchAll` on a fresh regex each call: a `/g` literal carries `lastIndex`
  // between calls, and a shared one would skip matches in every second message.
  for (const match of text.matchAll(new RegExp(URL_PATTERN))) {
    const start = match.index ?? 0;
    const raw = match[0];
    const href = raw.startsWith('www.') ? `https://${raw}` : raw;

    if (!isSafeUrl(href)) continue;

    if (start > cursor)
      nodes.push(...renderEmphasis(text.slice(cursor, start), `${keyPrefix}p${start}`));
    nodes.push(
      <a
        key={`${keyPrefix}l${start}`}
        href={href}
        target="_blank"
        // `noopener` denies the opened page a handle on this window; `noreferrer`
        // keeps a private world's URL out of a stranger's analytics.
        rel="noopener noreferrer nofollow"
        className="break-all text-sky-300 underline decoration-sky-400/40 underline-offset-2
                   hover:text-sky-200 focus-visible:outline-none focus-visible:ring-2
                   focus-visible:ring-sky-300"
      >
        {raw}
      </a>,
    );
    cursor = start + raw.length;
  }

  if (cursor < text.length) nodes.push(...renderEmphasis(text.slice(cursor), `${keyPrefix}end`));
  return nodes;
}

function isSafeUrl(href: string): boolean {
  try {
    return SAFE_PROTOCOLS.has(new URL(href).protocol);
  } catch {
    return false;
  }
}

/** `**strong**`, `*emphasis*`, `` `code` `` — one pass, no nesting. */
const EMPHASIS_PATTERN = /(\*\*[^*\n]+\*\*|\*[^*\n]+\*|`[^`\n]+`)/g;

function renderEmphasis(text: string, keyPrefix: string): ReactNode[] {
  const parts = text.split(new RegExp(EMPHASIS_PATTERN));

  return parts.filter(Boolean).map((part, index) => {
    const key = `${keyPrefix}e${index}`;
    if (part.startsWith('**') && part.endsWith('**') && part.length > 4) {
      return (
        <strong key={key} className="font-semibold text-slate-100">
          {part.slice(2, -2)}
        </strong>
      );
    }
    if (part.startsWith('*') && part.endsWith('*') && part.length > 2) {
      return (
        <em key={key} className="italic">
          {part.slice(1, -1)}
        </em>
      );
    }
    if (part.startsWith('`') && part.endsWith('`') && part.length > 2) {
      return (
        <code key={key} className="rounded bg-black/40 px-1 py-0.5 font-mono text-[0.85em]">
          {part.slice(1, -1)}
        </code>
      );
    }
    // A plain string. React escapes it; nothing here builds markup from it.
    return <Fragment key={key}>{part}</Fragment>;
  });
}
