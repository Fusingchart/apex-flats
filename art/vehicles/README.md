# Apex original vehicle collection

Six original car designs authored with Blender 4.5 LTS. These are custom generic designs, not replicas of production cars and not downloaded Sketchfab meshes.

- `apex-vehicles.blend`: editable scene, with each named car in its own collection. Assemblies are arranged separately on the studio floor. Wheels have explicit parents; brakes, lenses, mirrors and body panels remain separate objects.
- `*-studio.png`: Cycles renders of each model, before game conversion.
- `../../tools/build_cars.py`: deterministic, editable Blender modeling script. Shape parameters are in `DESIGNS`.
- `../../assets/cars/custom/*.glb`: self-contained game exports.
- [Interactive model viewer](../../car-studio.html): orbit, zoom, front/rear/profile views, wireframe and model switching using the game's actual model loader.

## Rebuild

Use Blender 4.5 LTS (or its official `bpy==4.5.3` Python module under Python 3.11):

```sh
blender --background --python tools/build_cars.py
```

Render all studio previews:

```sh
APEX_RENDER=1 blender --background --python tools/build_cars.py
```

For one design iteration, set `APEX_CAR_IDS=gt` (or a comma-separated selection). Run the full build again before committing: the saved `.blend` contains only the selected cars.

## Construction

Bodies use dense quad cross-sections with actual open wheel arches and passenger cavities. Analytic surface normals prevent boolean boundaries from pinching reflections. Roof, glass, pillars, door gaps, vents, mirrors, lamps, seats, dashboard, steering wheel, tires, rim barrels, spokes, brake discs and calipers are modeled geometry. Materials are glTF-compatible PBR materials; no external car textures are required.

The browser retains authored normals while the body is intact or repaired, recalculates normals on dents, merges wheel meshes by material, and leaves calipers stationary while the wheel rotates. Every preset selects a stable model ID. The procedural fallback remains available if a GLB fails to load.

These are real-time assets. Small details and glass use simplified rendering in the game; Cycles studio lighting is not the same as the street scene's lighting.
