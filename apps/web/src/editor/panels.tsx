/**
 * The editor's panels — library, outliner, inspector, environment, versions.
 *
 * Four requirements share this file because they share one rule: **nothing here
 * writes the document directly**. Every control calls `apply` with a pure
 * function, which is what makes `FR-9.2`'s undo cover zone and property edits
 * rather than only transforms. The phase notes name partial undo as the way this
 * ships broken; one door is how it is prevented rather than remembered.
 */

import { useCallback, useRef, useState } from 'react';
import { Panel, cn } from '@hubitat/ui';
import {
  ASSET_MAX_BYTES,
  CONTENT_TYPES,
  INTERACT_RANGE_M,
  type AssetDto,
  type PlacedObject,
  type Zone,
} from '@hubitat/protocol';
import { auth } from '../auth/authClient.js';
import {
  addSpawn,
  duplicateObject,
  makeDefaultSpawn,
  placeObject,
  removeObject,
  removeSpawn,
  removeZone,
  setObjectGroup,
  updateEnvironment,
  updateObject,
  updateZone,
  useEditorStore,
} from './editorStore.js';

// ─────────────────────────────────────────────────────────────────────────────
// DC-9.4 — the asset library
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `FR-9.11`, `FR-9.14`, `FR-9.15`.
 *
 * The upload is three steps and only the middle one is slow: ask for a presigned
 * `PUT`, send the bytes **straight to object storage**, then tell the server they
 * landed. The api never sees the file, which is what keeps a 40 MB model from
 * being buffered through a process running a 20 Hz world tick.
 */
export function LibraryPanel({ spaceSlug }: { spaceSlug: string }) {
  const assets = useEditorStore((store) => store.assets);
  const apply = useEditorStore((store) => store.apply);
  const notify = useEditorStore((store) => store.notify);
  const setError = useEditorStore((store) => store.setError);

  const [uploading, setUploading] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);

  const upload = useCallback(
    async (file: File) => {
      if (file.size > ASSET_MAX_BYTES) {
        setError(
          `That file is ${(file.size / 1048576).toFixed(1)} MB. The limit is ` +
            `${(ASSET_MAX_BYTES / 1048576).toFixed(0)} MB.`,
        );
        return;
      }

      setUploading(file.name);
      try {
        const ticket = await auth.requestAssetUpload(spaceSlug, {
          kind: 'model',
          name: file.name,
          // `.glb` is not a type browsers know, so most of them report nothing.
          // The server's list accepts the octet-stream fallback and the worker
          // is what actually decides whether it is a model (`FR-9.12`).
          contentType: file.type || 'model/gltf-binary',
          bytes: file.size,
        });

        // The headers are *signed*. Sending different ones fails as a signature
        // error, which reads as "upload broken" rather than "wrong header".
        const response = await fetch(ticket.uploadUrl, {
          method: 'PUT',
          headers: ticket.headers,
          body: file,
        });
        if (!response.ok)
          throw new Error(`Object storage refused the upload (${response.status}).`);

        await auth.completeAssetUpload(spaceSlug, ticket.asset.id);
        notify(`"${file.name}" uploaded — it will appear once the pipeline has checked it.`);
        await refresh(spaceSlug);
      } catch (error) {
        setError(error instanceof Error ? error.message : String(error));
      } finally {
        setUploading(null);
      }
    },
    [spaceSlug, notify, setError],
  );

  return (
    <Panel className="shrink-0 p-2">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-[10px] uppercase tracking-wide text-slate-500">Assets</h3>
        <button
          type="button"
          onClick={() => input.current?.click()}
          className="rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-sky-400 hover:bg-sky-500/15"
          title="Upload a .glb model (FR-9.11)"
        >
          {uploading ? 'uploading…' : 'upload'}
        </button>
        <input
          ref={input}
          type="file"
          accept=".glb,model/gltf-binary"
          className="hidden"
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = '';
            if (file) void upload(file);
          }}
        />
      </div>

      <ul className="max-h-56 space-y-0.5 overflow-y-auto">
        {assets.length === 0 && (
          <li className="px-1 py-2 text-[11px] text-slate-600">
            Nothing in the library yet. The built-in set ships with the server — run
            <code className="mx-1">node assets/library/build-library.mjs</code> if it is missing.
          </li>
        )}
        {assets.map((asset) => (
          <AssetRow
            key={asset.id}
            asset={asset}
            spaceSlug={spaceSlug}
            onPlace={() =>
              // Dropped in front of the origin rather than at it, so a second
              // one is visibly a second one rather than hidden inside the first.
              apply((document) =>
                placeObject(document, asset.slug, {
                  x: Math.round((Math.random() - 0.5) * 6),
                  y: 0,
                  z: Math.round((Math.random() - 0.5) * 6),
                }),
              )
            }
          />
        ))}
      </ul>
    </Panel>
  );
}

