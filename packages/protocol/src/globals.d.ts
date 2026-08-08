/**
 * Ambient declarations for the WHATWG Encoding globals.
 *
 * `TextEncoder` and `TextDecoder` exist in both Node (11+) and every supported
 * browser, but TypeScript ships their types only in `lib.dom.d.ts`. Pulling in
 * the DOM lib here would let this package accidentally reference `document` or
 * `window`, and pulling in `@types/node` would let it reference `fs` — either
 * breaks the constraint that `@hubitat/protocol` runs unchanged in the browser,
 * the server and the bots (ADR 0001).
 *
 * So we declare exactly the two APIs we use, and nothing else.
 */

declare class TextEncoder {
  encode(input?: string): Uint8Array;
  readonly encoding: string;
}

declare class TextDecoder {
  constructor(label?: string, options?: { fatal?: boolean; ignoreBOM?: boolean });
  decode(input?: ArrayBuffer | ArrayBufferView): string;
  readonly encoding: string;
}
