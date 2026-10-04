# Apex Flats

A 3D driving game in the browser, built with Three.js. You drive a city on a hazy afternoon: a dense downtown of glass, concrete and brick towers, apartment blocks, suburbs, a freeway with interchanges, and hills beyond. The traffic follows the rules, the police enforce them, the cars crumple when they hit things, and you can earn and collect 24 original cars.

## Run it

Serve the folder over HTTP (the model and HDR loaders require it):

```bash
npx serve .
```

Three.js and the fonts load from a CDN, so the first load needs an internet connection.

## Controls

| Key | Action |
| --- | --- |
| W / ↑ | Throttle |
| S / ↓ | Brake, hold at a standstill to reverse |
| A D / ← → | Steer |
| Space | Handbrake |
| Q / E | Shift down / up (switches to manual) |
| T | Back to automatic |
| C | Cycle camera |
| V | Garage: buy or drive an owned car |
| J | Contract board |
| B | Business (Apex Holdings CEO panel) |
| Tab | Full map |
| R / Shift+R | Repair and drop back onto the nearest lane (Shift also tidies up knocked-over props) |
| Z | Slow motion (¼ speed, free roam only) |
| M | Mute |
| G | Graphics quality (low / medium / high) |
| H | Hide the controls panel |

Gamepads work (left stick, triggers, A for handbrake), and phones get on-screen buttons.

## Career and contracts

You start with $2,500, the Commuter sedan, and the Metro hatchback. **J** opens 50 contracts across ten tiers (ranks 1–22): deliveries, checkpoint races, clean driving, drifting, and police escapes. Later tiers chain several legs across the valley with tighter limits; deliveries from tier 4 carry cargo that crashes damage (lower pay), and from tier 7 it is fragile (below 50% the job fails). Escapes go up to five stars. **V** opens the 24-car garage. Each car has a cash price and a rank requirement.

Starting a contract takes you to its road start and repairs your car. Follow the green world marker, directional arrow and map checkpoint line. Delivery stops require two stationary seconds. Race checkpoints must be crossed in order. Clean driving counts asphalt distance at 18–108 km/h and resets after collisions. Drift points require a moving, grounded slide on asphalt. Escape contracts start a pursuit; evade it after driving at least 150 m. Recovery or being busted ends the run without a reward. Menus pause gameplay and the timer; slow motion is disabled during contracts.

Every completion awards cash and XP. First clears add 50% base cash and 100 XP; gold (within 55% of the time limit) adds 25% base cash, silver (within 78%) adds 10%. Best times, best medals and completion counts are saved. Contracts can be replayed for regular rewards. Rank uses `1 + floor(sqrt(XP / 350))`, capped at 50. Police fines deduct available cash without putting the wallet into debt. Recovery and repairs stay free so a damaged starter never blocks progression.

## Apex Holdings (business)

**B** opens the CEO panel. Properties are marked on the map with **$** and in the world with light beams (amber once owned).

- **Courier Depot** ($45k, rank 3) needs no office. Every other business needs an **office**: Ashby Plaza ($100k, rank 5, 3 slots), Riverside Tower ($600k, rank 12, 5 slots), Summit Penthouse ($2M, rank 22, 6 slots). Better offices add 5–20% to sale value; moving up trades the old one in at half price.
- **Production businesses** (Courier Depot, Southbank Salvage, Harbour Import/Export, Ashby Freight Hub, Apex Prototype Labs) turn supplies into stock over time. Buy supplies from anywhere, or drive there and steal them for free (bigger businesses draw police). Selling sends you on a multi-drop delivery from the property; crashes cut the value, and failing loses a quarter of the stock. Large loads can trigger a police tip-off.
- **Club Meridian** ($750k, rank 15) fills a safe while it is popular. Popularity fades; promote it with a checkpoint run and collect the safe in person.
- **Upgrades** per business: equipment (faster production / slower decline), staff (+30–40% value), security (80% fewer raids).
- **Upkeep** is charged every business day (12 minutes of play). A business you can't pay for stops until you pay it.
- **Raids** hit busy properties. You get four minutes to reach the property and hold position, or lose 40% of the stock (half the safe).
- **Milestones** pay out from $10k (first business) up to $1M for a $20M net worth (Valley Tycoon).

