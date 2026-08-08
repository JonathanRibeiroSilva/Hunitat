/**
 * The editor's 3D view — `FR-9.1`, `FR-9.3`, `FR-9.5`–`FR-9.10`.
 *
 * ── The editor is the runtime client ────────────────────────────────────────
 *
 * `FR-9.3` asks for a preview accurate to what participants see, and the phase
 * notes are explicit about how: rather than building a separate preview, the
 * editor **is** a view in `apps/web` reusing the same R3F scene, the same
 * `buildPhysics`, the same `LocalPlayer` and the same tuning constants
 * (ADR 0002). Fidelity is structural rather than maintained — there is no second
 * renderer to keep in step, so `FR-9.10` ("authored zones behave at runtime
 * exactly as specified in Phase 3") is true because the same code reads them.
 *
 * Play mode is not a simulation of the runtime. It is the runtime, with colliders
 * built from the draft instead of from the published document.
 *
 * ── Why the gizmo commits on release ────────────────────────────────────────
 *
 * `TransformControls` fires continuously while dragging. Writing each frame into
 * the command stack would make one drag fifty undo steps, and `FR-9.2`'s
 * undo/redo would be unusable for the operation it exists to cover. So the drag
 * is local to the object and the *document* is written once, when the mouse
 * comes up — which is also the granularity a person means by "undo that move".
 */

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Canvas, useThree } from '@react-three/fiber';
import { Grid, OrbitControls, TransformControls } from '@react-three/drei';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import {
  TUNING,
  isHiddenNode,
  type ClientTuning,
  type MapDocument,
  type PlacedObject,
  type Zone,
} from '@hubitat/protocol';
import { buildPhysics, type PhysicsWorld } from '../world/physics.js';
import { LocalPlayer } from '../world/LocalPlayer.jsx';
import { attachInput } from '../world/input.js';
import { useEditorStore, updateObject, updateZone } from './editorStore.js';

const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3000';

/**
 * Zone colours, one per authored type.
 *
 * Colour is never the only signal — the outliner names the type in words — but
 * six kinds of invisible volume overlapping in one room is exactly the case
 * where a glance has to be enough.
 */
const ZONE_COLOR: Record<Zone['type'], string> = {
  collision: '#ef4444',
  spawn: '#22c55e',
  private: '#a855f7',
  spotlight: '#f59e0b',
  portal: '#38bdf8',
  trigger: '#64748b',
};