function AssetRow({
  asset,
  spaceSlug,
  onPlace,
}: {
  asset: AssetDto;
  spaceSlug: string;
  onPlace: () => void;
}) {
  const setError = useEditorStore((store) => store.setError);
  const notify = useEditorStore((store) => store.notify);
  const ready = asset.status === 'ready';

  return (
    <li className="group flex items-center gap-1.5 rounded px-1 py-1 text-xs hover:bg-white/5">
      <button
        type="button"
        disabled={!ready}
        onClick={onPlace}
        title={
          ready
            ? `Place ${asset.name}`
            : asset.status === 'rejected'
              ? (asset.error ?? 'This asset was rejected.')
              : 'Still being processed by the pipeline.'
        }
        className={cn(
          'min-w-0 flex-1 truncate text-left',
          ready ? 'text-slate-200' : 'cursor-not-allowed text-slate-600',
        )}
      >
        {asset.name}
      </button>

      {/* `DC-9.3`'s validation status, which is the pipeline's job state. Shown
          rather than hidden: an asset that is still processing is not broken,
          and one that was rejected has a reason worth reading. */}
      {!ready && (
        <span
          className={cn(
            'shrink-0 text-[9px] uppercase tracking-wide',
            asset.status === 'rejected' ? 'text-rose-400' : 'text-slate-500',
          )}
        >
          {asset.status}
        </span>
      )}
      {asset.builtIn && (
        <span
          className="shrink-0 text-[9px] uppercase tracking-wide text-slate-600"
          title="Ships with the server — a map can always be built here (FR-9.15)"
        >
          built-in
        </span>
      )}
      {!asset.builtIn && (
        <button
          type="button"
          title={
            asset.usedByMaps > 0
              ? `Placed in ${asset.usedByMaps} map(s) — remove it from them first (FR-9.14)`
              : 'Remove from the library'
          }
          onClick={() =>
            void auth
              .deleteAsset(spaceSlug, asset.id)
              .then(async () => {
                notify(`"${asset.name}" removed.`);
                await refresh(spaceSlug);
              })
              .catch((error: Error) => setError(error.message))
          }
          className="shrink-0 rounded px-1 text-[9px] uppercase tracking-wide text-slate-600
                     opacity-0 hover:text-rose-300 focus-visible:opacity-100 group-hover:opacity-100"
        >
          del
        </button>
      )}
    </li>
  );
}

/** Re-read the library after it changes. One call rather than patching the list,
 *  because `usedByMaps` on *every* asset can move when one placement changes. */
async function refresh(spaceSlug: string): Promise<void> {
  const store = useEditorStore.getState();
  if (!store.mapId) return;
  const state = await auth.editorState(spaceSlug, store.mapId);
  store.adopt(state);
}

// ─────────────────────────────────────────────────────────────────────────────
// FR-9.2 — the outliner
// ─────────────────────────────────────────────────────────────────────────────

/** Everything in the map, by name. The one place an object hidden inside a wall
 *  can be selected — a scene view alone makes anything occluded unreachable. */