Business time runs while the game is open (menus included) and stops when the tab is hidden or closed.

Progress saves locally under `apex.career.v1` in browser storage: cash, XP, owned and selected cars, contract records, and the business empire. Active runs do not survive reload. Saves are specific to the browser and origin; this is a single-player local career, with no account or cloud sync. A blocked or full storage area is reported in the contract board, and play continues in memory.

## The cars

| Car | Family | Price | Rank |
| --- | --- | --- | --- |
| Commuter | Sedan | Starter | 1 |
| Metro | Hatchback | Starter | 1 |
| Sprint | Hatchback | $6,500 | 1 |
| Heritage | Muscle coupe | $9,500 | 1 |
| Hot Hatch | Hatchback | $11,500 | 2 |
| Trail Estate | Sedan | $12,000 | 2 |
| Cross City | Utility | $14,000 | 2 |
| Club Sport | Hatchback | $15,500 | 2 |
| Executive | Sedan | $18,000 | 2 |
| Summit | Utility | $20,000 | 2 |
| Sportline | Sedan | $23,000 | 4 |
| Rover XL | Utility | $26,000 | 4 |
| Rally Cross | Hatchback | $28,000 | 4 |
| Torque V8 | Muscle coupe | $30,000 | 4 |
| Trail Scout | Utility | $32,000 | 4 |
| Barracuda | Muscle coupe | $35,000 | 4 |
| Interceptor | Sedan | $38,000 | 7 |
| Apex GT | Grand tourer | $42,000 | 7 |
| Alpine Sport | Utility | $46,000 | 7 |
| Falcon RS | Grand tourer | $55,000 | 7 |
| Endurance GT | Grand tourer | $68,000 | 11 |
| Vortex | Supercar | $92,000 | 11 |
| Spectre | Supercar | $125,000 | 15 |
| Zenith | Supercar | $180,000 | 20 |

Each has its own body style, gearing, torque curve, grip, brakes and centre of gravity. The tyre model works per wheel. Loads shift front to back under braking and acceleration, and side to side in corners, shared between the axles by roll stiffness. Tyres lose efficiency as load rises, slip angles build up over a short distance of rolling, and each wheel gets its own share of drive, brakes and handbrake. Peak lateral grip is about 1.0–1.15 g for the road cars and 1.27 g for the Vortex. A stability assist steers the car where you point it and catches slides. It mostly lets go just after a handbrake pull, or when you hold full throttle and steer into the slide, so you can still drift. It's lightest on the rear-drive cars. Steering into a slide always gets enough lock to catch it, the cars gain a little downforce at speed, and traction control stops wheelspin on launch. Front-drive cars spin their front wheels and understeer under power; rear-drive cars oversteer; all-wheel drive splits the torque 42/58. All of them stop from 100 km/h in about 40 m.

## The world

A 3.5 km square, generated at load (about half a second):

- **Downtown** (the middle 600 m): towers of three height classes, every junction signalised.
- **Suburbs**: a 15 × 15 grid of junctions 150 m apart. Arterials every 450 m (50 km/h, painted lines), residential streets between (40 km/h), some with S-bends, some links missing for T-junctions. About 2,200 houses with garages, driveways and lit windows, plus parks, street trees, street lights, mailboxes and bins (knockable).
- **Ring freeway**: a rounded square 2.6 km across, two lanes each way at 100 km/h, a concrete median and median lights. At eight **diamond interchanges** the freeway climbs onto a 7.5 m bridge over the crossing road. Off-ramps leave from the right lane; on-ramps feed a 180 m acceleration lane. Ramps meet the crossing road at signalised junctions, and each exit has a sign 400 m ahead.
- **Countryside**: a 70 km/h rural loop around everything, woods and open fields.

Junctions are run by traffic lights (16 s green, 3.5 s yellow, 1.5 s all-red), two-way stops (side streets stop for arterials) and all-way stops (between residential streets). Grass has less grip than asphalt. The minimap turns with your car; Tab shows the whole map.

