/**
 * `DC-8.3 Map Instance` — a live running copy of a Map.
 *
 * ── This is an object, not a container ──────────────────────────────────────
 *
 * "Spin up an instance" reads like provisioning. It is not, and the Phase 8
 * implementation notes are explicit about it: an instance is an object in this
 * process's memory holding a participant registry and a spatial grid
 * (ADR 0009). Creating one is an allocation; reaping one is dropping a
 * reference. That is what makes `FR-8.11` — "created and torn down based on
 * demand" — cost nothing, and it is what makes the registry authoritative
 * without coordination: with one process, the in-memory map *is* the complete
 * truth, so `FR-8.12`'s per-map counts are read rather than aggregated.
 *
 * The accepted cost is the standing one: this holds only while there is a single
 * `api` process.
 *
 * ── Instances share nothing ─────────────────────────────────────────────────
 *
 * `FR-8.10` requires participants in different instances of the same Map not to
 * see or hear each other, and the isolation here is **structural** rather than
 * enforced by a filter somewhere. Each instance has its own member set, its own
 * spatial grid and its own LiveKit room; there is no code path that could show
 * one instance's participant to another, because no query ever spans two.
 *
 * ── The document is frozen at allocation ────────────────────────────────────
 *
 * An instance keeps the Map Document it was created with, even if a newer
 * version is published while it is running. Zones, spawns and collision are what
 * the people standing in it have already loaded into their clients; swapping
 * them underneath would move private-zone boundaries under a conversation. The
 * next instance reads the new version, which is what makes publishing safe while
 * a world is occupied.
 */

import { SpatialGrid, type GridPoint } from '@hubitat/world-core';
import { instanceIdOf, instanceLabel, type MapDocument, type Zone } from '@hubitat/protocol';
import type { Participant } from './participant.js';
import type { MapRecord } from './map-registry.service.js';

export interface ParticipantPoint extends GridPoint {
  participant: Participant;
}

export class MapInstance {
  /** `<mapId>#<index>`. Derived rather than random, so a directory entry and a
   *  `NAVIGATE` naming it mean the same thing across a refresh. */
  readonly id: string;
  readonly mapId: string;
  readonly mapSlug: string;
  readonly index: number;
  readonly document: MapDocument;
  /** Session ids of everyone assigned here, connected or retained. Retained
   *  participants stay counted: they are resumable, and reaping the instance out
   *  from under one would strand a reconnect. */
  readonly members = new Set<string>();
  readonly grid: SpatialGrid<ParticipantPoint>;
  readonly createdAt = Date.now();

  /**
   * `FR-8.11` — when this instance last became empty, or null while somebody is
   * in it.
   *
   * Set when the member set empties and cleared the moment anybody is assigned,
   * which is what the Phase 8 Rules mean by "never reap while someone is
   * arriving": assignment takes a reference and clears this *before* the sweep
   * can see the instance as empty, so a joiner can never land in a reference
   * that is being dropped.
   */
  emptySince: number | null = Date.now();

  /**
   * The name the interface shows. Refreshed from the catalogue when a Map is
   * renamed, because an instance outlives an edit and "Head Office (2)" going
   * stale is exactly the confusion `FR-8.10` asks to be prevented.
   */
  mapName: string;

  constructor(map: MapRecord, index: number, cellSizeM: number) {
    this.id = instanceIdOf(map.id, index);
    this.mapId = map.id;
    this.mapSlug = map.slug;
    this.mapName = map.name;
    this.index = index;
    this.document = map.document;
    this.grid = new SpatialGrid<ParticipantPoint>(cellSizeM);
  }

  get zones(): readonly Zone[] {
    return this.document.zones;
  }

  /**
   * `FR-8.10` — one instance, one LiveKit room.
   *
   * The isolation is the SFU's as well as the world's: two people in different
   * instances are not subscribed to each other because they are not in the same
   * room, rather than because a filter decided not to tell them about each
   * other. A shared room with server-side subscription control would work until
   * the first bug in the control.
   *
   * Derived from the configured room name so a deployment that set
   * `LIVEKIT_ROOM` still recognises its own traffic, and from the *slug* rather
   * than the uuid so a room name in LiveKit's own logs is readable.
   */
  mediaRoom(baseRoom: string): string {
    return `${baseRoom}--${this.mapSlug}--${this.index}`;
  }

  label(instanceCount: number): string {
    return instanceLabel(this.mapName, this.index, instanceCount);
  }
}