export function Outliner() {
  const document = useEditorStore((store) => store.document);
  const selection = useEditorStore((store) => store.selection);
  const select = useEditorStore((store) => store.select);
  if (!document) return null;

  return (
    <Panel className="min-h-0 shrink p-2">
      <h3 className="mb-1 text-[10px] uppercase tracking-wide text-slate-500">
        Scene · {document.objects.length} object(s), {document.zones.length} zone(s)
      </h3>
      <ul className="max-h-64 space-y-0.5 overflow-y-auto text-xs">
        {document.objects.map((object) => (
          <li key={object.id}>
            <button
              type="button"
              onClick={() => select({ kind: 'object', id: object.id })}
              className={cn(
                'flex w-full items-center gap-2 rounded px-1.5 py-1 text-left',
                selection?.kind === 'object' && selection.id === object.id
                  ? 'bg-sky-500/15 text-sky-100'
                  : 'text-slate-300 hover:bg-white/5',
              )}
            >
              <span className="min-w-0 flex-1 truncate">{object.id}</span>
              {object.group && (
                <span className="shrink-0 text-[9px] uppercase tracking-wide text-slate-600">
                  {object.group}
                </span>
              )}
            </button>
          </li>
        ))}
        {document.zones.map((zone) => (
          <li key={zone.id}>
            <button
              type="button"
              onClick={() => select({ kind: 'zone', id: zone.id })}
              className={cn(
                'flex w-full items-center gap-2 rounded px-1.5 py-1 text-left',
                selection?.kind === 'zone' && selection.id === zone.id
                  ? 'bg-sky-500/15 text-sky-100'
                  : 'text-slate-300 hover:bg-white/5',
              )}
            >
              <span className="min-w-0 flex-1 truncate">{zone.id}</span>
              <span className="shrink-0 text-[9px] uppercase tracking-wide text-slate-600">
                {zone.type}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </Panel>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// FR-9.5 – FR-9.9 — the inspector
// ─────────────────────────────────────────────────────────────────────────────

export function Inspector() {
  const document = useEditorStore((store) => store.document);
  const selection = useEditorStore((store) => store.selection);
  const apply = useEditorStore((store) => store.apply);
  if (!document) return null;

  if (!selection) {
    return (
      <Panel className="shrink-0 p-3">
        <p className="text-[11px] text-slate-600">
          Nothing selected. Click something in the scene or the list, or place an asset from the
          library.
        </p>
        <SpawnList />
      </Panel>
    );
  }

  if (selection.kind === 'object') {
    const object = document.objects.find((candidate) => candidate.id === selection.id);
    if (!object) return null;

    return (
      <Panel className="shrink-0 space-y-2 p-3 text-xs">
        <Header title={object.id} subtitle={object.assetId} />
        <Vector
          label="Position"
          value={object.transform.position}
          onChange={(position) =>
            apply((current) => updateObject(current, object.id, { transform: { position } }))
          }
        />
        <Vector
          label="Rotation"
          step={0.1}
          value={object.transform.rotation}
          onChange={(rotation) =>
            apply((current) =>
              updateObject(current, object.id, {
                transform: { ...object.transform, rotation },
              }),
            )
          }
        />
        <Vector
          label="Scale"
          step={0.1}
          value={object.transform.scale}
          onChange={(scale) =>
            apply((current) =>
              updateObject(current, object.id, { transform: { ...object.transform, scale } }),
            )
          }
        />
        <Field label="Group">
          <input
            value={object.group ?? ''}
            placeholder="none"
            onChange={(event) =>
              apply((current) =>
                setObjectGroup(current, object.id, event.target.value.trim() || undefined),
              )
            }
            className={inputClass}
          />
        </Field>
        {/* `FR-10.1` — what makes an object interactive is configured here, in
            the same place its transform is. Phase 10's whole configuration
            surface, because the Map Document is where it lives (`FR-10.15`). */}
        <InteractiveFields object={object} />

        <div className="flex gap-1 pt-1">
          <SmallButton onClick={() => apply((current) => duplicateObject(current, object.id))}>
            Duplicate
          </SmallButton>
          <SmallButton
            danger
            onClick={() => {
              apply((current) => removeObject(current, object.id));
              useEditorStore.getState().select(null);
            }}
          >
            Delete
          </SmallButton>
        </div>
      </Panel>
    );
  }

  const zone = document.zones.find((candidate) => candidate.id === selection.id);
  if (!zone) return null;
  return <ZoneInspector zone={zone} />;
}

/**
 * `FR-10.1`, `FR-10.15` — making an object interactive, and configuring it.
 *
 * Phase 10's configuration lives in the Map Document and versions with it, which
 * is why it is authored here rather than in a screen of its own: the thing being
 * configured is a placed object, and phase 9 already has the panel for one.
 *
 * ── The closed enum is visible in the interface ─────────────────────────────
 *
 * `AC-10.6` asks for confirmation that no generic third-party app hosting
 * exists, and this select is where an author would see it if it did. Five types,
 * fixed; there is no "custom", no URL that becomes an application, and no field
 * that would accept one.
 *
 * ── The one setting worth a warning ─────────────────────────────────────────
 *
 * Sharp edge nº5 in the phase notes: `persistShared: false` means gone on last
 * leave, and discovering that after a workshop is not recoverable. So it says so
 * on the control rather than in documentation.
 */
function InteractiveFields({ object }: { object: PlacedObject }) {
  const apply = useEditorStore((store) => store.apply);
  const interactive = object.interactive;

  const set = (patch: Partial<NonNullable<PlacedObject['interactive']>>) =>
    apply((current) =>
      updateObject(current, object.id, {
        interactive: {
          contentType: interactive?.contentType ?? 'note',
          content: interactive?.content ?? {},
          shared: interactive?.shared ?? false,
          persistShared: interactive?.persistShared ?? false,
          ...(interactive?.interactionRangeM !== undefined
            ? { interactionRangeM: interactive.interactionRangeM }
            : {}),
          ...patch,
        },
      }),
    );

  const setContent = (patch: Record<string, unknown>) =>
    set({ content: { ...(interactive?.content ?? {}), ...patch } });

  if (!interactive) {
    return (
      <div className="border-t border-white/10 pt-2">
        <SmallButton
          onClick={() =>
            apply((current) =>
              updateObject(current, object.id, {
                interactive: {
                  contentType: 'note',
                  content: { text: '', editable: false },
                  shared: false,
                  persistShared: false,
                },
              }),
            )
          }
        >
          Make interactive
        </SmallButton>
      </div>
    );
  }

  const content = interactive.content as Record<string, unknown>;
  const surface = typeof content.surface === 'string' ? content.surface : 'text';

  return (
    <div className="space-y-2 border-t border-white/10 pt-2">
      <h4 className="text-[10px] uppercase tracking-wide text-slate-500">Interactive</h4>

      <Field label="Type">
        <select
          value={interactive.contentType}
          onChange={(event) =>
            // The content is reset with the type. Keeping a link's `url` on a
            // video would leave a field nothing reads and a panel that renders
            // an empty player — and the author would have no way to tell which.
            set({ contentType: event.target.value as typeof interactive.contentType, content: {} })
          }
          className={inputClass}
        >
          {CONTENT_TYPES.map((type) => (
            <option key={type} value={type} className="bg-slate-900">
              {type}
            </option>
          ))}
        </select>
      </Field>

      {interactive.contentType === 'link' && (
        <>
          <Field label="URL">
            <input
              value={String(content.url ?? '')}
              placeholder="https://…"
              onChange={(event) => setContent({ url: event.target.value })}
              className={inputClass}
            />
          </Field>
          <Field label="Label">
            <input
              value={String(content.label ?? '')}
              onChange={(event) => setContent({ label: event.target.value })}
              className={inputClass}
            />
          </Field>
        </>
      )}

      {(interactive.contentType === 'image' ||
        interactive.contentType === 'video' ||
        interactive.contentType === 'document') && (
        <>
          <Field label="URL">
            <input
              value={String(content.url ?? '')}
              placeholder="/assets/… or https://…"
              onChange={(event) => setContent({ url: event.target.value })}
              className={inputClass}
            />
          </Field>
          <Field label="Title">
            <input
              value={String(content.title ?? content.alt ?? '')}
              onChange={(event) =>
                setContent(
                  interactive.contentType === 'image'
                    ? { alt: event.target.value }
                    : { title: event.target.value },
                )
              }
              className={inputClass}
            />
          </Field>
        </>
      )}

      {interactive.contentType === 'note' && (
        <>
          {interactive.shared ? (
            <Field label="Surface">
              <select
                value={surface}
                onChange={(event) => setContent({ surface: event.target.value })}
                className={inputClass}
              >
                <option value="text" className="bg-slate-900">
                  shared text
                </option>
                <option value="whiteboard" className="bg-slate-900">
                  whiteboard
                </option>
                <option value="notes" className="bg-slate-900">
                  sticky notes
                </option>
              </select>
            </Field>
          ) : (
            <>
              <Field label="Text">
                <textarea
                  value={String(content.text ?? '')}
                  onChange={(event) => setContent({ text: event.target.value })}
                  className={`${inputClass} h-16 resize-none`}
                />
              </Field>
              <label className="flex items-center gap-2 text-[11px] text-slate-400">
                <input
                  type="checkbox"
                  checked={content.editable === true}
                  onChange={(event) => setContent({ editable: event.target.checked })}
                />
                Readers can edit their own copy
              </label>
            </>
          )}
        </>
      )}

      <Field label="Range">
        <NumberInput
          value={interactive.interactionRangeM ?? INTERACT_RANGE_M}
          step={0.5}
          onChange={(interactionRangeM) =>
            set({ interactionRangeM: Math.max(0.5, interactionRangeM) })
          }
        />
      </Field>

      {/* `FR-10.10` — shared is what turns a per-participant object into one
          people are in together. Everything else about the CRDT follows from it. */}
      <label className="flex items-center gap-2 text-[11px] text-slate-400">
        <input
          type="checkbox"
          checked={interactive.shared}
          onChange={(event) => set({ shared: event.target.checked })}
        />
        Shared — everybody sees the same state
      </label>

      {interactive.shared && (
        <label className="flex items-start gap-2 text-[11px] text-slate-400">
          <input
            type="checkbox"
            checked={interactive.persistShared}
            onChange={(event) => set({ persistShared: event.target.checked })}
            className="mt-0.5"
          />
          <span>
            Keep it after everybody leaves
            {!interactive.persistShared && (
              <span className="block text-amber-400/80">
                Off — whatever people put on this is gone when the last one leaves. Not recoverable.
              </span>
            )}
          </span>
        </label>
      )}
    </div>
  );
}

/** `FR-9.5`–`FR-9.9` — the properties each zone type actually has. A single
 *  eight-field form would show `spawnId` on a spotlight and `gain` on a portal,
 *  and an author would have to know the schema to know which do anything. */
function ZoneInspector({ zone }: { zone: Zone }) {
  const document = useEditorStore((store) => store.document)!;
  const apply = useEditorStore((store) => store.apply);
  const maps = useEditorStore((store) => store.brokenPortals);

  const set = (patch: Partial<Zone>) => apply((current) => updateZone(current, zone.id, patch));
  const setProperty = (properties: Zone['properties']) =>
    apply((current) => updateZone(current, zone.id, { properties }));

  const broken = maps.some((portal) => portal.zoneId === zone.id);

  // Narrowed once, into two constants, rather than tested inline. A volume is a
  // discriminated union and every callback below closes over it; testing the
  // discriminant at each use site would leave TypeScript unable to see which
  // half it is inside a closure, and casting past that is how a cylinder ends up
  // with a `size`.
  const box = zone.volume.shape === 'box' ? zone.volume : null;
  const cylinder = zone.volume.shape === 'cylinder' ? zone.volume : null;

  return (
    <Panel className="shrink-0 space-y-2 p-3 text-xs">
      <Header title={zone.id} subtitle={`${zone.type} zone`} />

      {box && (
        <>
          <Vector
            label="Centre"
            value={box.center}
            onChange={(center) => set({ volume: { ...box, center } })}
          />
          <Vector
            label="Size"
            step={0.5}
            value={box.size}
            onChange={(size) =>
              set({
                volume: {
                  ...box,
                  size: {
                    x: Math.max(0.1, size.x),
                    y: Math.max(0.1, size.y),
                    z: Math.max(0.1, size.z),
                  },
                },
              })
            }
          />
        </>
      )}

      {cylinder && (
        <>
          <Vector
            label="Centre"
            value={cylinder.center}
            onChange={(center) => set({ volume: { ...cylinder, center } })}
          />
          <Field label="Radius">
            <NumberInput
              value={cylinder.radius}
              step={0.25}
              onChange={(radius) => set({ volume: { ...cylinder, radius: Math.max(0.1, radius) } })}
            />
          </Field>
          <Field label="Height">
            <NumberInput
              value={cylinder.height}
              step={0.25}
              onChange={(height) => set({ volume: { ...cylinder, height: Math.max(0.1, height) } })}
            />
          </Field>
        </>
      )}

      {/* `FR-9.7` — a private or spotlight zone's gain is what makes it do
          anything at all. */}
      {(zone.type === 'private' || zone.type === 'spotlight') && (
        <Field label="Gain">
          <NumberInput
            value={zone.properties.gain ?? 1}
            step={0.05}
            onChange={(gain) =>
              setProperty({ ...zone.properties, gain: Math.max(0, Math.min(1, gain)) })
            }
          />
        </Field>
      )}

      {/* `FR-9.8` — a portal's target, which is the abstract reference phase 3
          left open and phase 8 resolves. */}
      {zone.type === 'portal' && (
        <>
          <Field label="Target map">
            <input
              value={zone.properties.target?.mapId ?? ''}
              placeholder="this map"
              onChange={(event) =>
                setProperty({
                  ...zone.properties,
                  target: {
                    spawnId: zone.properties.target?.spawnId ?? '',
                    ...(event.target.value.trim() ? { mapId: event.target.value.trim() } : {}),
                  },
                })
              }
              className={inputClass}
            />
          </Field>
          <Field label="Target spawn">
            <input
              value={zone.properties.target?.spawnId ?? ''}
              placeholder="spawn id"
              onChange={(event) =>
                setProperty({
                  ...zone.properties,
                  target: {
                    ...(zone.properties.target ?? {}),
                    spawnId: event.target.value.trim(),
                  },
                })
              }
              className={inputClass}
            />
          </Field>
          {broken && (
            <p className="rounded border border-rose-400/30 bg-rose-950/40 px-2 py-1 text-[10px] text-rose-200">
              This portal points at a map that does not exist. Publishing is refused until it is
              repointed or removed.
            </p>
          )}
        </>
      )}

      {/* `FR-9.9` — a trigger's key is what phase 10 will match on. */}
      {zone.type === 'trigger' && (
        <Field label="Key">
          <input
            value={zone.properties.key ?? ''}
            onChange={(event) => setProperty({ ...zone.properties, key: event.target.value })}
            className={inputClass}
          />
        </Field>
      )}

      {zone.type === 'spawn' && (
        <>
          <Field label="Spawn">
            <select
              value={zone.properties.spawnId ?? ''}
              onChange={(event) =>
                setProperty({ ...zone.properties, spawnId: event.target.value || undefined })
              }
              className={inputClass}
            >
              <option value="">none</option>
              {document.spawns.map((spawn) => (
                <option key={spawn.id} value={spawn.id} className="bg-slate-900">
                  {spawn.id}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Rule">
            <select
              value={zone.properties.rule ?? 'default'}
              onChange={(event) =>
                setProperty({
                  ...zone.properties,
                  rule: event.target.value as 'default' | 'least-crowded',
                })
              }
              className={inputClass}
            >
              <option value="default" className="bg-slate-900">
                default
              </option>
              <option value="least-crowded" className="bg-slate-900">
                least-crowded
              </option>
            </select>
          </Field>
        </>
      )}

      {(zone.type === 'private' || zone.type === 'trigger') && (
        <label className="flex items-center gap-2 text-[11px] text-slate-400">
          <input
            type="checkbox"
            checked={zone.properties.chatEnabled === true}
            onChange={(event) =>
              setProperty({ ...zone.properties, chatEnabled: event.target.checked })
            }
          />
          Chat channel in this zone (FR-5.3)
        </label>
      )}

      <div className="flex gap-1 pt-1">
        <SmallButton
          danger
          onClick={() => {
            apply((current) => removeZone(current, zone.id));
            useEditorStore.getState().select(null);
          }}
        >
          Delete zone
        </SmallButton>
      </div>
    </Panel>
  );
}

/** `FR-9.6` — the spawn points themselves, which are not zones. */
function SpawnList() {
  const document = useEditorStore((store) => store.document)!;
  const apply = useEditorStore((store) => store.apply);

  return (
    <div className="mt-3 border-t border-white/10 pt-2">
      <div className="mb-1 flex items-center justify-between">
        <h3 className="text-[10px] uppercase tracking-wide text-slate-500">Spawns</h3>
        <button
          type="button"
          onClick={() => apply((current) => addSpawn(current, { x: 0, y: 0, z: 0 }))}
          className="rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-sky-400 hover:bg-sky-500/15"
        >
          add
        </button>
      </div>
      <ul className="space-y-1 text-[11px]">
        {document.spawns.map((spawn) => (
          <li key={spawn.id} className="flex items-center gap-1.5">
            <span className="min-w-0 flex-1 truncate text-slate-300">{spawn.id}</span>
            {spawn.default ? (
              <span className="shrink-0 text-[9px] uppercase tracking-wide text-emerald-400">
                default
              </span>
            ) : (
              <>
                <button
                  type="button"
                  onClick={() => apply((current) => makeDefaultSpawn(current, spawn.id))}
                  className="shrink-0 rounded px-1 text-[9px] uppercase tracking-wide text-slate-500 hover:text-emerald-300"
                  title="Where arrivals land when nothing else names a spawn (FR-8.7)"
                >
                  make default
                </button>
                <button
                  type="button"
                  onClick={() => apply((current) => removeSpawn(current, spawn.id))}
                  className="shrink-0 rounded px-1 text-[9px] uppercase tracking-wide text-slate-500 hover:text-rose-300"
                >
                  del
                </button>
              </>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// FR-9.16 — lighting and environment
// ─────────────────────────────────────────────────────────────────────────────

export function EnvironmentPanel() {
  const document = useEditorStore((store) => store.document);
  const apply = useEditorStore((store) => store.apply);
  if (!document) return null;

  const environment = document.environment;
  const set = (patch: Partial<typeof environment>) =>
    apply((current) => updateEnvironment(current, patch));

  return (
    <Panel className="shrink-0 space-y-2 p-3 text-xs">
      <h3 className="text-[10px] uppercase tracking-wide text-slate-500">Environment</h3>

      <Field label="Background">
        <input
          type="color"
          value={environment.background}
          onChange={(event) => set({ background: event.target.value })}
          className="h-6 w-full cursor-pointer rounded border border-white/10 bg-transparent"
        />
      </Field>
      <Field label="Ambient">
        <input
          type="color"
          value={environment.ambientColor}
          onChange={(event) => set({ ambientColor: event.target.value })}
          className="h-6 w-full cursor-pointer rounded border border-white/10 bg-transparent"
        />
      </Field>
      <Field label="Ambient level">
        <NumberInput
          value={environment.ambientIntensity}
          step={0.05}
          onChange={(ambientIntensity) => set({ ambientIntensity: Math.max(0, ambientIntensity) })}
        />
      </Field>
      <Field label="Sun">
        <input
          type="color"
          value={environment.sunColor}
          onChange={(event) => set({ sunColor: event.target.value })}
          className="h-6 w-full cursor-pointer rounded border border-white/10 bg-transparent"
        />
      </Field>
      <Field label="Sun level">
        <NumberInput
          value={environment.sunIntensity}
          step={0.05}
          onChange={(sunIntensity) => set({ sunIntensity: Math.max(0, sunIntensity) })}
        />
      </Field>
      <Vector
        label="Sun direction"
        step={0.1}
        value={environment.sunDirection}
        onChange={(sunDirection) => set({ sunDirection })}
      />
    </Panel>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// FR-9.17 – FR-9.19 — versions
// ─────────────────────────────────────────────────────────────────────────────

export function VersionBar({ dirty }: { dirty: boolean }) {
  const store = useEditorStore();
  const [open, setOpen] = useState(false);

  return (
    <footer className="shrink-0 border-t border-white/10 px-3 py-1.5 text-[11px] text-slate-500">
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          className="rounded px-1.5 py-0.5 text-slate-400 hover:bg-white/10"
        >
          {store.versions.length} version{store.versions.length === 1 ? '' : 's'} ▾
        </button>
        <span>
          Published v{store.publishedVersion}
          {dirty ? ' · draft has unsaved changes' : ' · draft matches what is live'}
        </span>
        {store.draftUpdatedBy && <span>· last saved by {store.draftUpdatedBy}</span>}
        <button
          type="button"
          onClick={() => void store.discard()}
          className="ml-auto rounded px-1.5 py-0.5 text-slate-500 hover:bg-white/10 hover:text-rose-300"
          title="Throw the draft away and start from the published version"
        >
          discard draft
        </button>
      </div>

      {open && (
        <ul className="mt-2 max-h-32 space-y-0.5 overflow-y-auto">
          {store.versions.map((version) => (
            <li key={version.version} className="flex items-center gap-2">
              <span className={cn('w-10 shrink-0', version.published && 'text-emerald-400')}>
                v{version.version}
              </span>
              <span className="w-40 shrink-0 truncate text-slate-600">
                {new Date(version.createdAt).toLocaleString('en-GB')}
              </span>
              <span className="min-w-0 flex-1 truncate">{version.notes ?? ''}</span>
              {!version.published && (
                <>
                  {/* Copy-forward, both ways. Loading into the draft is the safe
                      one and is offered first; publishing straight away is what
                      somebody undoing a mistake at 5pm actually wants. */}
                  <button
                    type="button"
                    onClick={() => void store.revert(version.version, false)}
                    className="shrink-0 rounded px-1 text-slate-500 hover:text-sky-300"
                  >
                    load
                  </button>
                  <button
                    type="button"
                    onClick={() => void store.revert(version.version, true)}
                    className="shrink-0 rounded px-1 text-slate-500 hover:text-amber-300"
                    title="Load it and publish it as a new version — nothing is deleted (FR-9.19)"
                  >
                    revert
                  </button>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
    </footer>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Small shared controls
// ─────────────────────────────────────────────────────────────────────────────

const inputClass =
  'w-full rounded border border-white/10 bg-slate-950/60 px-1.5 py-0.5 text-[11px] ' +
  'text-slate-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-300';

function Header({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div>
      <h3 className="truncate text-xs font-medium text-slate-100">{title}</h3>
      <p className="truncate text-[10px] uppercase tracking-wide text-slate-600">{subtitle}</p>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex items-center gap-2">
      <span className="w-20 shrink-0 text-[10px] uppercase tracking-wide text-slate-600">
        {label}
      </span>
      <span className="min-w-0 flex-1">{children}</span>
    </label>
  );
}

function NumberInput({
  value,
  step = 0.25,
  onChange,
}: {
  value: number;
  step?: number;
  onChange: (value: number) => void;
}) {
  return (
    <input
      type="number"
      step={step}
      value={Number(value.toFixed(3))}
      onChange={(event) => {
        const parsed = Number(event.target.value);
        if (Number.isFinite(parsed)) onChange(parsed);
      }}
      className={inputClass}
    />
  );
}

function Vector({
  label,
  value,
  step,
  onChange,
}: {
  label: string;
  value: { x: number; y: number; z: number };
  step?: number;
  onChange: (value: { x: number; y: number; z: number }) => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="w-20 shrink-0 text-[10px] uppercase tracking-wide text-slate-600">
        {label}
      </span>
      <div className="flex min-w-0 flex-1 gap-1">
        {(['x', 'y', 'z'] as const).map((axis) => (
          <NumberInput
            key={axis}
            value={value[axis]}
            {...(step === undefined ? {} : { step })}
            onChange={(next) => onChange({ ...value, [axis]: next })}
          />
        ))}
      </div>
    </div>
  );
}

function SmallButton({
  children,
  onClick,
  danger,
}: {
  children: React.ReactNode;
  onClick: () => void;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'rounded px-2 py-1 text-[10px] uppercase tracking-wide',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-300',
        danger ? 'text-rose-400/80 hover:bg-rose-500/15' : 'text-slate-400 hover:bg-white/10',
      )}
    >
      {children}
    </button>
  );
}
