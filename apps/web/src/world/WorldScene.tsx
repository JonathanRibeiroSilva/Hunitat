/**
 * The 3D scene.
 *
 * Mounted only once the world is fully loaded — the canvas is never shown
 * partially built (specs/ux/phase-01-screens.md).
 */

import { Canvas } from '@react-three/fiber';
import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { TUNING, type ClientTuning } from '@hubitat/protocol';
import { attachInput } from './input.js';
import type { LoadedWorld } from './loadWorld.js';
import { LocalPlayer } from './LocalPlayer.jsx';
import { RemoteAvatars } from './RemoteAvatars.jsx';
import { Proximity } from '../interact/Proximity.jsx';

export function WorldScene({ world, tuning }: { world: LoadedWorld; tuning: ClientTuning }) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    return attachInput(element);
  }, []);

  const environment = world.document.environment;

  return (
    <div ref={containerRef} className="absolute inset-0" tabIndex={0}>
      <Canvas
        shadows
        dpr={[1, 2]}
        camera={{
          fov: TUNING.CAMERA_FOV_DEG,
          near: TUNING.CAMERA_NEAR_M,
          far: TUNING.CAMERA_FAR_M,
        }}
        gl={{ antialias: true, powerPreference: 'high-performance' }}
        onCreated={({ gl, scene }) => {
          gl.toneMapping = THREE.ACESFilmicToneMapping;
          scene.background = new THREE.Color(environment.background);
          if (environment.fog) {
            scene.fog = new THREE.Fog(
              environment.fog.color,
              environment.fog.near,
              environment.fog.far,
            );
          }
        }}
      >
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
          shadow-camera-left={-40}
          shadow-camera-right={40}
          shadow-camera-top={40}
          shadow-camera-bottom={-40}
          shadow-camera-far={120}
        />

        {/* The loaded GLB. COL_/SPAWN_/NAV_ nodes were hidden while building
            physics, so this renders visual geometry only. */}
        <primitive object={world.scene} />

        {/* Phase 9, `DC-9.2` — everything the editor placed in this room. */}
        <PlacedObjects world={world} />

        <LocalPlayer physics={world.physics} tuning={tuning} />
        <RemoteAvatars tuning={tuning} />

        {/* Phase 10, `FR-10.2` — which interactive object is in reach. Inside
            the scene because it is a per-frame answer to a question only the
            frame loop knows the input to. It renders nothing. */}
        <Proximity document={world.document} />
      </Canvas>
    </div>
  );
}

/**
 * Placed objects, instanced from the loaded asset set.
 *
 * Cloned per placement rather than loaded per placement: a room with eight of
 * the same chair holds one copy of its geometry and eight transforms, which is
 * the difference between a library being usable and a library being a download.
 *
 * **No colliders.** Collision is authored as `collision` zones in the Map
 * Document (`FR-3.2`, `FR-9.5`), and the server's spawn placement reads those
 * same volumes — deriving colliders from placed geometry here would give the
 * client a wall the server cannot see, and an arrival would be put inside it.
 */
function PlacedObjects({ world }: { world: LoadedWorld }) {
  const instances = useMemo(() => {
    return world.document.objects
      .map((object) => {
        const source = world.assets.get(object.assetId);
        if (!source) return null;

        const model = source.clone(true);
        model.traverse((child) => {
          const mesh = child as THREE.Mesh;
          if (mesh.isMesh) {
            mesh.castShadow = true;
            mesh.receiveShadow = true;
          }
        });
        return { id: object.id, transform: object.transform, model };
      })
      .filter((instance): instance is NonNullable<typeof instance> => instance !== null);
  }, [world]);

  return (
    <>
      {instances.map((instance) => (
        <group
          key={instance.id}
          position={[
            instance.transform.position.x,
            instance.transform.position.y,
            instance.transform.position.z,
          ]}
          rotation={[
            instance.transform.rotation.x,
            instance.transform.rotation.y,
            instance.transform.rotation.z,
          ]}
          scale={[
            instance.transform.scale.x,
            instance.transform.scale.y,
            instance.transform.scale.z,
          ]}
        >
          <primitive object={instance.model} />
        </group>
      ))}
    </>
  );
}