## AI traffic

Traffic exists around you, not everywhere. A pool of 44 cars spawns out of sight 130–460 m away, in proportion to how busy each road is. It's densest downtown and on the freeway and light in the suburbs, so the count near you ranges from about 20 to 40. Cars more than about 520 m away are recycled.

Each AI car runs a front-wheel-drive version of the player's tyre model and has its own crash structure. Each driver:

- **Plans routes** to random destinations with Dijkstra and picks a new one before arriving.
- **Steers** by pure pursuit on the lane centre, with speed-scaled look-ahead and a little personal wander.
- **Controls speed** with the Intelligent Driver Model, capped by the speed limit and by comfortable lateral g in curves, braking early enough to arrive at the right speed.
- **Handles junctions**: full stops at stop signs (first-come first-served at all-way stops), Highway Capacity Manual critical gaps at two-way stops (left 7.1 s, straight 6.5 s, right 6.2 s), a yellow-light stop/go decision, left turns that yield, and no entering a junction while someone is on a crossing or merging path.
- **Drives the freeway**: keeps right, overtakes slower cars, merges off the acceleration lane when there's a safe gap, and moves right well before its exit (or skips the exit if it can't).
- **Uses the pedals like a person**, with rate-limited throttle and brake.
- **Has a temperament**: desired speed, headway, acceleration, braking, patience and gap acceptance vary per driver.
- **Shows it**: indicators, brake lights, a horn if you block them, hazards after a crash.

You hear the three nearest engines, with Doppler shift as they pass.

Measured in headless runs: no AI-to-AI contact and no stop signs or red lights run across downtown (90 s), the suburbs (120 s) and around two interchanges (90 s and 150 s), with about 500 junction crossings in total. On the freeway, cars average about 90 km/h, with roughly 25 lane changes and 16 exits per 90–150 s window near an interchange. All the traffic physics costs about 0.1–0.3 ms per 240 Hz step.

## Police

Patrol cars (black and white, light bar) drive in the normal traffic. If one can see you (within range, no building in the way), these are offences:

| Offence | Wanted | Bounty |
| --- | --- | --- |
| Speeding (about 30% over the limit) | ★ | $200 + |
| Driving on the pavement or grass at speed | ★ | $300 |
| Wrong-way driving (freeway: ★★) | ★ | $300 / $900 |
| Hitting another car | ★ | $400 + |
| Ramming a police car (always counts) | ★★ | $1,500 |

While you're wanted, the stars and bounty show under the minimap and the siren gets louder as units close in. Reinforcements spawn out of sight, already heading your way, up to the number set by your level (2, 3, 4, 6 or 8 cars). Each unit has a job:

- **Chase** units sit on your tail and go for a PIT on your rear corner.
- **Flank** units pull alongside and shove you sideways.
- **Intercept** units drive to where you'll be in a few seconds and turn across your path.

They route through the street network until they can see you, then come straight at you. They overtake through the oncoming lane when it's clear, brake for cross traffic, steer round walls, and reverse out of jams. Units stuck somewhere you can't see are quietly replaced. From three stars, roadblocks of two cruisers go up across the road ahead; from four, a helicopter circles overhead and keeps you in its searchlight unless something is over your head. Civilian drivers pull over for sirens, and brake, swerve and honk when you come at them fast. Staying in view raises your level every 40 s, and wrecking two cruisers raises it by one. Your bounty grows the whole time.

To escape, break line of sight and keep every unit more than 60 m away until the stars stop flashing (13 s at one star, plus 4 s per extra star). The bounty stays on your head and fades slowly; above $1,500, any cop who gets a good look at you will start a chase. If you stop with a cruiser alongside for 3 s, you're busted: you pay the bounty and start again on the nearest road.

## Crash model

The car body is a lattice of 200 nodes (5 across, 4 high, 10 long) joined by about 1,700 beams, solved with XPBD at up to 2,400 Hz during contact.