export function EditorScene({ tuning }: { tuning: ClientTuning }) {
  const document = useEditorStore((store) => store.document);
  const mode = useEditorStore((store) => store.mode);
  const environment = document?.environment;

  if (!document || !environment) return null;

  return (
    <Canvas
      shadows
      dpr={[1, 2]}
      camera={{
        fov: TUNING.CAMERA_FOV_DEG,
        near: TUNING.CAMERA_NEAR_M,
        far: TUNING.CAMERA_FAR_M,
        position: [14, 12, 14],
      }}
      gl={{ antialias: true, powerPreference: 'high-performance' }}
      // Clicking empty space clears the selection. On the canvas rather than on
      // the camera controls, because it is a fact about the *pointer* missing
      // every object, which is what R3F reports here and nowhere else.
      onPointerMissed={() => {
        if (mode !== 'play') useEditorStore.getState().select(null);
      }}
      onCreated={({ gl, scene }) => {
        gl.toneMapping = THREE.ACESFilmicToneMapping;
        scene.background = new THREE.Color(environment.background);
      }}
    >
      {/* `FR-9.16` — the environment block, live. An author changing the sun
          sees the sun change, which is the whole of the requirement. */}
      <ambientLight color={environment.ambientColor} intensity={environment.ambientIntensity} />
      <directionalLight
        castShadow
        color={environment.sunColor}
        intensity={environment.sunIntensity}
        position={[
          -environment.sunDirection.x * 30,
          -environment.sunDirection.y * 30,
          -environment.sunDirection.z * 30,
        ]}
        shadow-mapSize={[2048, 2048]}
      />

      <Suspense fallback={null}>
        <BaseGeometry url={document.geometry.url} />
        <PlacedObjects document={document} interactive={mode !== 'play'} />
      </Suspense>

      {mode === 'play' ? (
        <PlayMode document={document} tuning={tuning} />
      ) : (
        <>
          {/* A ground grid, so an author dragging in empty space has a sense of
              scale and of where the floor is. One metre, matching the units
              everything else in this product is measured in. */}
          <Grid
            args={[200, 200]}
            cellSize={1}
            cellThickness={0.5}
            cellColor="#334155"
            sectionSize={10}
            sectionThickness={1}
            sectionColor="#475569"
            fadeDistance={90}
            infiniteGrid
            position={[0, 0.01, 0]}
          />
          <Zones document={document} />
          <Spawns document={document} />
          <EditorCamera />
          <Gizmo />
        </>
      )}
    </Canvas>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Geometry
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A tiny GLB cache, keyed by URL.
 *
 * Placed objects reuse assets — a room has eight of the same chair — and loading
 * the file once per instance would download it eight times and hold eight copies
 * of its geometry. Cloning a cached scene is what `FR-9.13`'s performance
 * concern actually looks like in the editor.
 */
const gltfCache = new Map<string, Promise<THREE.Group>>();

function loadGltf(url: string): Promise<THREE.Group> {
  const absolute = url.startsWith('http') ? url : `${API_URL}${url}`;
  const cached = gltfCache.get(absolute);
  if (cached) return cached;

  const loader = new GLTFLoader();
  const promise = loader.loadAsync(absolute).then((gltf) => gltf.scene);
  gltfCache.set(absolute, promise);
  return promise;
}

function useGltf(url: string | null): THREE.Group | null {
  const [scene, setScene] = useState<THREE.Group | null>(null);

  useEffect(() => {
    if (!url) {
      setScene(null);
      return;
    }
    let cancelled = false;
    void loadGltf(url)
      .then((loaded) => {
        if (!cancelled) setScene(loaded);
      })
      .catch(() => {
        // A missing asset is drawn as nothing rather than crashing the editor.
        // The library panel already shows why — an asset the pipeline rejected
        // has its reason on it — and taking the whole scene down over one
        // broken model would lose the author's work.
        if (!cancelled) setScene(null);
      });
    return () => {
      cancelled = true;
    };
  }, [url]);

  return scene;
}

/** The Map's own GLB. Hidden nodes — `COL_`, `SPAWN_`, `NAV_` — are stripped,
 *  exactly as the runtime strips them, so the editor shows what participants
 *  see rather than a grey mass of collision geometry. */
function BaseGeometry({ url }: { url: string }) {
  const source = useGltf(url);

  const scene = useMemo(() => {
    if (!source) return null;
    const clone = source.clone(true);
    const hidden: THREE.Object3D[] = [];
    clone.traverse((object) => {
      if (isHiddenNode(object.name)) hidden.push(object);
      const mesh = object as THREE.Mesh;
      if (mesh.isMesh) {
        mesh.castShadow = true;
        mesh.receiveShadow = true;
      }
    });
    for (const object of hidden) object.removeFromParent();
    return clone;
  }, [source]);

  return scene ? <primitive object={scene} /> : null;
}

/** `DC-9.2` — every placed object, each an instance of a library asset. */
function PlacedObjects({ document, interactive }: { document: MapDocument; interactive: boolean }) {
  const assets = useEditorStore((store) => store.assets);
  // Keyed by slug, which is what a document's `assetId` holds — see
  // `assetSchema.slug` for why a document names a slug rather than a uuid.
  const urls = useMemo(() => {
    const bySlug = new Map<string, string>();
    for (const asset of assets) {
      if (asset.url) bySlug.set(asset.slug, asset.url);
    }
    return bySlug;
  }, [assets]);

  return (
    <>
      {document.objects.map((object) => (
        <PlacedObjectMesh
          key={object.id}
          object={object}
          url={urls.get(object.assetId) ?? null}
          interactive={interactive}
        />
      ))}
    </>
  );
}

function PlacedObjectMesh({
  object,
  url,
  interactive,
}: {
  object: PlacedObject;
  url: string | null;
  interactive: boolean;
}) {
  const source = useGltf(url);
  const select = useEditorStore((store) => store.select);
  const selected = useEditorStore(
    (store) => store.selection?.kind === 'object' && store.selection.id === object.id,
  );

  const scene = useMemo(() => {
    if (!source) return null;
    const clone = source.clone(true);
    clone.traverse((child) => {
      const mesh = child as THREE.Mesh;
      if (mesh.isMesh) {
        mesh.castShadow = true;
        mesh.receiveShadow = true;
      }
    });
    return clone;
  }, [source]);

  return (
    <group
      name={`object:${object.id}`}
      position={[
        object.transform.position.x,
        object.transform.position.y,
        object.transform.position.z,
      ]}
      rotation={[
        object.transform.rotation.x,
        object.transform.rotation.y,
        object.transform.rotation.z,
      ]}
      scale={[object.transform.scale.x, object.transform.scale.y, object.transform.scale.z]}
      onClick={
        interactive
          ? (event) => {
              event.stopPropagation();
              select({ kind: 'object', id: object.id });
            }
          : undefined
      }
    >
      {scene ? (
        <primitive object={scene} />
      ) : (
        // A placeholder rather than nothing: an asset that has not loaded — or
        // one the pipeline rejected — still occupies a place in the room, and an
        // author needs to be able to see it to move or remove it.
        <mesh>
          <boxGeometry args={[1, 1, 1]} />
          <meshStandardMaterial color="#475569" wireframe />
        </mesh>
      )}
      {selected && <SelectionOutline />}
    </group>
  );
}

function SelectionOutline() {
  return (
    <mesh scale={[1.02, 1.02, 1.02]}>
      <boxGeometry args={[1.2, 1.2, 1.2]} />
      <meshBasicMaterial color="#38bdf8" wireframe transparent opacity={0.5} />
    </mesh>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// FR-9.5 – FR-9.9 — zones, drawn as what they are
// ─────────────────────────────────────────────────────────────────────────────

function Zones({ document }: { document: MapDocument }) {
  return (
    <>
      {document.zones.map((zone) => (
        <ZoneVolume key={zone.id} zone={zone} />
      ))}
    </>
  );
}

function ZoneVolume({ zone }: { zone: Zone }) {
  const select = useEditorStore((store) => store.select);
  const selected = useEditorStore(
    (store) => store.selection?.kind === 'zone' && store.selection.id === zone.id,
  );
  const color = ZONE_COLOR[zone.type];

  const size: [number, number, number] =
    zone.volume.shape === 'box'
      ? [zone.volume.size.x, zone.volume.size.y, zone.volume.size.z]
      : [zone.volume.radius * 2, zone.volume.height, zone.volume.radius * 2];

  return (
    <group
      name={`zone:${zone.id}`}
      position={[zone.volume.center.x, zone.volume.center.y, zone.volume.center.z]}
      rotation={[0, zone.volume.shape === 'box' ? zone.volume.yaw : 0, 0]}
      onClick={(event) => {
        event.stopPropagation();
        select({ kind: 'zone', id: zone.id });
      }}
    >
      {zone.volume.shape === 'box' ? (
        <mesh>
          <boxGeometry args={size} />
          {/* Translucent *and* wireframed. A solid volume hides the room it is
              in; a wireframe alone is hard to click and impossible to judge the
              extent of. Both is what makes six overlapping volumes readable. */}
          <meshBasicMaterial
            color={color}
            transparent
            opacity={selected ? 0.28 : 0.14}
            depthWrite={false}
          />
        </mesh>
      ) : (
        <mesh>
          <cylinderGeometry
            args={[zone.volume.radius, zone.volume.radius, zone.volume.height, 24]}
          />
          <meshBasicMaterial
            color={color}
            transparent
            opacity={selected ? 0.28 : 0.14}
            depthWrite={false}
          />
        </mesh>
      )}
      <mesh>
        {zone.volume.shape === 'box' ? (
          <boxGeometry args={size} />
        ) : (
          <cylinderGeometry
            args={[zone.volume.radius, zone.volume.radius, zone.volume.height, 24]}
          />
        )}
        <meshBasicMaterial color={color} wireframe transparent opacity={selected ? 1 : 0.6} />
      </mesh>
    </group>
  );
}

/** `FR-9.6` — spawns, drawn as the discs they are. Their radius is the area
 *  arrivals are spread across (`FR-3.7`), so drawing it is the difference
 *  between authoring a spawn and guessing at one. */
function Spawns({ document }: { document: MapDocument }) {
  return (
    <>
      {document.spawns.map((spawn) => (
        <group
          key={spawn.id}
          position={[spawn.position.x, spawn.position.y + 0.02, spawn.position.z]}
        >
          <mesh rotation={[-Math.PI / 2, 0, 0]}>
            <ringGeometry args={[spawn.radiusM - 0.06, spawn.radiusM, 32]} />
            <meshBasicMaterial
              color={spawn.default ? '#22c55e' : '#16a34a'}
              side={THREE.DoubleSide}
            />
          </mesh>
          {/* The facing. A spawn with the wrong yaw drops everybody in looking
              at a wall, which is invisible until somebody arrives. */}
          <mesh position={[Math.sin(spawn.yaw) * 0.9, 0, Math.cos(spawn.yaw) * 0.9]}>
            <coneGeometry args={[0.18, 0.5, 8]} />
            <meshBasicMaterial color={spawn.default ? '#22c55e' : '#16a34a'} />
          </mesh>
        </group>
      ))}
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// The gizmo — FR-9.1
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `TransformControls` bound to whatever is selected.
 *
 * The document is written on **release**, not on change — see the file header.
 * While dragging, the object moves because Three is moving it; the store learns
 * about it once, which is the granularity `FR-9.2`'s undo is useful at.
 */
function Gizmo() {
  const { scene } = useThree();
  const mode = useEditorStore((store) => store.mode);
  const selection = useEditorStore((store) => store.selection);
  const apply = useEditorStore((store) => store.apply);
  const controls = useRef<{ object?: THREE.Object3D } | null>(null);

  const target = useMemo(() => {
    if (!selection) return null;
    const name = `${selection.kind}:${selection.id}`;
    return scene.getObjectByName(name) ?? null;
  }, [scene, selection, mode]);

  const commit = useCallback(() => {
    const object = target;
    if (!object || !selection) return;

    if (selection.kind === 'object') {
      apply((document) =>
        updateObject(document, selection.id, {
          transform: {
            position: { x: object.position.x, y: object.position.y, z: object.position.z },
            rotation: { x: object.rotation.x, y: object.rotation.y, z: object.rotation.z },
            scale: { x: object.scale.x, y: object.scale.y, z: object.scale.z },
          },
        }),
      );
      return;
    }

    apply((document) => {
      const zone = document.zones.find((candidate) => candidate.id === selection.id);
      if (!zone) return document;

      // Scale is how a box volume is resized: the gizmo scales the mesh, and the
      // document stores a size. Multiplying the current size by the gizmo's
      // scale and resetting the object's own scale keeps the two from
      // compounding on the next drag.
      const volume =
        zone.volume.shape === 'box'
          ? {
              ...zone.volume,
              center: { x: object.position.x, y: object.position.y, z: object.position.z },
              size: {
                x: Math.max(0.1, zone.volume.size.x * object.scale.x),
                y: Math.max(0.1, zone.volume.size.y * object.scale.y),
                z: Math.max(0.1, zone.volume.size.z * object.scale.z),
              },
              yaw: object.rotation.y,
            }
          : {
              ...zone.volume,
              center: { x: object.position.x, y: object.position.y, z: object.position.z },
              radius: Math.max(0.1, zone.volume.radius * Math.max(object.scale.x, object.scale.z)),
              height: Math.max(0.1, zone.volume.height * object.scale.y),
            };

      object.scale.set(1, 1, 1);
      return updateZone(document, selection.id, { volume });
    });
  }, [apply, selection, target]);

  if (!target || mode === 'select' || mode === 'play') return null;

  return (
    <TransformControls
      ref={controls as never}
      object={target}
      mode={mode}
      onMouseUp={commit}
      // 10 cm and 15°, so an author can line two walls up without pixel-hunting.
      // The runtime quantizes position to centimetres anyway, so anything finer
      // is precision the wire format discards.
      translationSnap={0.1}
      rotationSnap={Math.PI / 12}
      scaleSnap={0.1}
    />
  );
}

/**
 * Orbit, but disabled while the gizmo has the mouse.
 *
 * Without this, dragging a translate handle also spins the camera, and the
 * object ends up somewhere neither the author nor the editor intended.
 */
function EditorCamera() {
  const mode = useEditorStore((store) => store.mode);
  const { gl } = useThree();
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    const canvas = gl.domElement;
    const onDown = (event: PointerEvent) => {
      // The gizmo sets `cursor` while it has a handle under the pointer; there
      // is no cleaner signal from drei's wrapper, and a wrong guess here only
      // costs a camera nudge.
      if ((event.target as HTMLElement).style.cursor) setDragging(true);
    };
    const onUp = () => setDragging(false);
    canvas.addEventListener('pointerdown', onDown);
    window.addEventListener('pointerup', onUp);
    return () => {
      canvas.removeEventListener('pointerdown', onDown);
      window.removeEventListener('pointerup', onUp);
    };
  }, [gl]);

  return (
    <OrbitControls
      makeDefault
      enabled={!dragging && mode !== 'play'}
      target={[0, 1, 0]}
      // Just short of horizontal, so the camera cannot end up under the floor
      // looking up at the underside of a room.
      maxPolarAngle={Math.PI / 2.05}
    />
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// FR-9.3 — walking the draft
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Play mode: the runtime, with colliders built from the **draft**.
 *
 * `buildPhysics` and `LocalPlayer` are the ones participants use, unmodified.
 * That is the whole of `FR-9.3`'s "accurate preview" and of `FR-9.10`'s
 * "authored zones behave at runtime exactly as specified in Phase 3" — there is
 * no second implementation to be accurate *to*.
 *
 * The physics world is rebuilt whenever the draft changes, and freed on the way
 * out. Rapier holds WASM memory no JavaScript collector can see (`NFR-14`), so
 * leaving one behind per play session is a leak with a shape nobody would find.
 */
function PlayMode({ document, tuning }: { document: MapDocument; tuning: ClientTuning }) {
  const { scene, gl } = useThree();
  const [physics, setPhysics] = useState<PhysicsWorld | null>(null);

  useEffect(() => {
    const spawn = document.spawns.find((candidate) => candidate.default) ?? document.spawns[0];
    if (!spawn) return;

    let built: PhysicsWorld | null = null;
    try {
      built = buildPhysics(scene, spawn.position, tuning, document);
      setPhysics(built);
    } catch {
      // A draft that cannot produce colliders is one that would not run for
      // participants either. The toolbar surfaces it; taking the editor down
      // would lose the author's work over something they are mid-way through
      // fixing.
      setPhysics(null);
    }

    return () => {
      setPhysics(null);
      built?.world.free();
    };
  }, [document, scene, tuning]);

  // The same input attachment the runtime uses, on the editor's canvas.
  useEffect(() => attachInput(gl.domElement), [gl]);

  return physics ? <LocalPlayer physics={physics} tuning={tuning} /> : null;
}
