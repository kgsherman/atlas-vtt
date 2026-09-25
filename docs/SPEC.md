# Atlas VTT — Product spec (from the project owner)

I want to build a browser-based virtual tabletop (VTT) called Atlas VTT in TypeScript. The core idea: the DM builds maps as real 3D scenes made of multiple stacked levels, and players experience them in a 2.5D top-down view where lighting, shadows, and line of sight are computed from the actual 3D geometry.

## Tech stack
- TypeScript
- Three.js for rendering
- shadcn for UI components (use preset `--preset b5UKukPFuS` -- ensure that when creating new UI elements, you default to composing them from shadcn UI components where possible)
- supabase on the backend (use the MCP; project is called "atlas-vtt")
- Scene data stored as versioned JSON so maps can be saved, loaded, and shared

## DM mode: scene composition
- A scene is made of multiple levels (e.g. cellar, ground floor, upper floor, roof), each with its own elevation and floor height
- Grid-based building on a square grid (5ft squares), with snapping and optional free placement
- Tools for: floors, walls (with height and thickness), doors (open/closed/locked, blocks sight when closed), windows (blocks movement but not sight), stairs/ladders/ramps linking levels, pillars, and simple props (tables, crates, trees) from a primitive library, and heightmap painting for each level
- Light sources placeable anywhere in 3D: torches, lanterns, braziers, magical light, sunlight/moonlight as a directional light. Each has colour, bright radius, dim radius, flicker, and on/off state
- Per-level visibility toggles and a "ghost" view of adjacent levels while editing
- Undo/redo, copy/paste, multi-select
- A free 3D orbit camera for editing, plus a button to preview the player view

## Player mode: 2.5D top-down play
- Orthographic camera looking straight down on the player's current level
- Automatic cutaway: anything above the token's current level is hidden or faded, so players see into rooms, not onto roofs
- Tokens that live on a specific level and move between levels via stairs/ladders
- Grid-based movement with measurement ruler, with the DM able to lock/unlock movement

## Lighting and vision (the key feature)
- Real-time dynamic shadows from all light sources, cast by the 3D geometry (walls, pillars, props, floors of other levels)
- Line of sight computed per token from eye height in 3D, so a low wall blocks a halfling's view but not a giant's, and a character on a balcony can see down into a courtyard
- By default a token sees from anywhere in its square (its eye point and the corners of its space, as if leaning around a corner, like 5e's cover rule); the DM can switch a map to "eye point only"
- Vision types per token: normal, darkvision (with range, rendered greyscale), blindsight, and blind
- Fog of war with three states: currently visible, previously explored (dimmed, shows static geometry only, no tokens), and unexplored (black)
- Each player sees only what their own tokens can see; shared vision for party members is a toggle
- The DM always sees everything, with an option to preview any token's vision
- Performance target: 60fps on a mid-range laptop with ~20 lights and ~15 tokens. Explain the techniques you use to get there (shadow map budgeting, light culling, caching static occlusion, etc.)

## Multiplayer
- DM hosts a session; players join via a room code
- DM is authoritative: players send movement requests, DM client/server validates and broadcasts
- Players never receive data about things they can't see (don't just hide it client-side)
- Reconnection handling so a dropped player rejoins in the same state