- **Plastic steel.** Beams yield past a strain limit and keep their new length, so dents are permanent. Overstretched beams tear.
- **Crumple zones.** The passenger cell is about 3× stronger than the engine bay and boot; floor rails are stiffer again; door skins are weaker than pillars.
- **Two-way coupling.** The force obstacles exert on the contacting nodes decelerates and spins the car; in car-to-car hits the other car gets the equal and opposite push. Springback returns only a small share of the energy.
- **Rendering.** The visible body is bound to the lattice by free-form deformation: panels wrinkle where crushed, paint flakes and scuffs, glass crazes.
- **Consequences.** Bent wheels pull and lose grip, a crushed engine bay cuts power and steams then smokes, parts tear off, lights go dark.

A 71 km/h hit on a downtown tower peaks at about 25 g and leaves the engine at 25% power.

## Rendering

Daylight uses the photographed HDR sun direction, exposure-balanced sky fill, and shadows snapped in light space at each graphics quality. A restrained colour grade preserves neutral paint and building colours.

The scene renders into a half-float, 4× multisampled HDR buffer and then goes through:

- **Ambient occlusion** from the depth buffer, at half resolution: 12 samples and a depth-aware blur. It darkens corners, kerbs, building bases and the ground under cars.
- **Bloom** from a five-level mip chain of the brightest pixels: sun glints, lamps, brake lights, sirens.
- **Final pass:** ACES filmic tone mapping, then a grade in display space (cooler shadows, warmer highlights, a little more contrast and colour), vignette and dithering.

Lighting comes from the sun (soft 4096² shadow map that follows the car) plus a prefiltered sky environment map, which also gives the reflections on glass, clear-coated paint and water.

Cars use custom Blender body skins with clear-coat paint, tinted glass, modeled panel shut lines, grilles and rocker sills. Wheels have rounded tires, machined-style spokes, brake rotors and stationary calipers. The body panels bind to the crash lattice and deform on impact.

Press **G** to cycle graphics quality:

| Preset | Resolution cap | Shadow map | Ambient occlusion | Bloom |
| --- | --- | --- | --- | --- |
| Low | 1× | 1024² | off | off |
| Medium | 1.25× | 2048² | on | on |
| High | 1.5× | 4096² | on | on |

If the adaptive resolution has already dropped to its floor and the frame rate still can't be held, the game steps down a preset by itself.

## Performance

Static scenery is instanced in 400 m chunks with real bounding spheres, so whole chunks are culled, and each kind of object has a view distance (mailboxes about 200 m, towers always). Chunk meshes are static, so their matrices aren't recomputed every frame.

- **Distant buildings:** beyond about 620 m, a chunk's buildings swap to a single merged, vertex-coloured mesh with windows and storeys sketched by the shader, replacing around 20 instanced draws.
- **Distant trees:** beyond 300 m, crowns and firs swap to one indexed low-poly mesh per chunk.
- **Distant traffic:** cars beyond 140 m are drawn together as one instanced stand-in.
- **Terrain:** distant terrain uses 1 km tiles.
- **Shadows:** only chunks near the car cast shadows.

Together these took a typical downtown frame from about 1,540 draw calls and 3.6M triangles to about 730 calls and 2.3M triangles. Signal lamps share one instanced mesh. Traffic cars are about 10 draw calls each. Resolution adapts between 0.6× and 1.5× to hold about 60 fps. A slow frame never slows down the simulation.

## Layout

- `index.html` — page, HUD, car picker, garage and map markup
- `car-studio.html` — interactive model inspection
- `tools/build_cars.py` — Blender vehicle authoring and export
- `art/vehicles/` — editable Blender source and studio renders
- `src/career.js` — persistent wallet, ownership, rank and renderer-independent mission rules
- `src/missions.js` — road-based contracts, world markers, mission board and results
- `assets/cars/designs.json` — 24 authored shape definitions and economy metadata
- `src/style.css` — HUD and overlay styles
- `src/post.js` — HDR post-processing: ambient occlusion, bloom, tone mapping and grade
- `src/softbody.js` — the lattice solver and free-form deformation
- `src/carmesh.js` — lofted car bodies (coupe, sedan, hatch, SUV) and bolt-on parts
- `src/city.js` — the world: road graph, lanes, freeway and ramps, junction control, signals, height field, scenery
- `src/traffic.js` — AI vehicles: spawning, dynamics, the driver model, collisions and police pursuit driving
- `src/police.js` — offences, wanted level, bounty, evasion and busting, the HUD stars and the siren
- `src/main.js` — scene, player physics, car presets, collisions, damage, audio, input, camera, HUD and loop

