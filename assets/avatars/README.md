# Avatars

`avatar.glb` is committed. To rebuild it after editing the rig, the proportions or the clips:

```bash
node assets/avatars/build-avatars.mjs
```

## What this is

[ADR 0010](../../docs/adr/0010-3d-formats-gltf-vrm.md) chose **VRM** avatars with retargeted
**Mixamo** animations, and that is still where this goes. `build-avatars.mjs` stands in for it the
same way `../world/build-world.mjs` stands in for a modelled world: it emits a real glTF 2.0
binary with a real node hierarchy and real animation samplers, so the client exercises
`GLTFLoader`, `AnimationMixer`, cross-fades and additive blending against an actual asset.

What it is _not_ is a skinned mesh. The figure is boxes parented to joint nodes — rigid segments,
no `skins`, no joint weights. The animation path is identical either way (channels drive node
rotations; the mixer does not care what hangs off them), and the part that differs is exactly the
part a real VRM brings with it.

## Replacing it

A swap is a file replacement plus `@pixiv/three-vrm`, provided the replacement carries the
contract below. Both halves of it are declared in
[`packages/protocol/src/avatar.ts`](../../packages/protocol/src/avatar.ts), and the client logs a
warning naming anything missing rather than failing silently.

**Clips**

| Clip                                          | Kind       | Notes                                                                                                                                             |
| --------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `idle` `walk` `run` `jump`                    | locomotion | selected by planar speed; `walk` and `run` are authored at 3 m/s and 6 m/s and played back at `speed / reference` so feet do not skate (`FR-4.3`) |
| `wave` `point` `clap` `dance` `cheer` `think` | emote      | **upper body only**, starting and ending at the rest pose                                                                                         |

The emote constraint is load-bearing. Those clips are made additive and layered over locomotion,
which is what lets someone wave while walking (`FR-4.16`) and what makes "does not permanently
alter the avatar" true by construction rather than by a cleanup step. A clip that moves the hips
or legs will fight the locomotion track; a clip that does not return to rest will leave the avatar
bent.

## The self-check

`build-avatars.mjs` refuses to write an asset that fails six assertions, the same way the api
refuses to boot on a contradictory configuration:

| Assertion                                               | The bug it catches                                                                                                                                                                                                                                                 |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| The planted foot travels backwards relative to the hips | A knee that flexes during stance instead of during swing slides the planted foot forward — the avatar walks backwards, and every sign in the file is individually defensible                                                                                       |
| No sole reaches more than 2.5 cm below the floor        | Hips that do not follow the lowest leg, or an ankle that does not cancel the leg's accumulated rotation. The foot's rotation is local to the shin, so an ankle measured correct can still bury the sole                                                            |
| No gait curve turns a corner                            | A joint whose _velocity_ steps. Every pose is right and the avatar trembles: `Math.max(0, cos)` for a knee and `Math.max(a, b)` for the stance leg keep the value they were reaching for and destroy the slope, and the hips carry the whole body along the result |
| Knees never rotate `+X`, elbows never rotate `−X`       | Joints bending the wrong way. Knees bend backwards, elbows forwards; the two are opposite and easy to transpose                                                                                                                                                    |
| Emote clips start and end at the rest pose              | An additive clip with a non-zero first frame bakes its offset in permanently                                                                                                                                                                                       |
| Emote clips animate nothing from the hips down          | The additive layer fights the locomotion clip and the legs stop mid-emote                                                                                                                                                                                          |

The first and third both shipped broken. Neither was visible in review, and neither is visible in
a still frame — one needs the foot measured over a cycle and the other needs the second derivative
of a curve. Anything replacing this generator — including a real VRM — is worth putting through the
same measurement, because none of these failures look like a bug in the thing that caused them.

**Materials**

`Skin` · `Hair` · `Top` · `Bottom` are recoloured per participant from the palettes in
`avatar.ts`. `Detail` is fixed (eyes, shoes, glasses) and is the colour it renders.

**Node names**

- `AvatarRoot` — the whole figure, cloned and disposed as a unit
- `BODY_*` — parts the build variants scale in girth; the head is deliberately excluded
- `ACC_cap` `ACC_glasses` `ACC_backpack` — shipped hidden, shown by appearance

**Scale**

Origin at the feet, `+Y` up, facing `-Z` at yaw 0, exactly `AVATAR_HEIGHT_M` (1.70 m) from sole to
crown. The physics capsule, the camera target and the nameplate anchor are all derived from that
height, so a model of a different size will look right and stand wrong.
