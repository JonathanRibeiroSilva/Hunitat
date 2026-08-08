/**
 * `FR-10.2`, `FR-10.4` — which interactive object is in reach.
 *
 * A component inside the scene rather than a hook in the HUD, because the answer
 * changes as somebody walks and the only place that is known per frame is inside
 * `useFrame`. It writes one value into a store and renders nothing.
 *
 * ── Why it is throttled, and why that is not a compromise ───────────────────
 *
 * The test runs at 10 Hz rather than per frame. An interaction range is 2.5 m
 * and a run is 6 m/s, so a hundred milliseconds is 60 cm of travel — well inside
 * the range's own tolerance, and the prompt appears while you are still walking
 * towards the thing. Per frame it would be the same answer sixty times a second,
 * and `NFR-12`'s frame budget is not spent on re-deciding a fact that changes at
 * walking pace.
 *
 * ── One prompt, and the same range for every type ───────────────────────────
 *
 * `FR-10.4` asks for the affordance to be "consistent and discoverable across
 * object types", which is why the range comes from one constant with a per-object
 * override rather than from each content type. A video screen you have to stand
 * closer to than a poster is a rule nobody can learn.
 */

import { useFrame } from '@react-three/fiber';
import { useRef } from 'react';
import { INTERACT_RANGE_M, type MapDocument } from '@hubitat/protocol';
import { net } from '../net/client.js';
import { useInteractStore } from '../state/interactStore.js';

const CHECK_INTERVAL_S = 0.1;

export function Proximity({ document }: { document: MapDocument }) {
  const elapsed = useRef(0);

  useFrame((_, delta) => {
    elapsed.current += delta;
    if (elapsed.current < CHECK_INTERVAL_S) return;
    elapsed.current = 0;

    // The client's own position, which it is authoritative over (ADR 0004) and
    // which the send loop is already sampling. No round trip, no tick latency.
    const me = net.localTransform;

    let best: { object: MapDocument['objects'][number]; distanceM: number } | null = null;

    for (const object of document.objects) {
      const interactive = object.interactive;
      if (!interactive) continue;

      const range = interactive.interactionRangeM ?? INTERACT_RANGE_M;
      const dx = me.x - object.transform.position.x;
      const dy = me.y - object.transform.position.y;
      const dz = me.z - object.transform.position.z;
      const squared = dx * dx + dy * dy + dz * dz;
      if (squared > range * range) continue;

      const distanceM = Math.sqrt(squared);
      // Nearest wins. The Rules' "not every object at once" is this comparison;
      // without it a wall of posters offers nine prompts and reads as noise.
      if (!best || distanceM < best.distanceM) best = { object, distanceM };
    }

    useInteractStore.getState().setNearest(best);
  });

  return null;
}