Base physics tuning lives in `BASE_PRESETS` in `src/main.js`; per-car shape, paint, power/mass scaling, price and rank live in `assets/cars/designs.json`. Rebuilding derives `assets/cars/cars.json` from those definitions. Traffic density is `DENSITY` in `src/city.js`; the pool size is `max` in the `createTraffic` call. In the browser console, `apex.car`, `apex.crash` and `apex.traffic.vehicles` show live state, and `await apex.chooseCar(apex.PRESETS[n])` swaps owned cars outside active contracts.

## Assets

The sky, ground, building and foliage assets are CC0 (public domain) from [Poly Haven](https://polyhaven.com) and live in `assets/`:

- **Sky:** the HDR panorama *Kloofendal 48d Partly Cloudy (Pure Sky)*, a sunny afternoon with the sun 47° up. It is the visible sky and the lighting environment, and the sun's direction and colour are read from it.
- **Ground:** *Aerial Asphalt 01* (roads), *Concrete Pavement* (pavements), *Aerial Grass Rock* (open ground). Each has colour, normal and roughness maps, tiled in world space.
- **Buildings:** *Red Brick 03*, *Beige Wall 001*, *Exterior Wall Cladding 03* (house siding), *Concrete Wall 008*, *Corrugated Iron 02*, *Grey Roof 01* (shingles) and *Gravel* (flat roofs), with colour and normal maps. Walls are mapped in metres along each face, and ledges and roofs use triplanar projection.
- **Foliage:** the leaf atlas from *Jacaranda Tree*, the bark from the same tree, and the blade atlas from *Grass Medium 02*. Trees are built from alpha-cut cards of these. Conifer branches and hedges are drawn in code.

Grass is two instanced layers that follow the camera: dense clumps to about 50 m and bigger clumps out to about 160 m. Both sway in the wind and stay a metre clear of roads and paths.

### Cars

The 24 cars are **original Blender models**, generated by `tools/build_cars.py`. Six construction families provide 24 body profiles with different lengths, widths, roof heights, wheelbases, cabin proportions and wheel designs. The previous downloaded vehicle pack has been replaced.

The editable source is `art/vehicles/apex-vehicles.blend`, with studio renders and rebuilding instructions beside it. Exported GLBs live in `assets/cars/custom/`. Open **`car-studio.html`** to orbit and inspect each model, switch camera angles, or see the wireframe.

The models have sculpted body skins, open wheel arches, passenger cavities, curved glass, panel gaps, lamps, interiors, forged-style wheels, brake discs and stationary calipers. Body geometry is copied when it needs to crumple. Authored Blender normals are preserved on undamaged and repaired surfaces.

`assets/cars/cars.json` maps stable IDs to files. The player presets use explicit IDs, while traffic selects from the collection. Six traffic models preload; other models load on demand. A failed purchase download does not charge cash. Startup retains a procedural fallback if a saved model is unavailable. To add a model, use an explicit `id`, `file`, `length`, `forward` and `up`. Set `authored: true` for this collection's material handling.

## Verification

Run `node --test tests/*.test.cjs` for career transactions, save validation, mission lifecycle, reward deduplication, HDR sun-direction and authored-normal regression tests. Browser smoke tests additionally cover all 24 model loads, menu flows, completion payouts, purchases, persistence, recovery and responsive layouts.


For the browser suite and preview generator, install development tools with `npm ci`. The suite uses installed Google Chrome. Start `python3 -m http.server 8085 --bind 127.0.0.1` in another terminal, then run `npm run test:browser`. Set `APEX_URL` to use a different server address. `npm run render:cars` regenerates the garage JPEGs from the actual game loader in the model studio.
