# SafeRoute demo video: production script and instructions

This document is the complete brief for producing the SafeRoute demo video. It is written for an
AI agent (Claude Opus 5.5 in Cursor) running on the team's VM, which has no screen recorder. The
agent records the live app with headless Google Chrome over the DevTools protocol, then assembles
the video with ffmpeg. Everything needed is on the VM already.

**Deliverable:** one MP4, **2:00 to 2:30 long (hard limit 3:00)**, 1920x1080, 30 fps, H.264,
with burned-in captions, a title card and a closing card.

---

## 1. What SafeRoute is (read this first, so captions are accurate)

SafeRoute is an evacuation-drill web app. During a simulated wildfire or hurricane, it uses AI
video models on real street-camera footage to decide which Manhattan intersections are still
usable, predicts which ones fail next, and routes a driver from Home to a destination around the
danger.

How it works, end to end:

1. **Real footage from the VAST archive.** 100 real NYC street-camera clips (cameras
   `nyc_streets_cam-1` and `nyc_streets_cam-2` in the VAST video archive) are pinned to a 10x10
   grid of Midtown intersections: 11th Ave to Lexington Ave, W 59th St to W 41st St.
2. **Simulated disaster on that footage.** ffmpeg renders each clip at 3 damage levels per
   scenario: wildfire (orange smoke, then camera failure) and hurricane (darkening, street
   flooding, lightning, shaking, then camera failure).
3. **AI watches every clip.** 700 clips in total (100 normal-day + 2 scenarios x 3 levels x 100):
   - **Pixel signal check** (ffmpeg + numpy): is the feed dark or frozen? If so, the camera is lost.
   - **NVIDIA Cosmos3-Reason** (model id shown in the app: `nvidia/cosmos3-nano-reasoner`) watches
     the clip and reports passable yes/no, visibility, traffic, hazards and a one-sentence reason.
   - **YOLO11** counts vehicles and people per frame.
   - Normal-day clips that Cosmos already judges impassable (street fairs, closures) are swapped
     for other archive footage, so T+0 is a fair baseline.
   This one-time analysis takes about 7 minutes and is already done. **Do not trigger it.**
4. **Disaster spread uses live wind.** Open-Meteo gives the real current wind for Midtown. The
   disaster starts at a random location and spreads downwind over T+0, T+10, T+20, T+30 minutes.
5. **Predict, then verify.** At each step, corners downwind of a hit corner are predicted to fail
   next. At the next step the app scores the prediction against what the models actually saw
   ("we flagged 6 corners, 6 of 6 did").
6. **Routing.** Dijkstra over the grid. Lost and blocked corners are avoided, predicted corners
   are avoided if possible, and caution corners cost more. Every trip starts at **Home**
   (11th Ave & W 59th St). Destinations are **School** (Madison Ave & E 41st St), **Work**
   (Park Ave & E 55th St) and **Times Square** (7th Ave & W 45th St).
7. **Dispatcher briefing.** W&B Inference (Llama 3.1 8B) writes a two-sentence dispatcher
   briefing for every time step and destination, from the route facts only.
8. **Observability.** Every model call is traced to W&B Weave and also shown live in the app's
   **Model calls** panel, with timings and Weave trace ids.
9. **Precomputed.** Each disaster is built from the pre-analyzed library with all 3 routes and
   all 12 briefings computed up front, so a new disaster or a destination switch is instant.

### Claims you may make
- "100 real NYC street cameras from the VAST video archive"
- "NVIDIA Cosmos3-Reason watched 700 clips"; "YOLO11 counts vehicles and people"
- "Simulated wildfire / hurricane rendered onto archived footage"
- "Live wind from Open-Meteo"; "predicts which corners fail next, then checks itself"
- "Dispatcher briefings from W&B Inference (Llama 3.1 8B)"; "every call traced in W&B Weave"
- "A new disaster or destination is instant because the analysis is precomputed"

### Claims you must NOT make
- Not live cameras, not a real emergency system, not real-time video analysis during the demo.
  Always frame it as a **drill / simulation on archived footage**.
- No GPS, no turn-by-turn from a phone, no real disaster data.
- Do not quote specific prediction scores or distances unless they are on screen in that take
  (the disaster is random every time).

---

## 2. Environment facts

| Item | Value |
|------|-------|
| App URL (from the VM) | `http://video-lab-team-1.cosmos.vastdata.com/app/` |
| Human-facing URL | `https://workshop.thecosmoslabs.com` then the **App** button |
| Ready check | `GET /app/state` must return `"status":"ready"` |
| Chrome | `/usr/bin/google-chrome` (supports the H.264 clips) |
| Node | `node` v24 on PATH (has global `fetch` and `WebSocket`) |
| ffmpeg | `/usr/bin/ffmpeg` 6.1 with `libx264`, `subtitles`, `drawtext` |
| Fonts | DejaVu Sans: `/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf` (and `-Bold`) |
| Text-to-speech | **None installed.** Use burned-in captions. A narration script is in section 7 for an optional human voice-over. |
| Python | System `python3` only, no pip. Do not try to install packages. |
| Working dir for output | `/home/madhugarudala/vast-builders-challenge/demo_video/` (create it) |
| Scratch | `/tmp/sr_video/` for frames |

### Rules (from the workspace rules; follow them)
- **Never** run bare `env` or `printenv`, never print secrets, never put tokens on screen.
- Do not open `/app/health`, terminals, kubectl output or `/config` files on camera.
- **Do not redeploy, restart or `kubectl` anything.** A redeploy costs a 7-minute rebuild.
- **Never click "Start analysis"** or call `POST /app/prepare`. If `/app/state` is not
  `ready`, wait and poll; do not try to fix it.
- Do not record the W&B website (the project is private). The in-app **Model calls** panel is
  the W&B story.
- Do not commit the MP4 or frames to git (too large). Keep them in `demo_video/`, which is
  git-ignored.

---

## 3. App UI reference (DOM hooks for automation)

The page is a single HTML file plus `ui.js`. Theme defaults to dark (keep dark).

| What | Selector / how |
|------|----------------|
| Scenario toggle | `#scenario button[data-value="wildfire"]`, `[data-value="hurricane"]` |
| Destination buttons | `#dest button[data-cell="J8"]` School, `"C9"` Work, `"H5"` Times Square |
| Disaster card title | `#prep-title` (e.g. "Disaster #4605") and `#prep-text` |
| New disaster | `#newloc` ("New disaster location"); instant, served from a precomputed pool |
| Timeline steps | `.tstep[data-step="0"]` .. `"3"` (T+0 .. T+30); pressed one has `aria-pressed="true"` |
| Play timeline | `#play` (advances one step every 3.5 s, stops at T+30) |
| Result card | `#result` (first line "Home → School", then "T+0 · 1.9 mi · ~10 min · 16 blocks") |
| Prediction check text | `#result .verify` |
| Dispatcher briefing | `#brief` (hidden if no briefing) |
| Directions list | `#dirs` (each item is a `button[data-id]`; clicking opens that camera) |
| Hazards near route | `#avoid li[data-id]` (clicking opens that camera and zooms the map to it) |
| Camera panel | `#camera` (open when it has class `open`); close with `#camera .x` |
| Feed wall | open `#wall-btn` ("View all 100 feeds"), grid `#wallgrid [data-id]`, close `#wall-close` |
| Model calls panel | open `#calls-btn`, close `#calls-close`; tiles in `#opstats`, rows in `#calllist li` |
| Map | Leaflet. Opening a camera zooms to level 17+, where pins become live thumbnails |

Map legend colors: green safe, yellow caution, dashed orange "predicted to fail next", red
not passable, grey camera lost, blue line = route. Named places show as labels (HOME, SCHOOL,
WORK, TIMES SQ); the active trip's ends are blue.

Behavior notes:
- On load the page auto-composes a disaster for the selected scenario (wildfire by default).
- Switching destination or time step makes no server call; it repaints instantly.
- The camera panel shows the clip (autoplay, muted, loop), Cosmos verdict (passable, visibility,
  traffic, hazards, quote, confidence), pixel check (signal, brightness, motion) and YOLO counts.
- The Model calls panel polls every 2.5 s. Pressing "New disaster location" while it is open adds
  fresh `wandb_briefing` rows only if the pool had to build one; rows from the startup analysis
  and pool fills are already there.

---

## 4. Storyboard (target 2:20, never over 2:30)

Times are for the final video. "Action" is what the automation does on the page. "Caption" is
burned in at the bottom (max 2 lines, about 12 words per line). Hold each caption at least 2.5 s.

| # | Time | Duration | Action | Caption |
|---|------|----------|--------|---------|
| 0 | 0:00 | 6 s | **Title card** (ffmpeg, not the app) | "SafeRoute" / "AI evacuation routing from real street cameras" / small: "VAST Builders Challenge · team-1" |
| 1 | 0:06 | 12 s | App loaded, wildfire, School selected, T+0. Hold, then slowly hover over the route. | "A simulated wildfire hits Midtown Manhattan. Where can you still drive?" then "100 real NYC street cameras from the VAST archive, one per intersection." |
| 2 | 0:18 | 18 s | Click the first item in `#avoid` (a hazard next to the route). The camera panel opens and the map zooms to thumbnails. Hold on the panel ~10 s. | "NVIDIA Cosmos3-Reason watches each feed: passable? visibility? hazards?" then "A pixel check catches dead cameras. YOLO11 counts cars and people." |
| 3 | 0:36 | 4 s | Close the camera panel (`#camera .x`), then zoom the map back out to the full grid (section 5.4). | (none) |
| 4 | 0:40 | 16 s | Press `#play`. The timeline runs T+0 → T+30 (3.5 s per step). | "Live wind from Open-Meteo spreads the fire. Orange rings: predicted to fail next." then "Each step checks the last prediction against what the cameras actually saw." |
| 5 | 0:56 | 6 s | Click `.tstep[data-step="2"]` (T+20). Hold on `#result .verify`. | "Predict, then verify: the score is computed from the models' own verdicts." |
| 6 | 1:02 | 14 s | Click Work, hold 4 s; click Times Square, hold 4 s; back to School. Briefing card visible. | "Every trip starts at Home. Switch destination and the route recomputes instantly." then "W&B Inference (Llama 3.1 8B) writes a dispatcher briefing for each route." |
| 7 | 1:16 | 12 s | Click `#newloc` twice, 5 s apart, at T+0. | "New disaster location: different start, different spread, different safe route." |
| 8 | 1:28 | 14 s | Click hurricane. Then open `#wall-btn` (feed wall at T+20: click `.tstep[data-step="2"]` first). Hold the wall 7 s. | "Hurricane: flooding, lightning and dead cameras, rendered onto the same footage." then "All 100 feeds, laid out like the map, each judged by the models." |
| 9 | 1:42 | 4 s | Close the wall. | (none) |
| 10 | 1:46 | 16 s | Open `#calls-btn`. Hold. Optionally press `#newloc` once while it is open. | "Every model call, live: Cosmos3-Reason, YOLO11, pixel check, Llama briefings." then "Each one is traced to W&B Weave. 700 clips analyzed once, so demos are instant." |
| 11 | 2:02 | 4 s | Close the calls panel; final wide shot of the map with the route. | (none) |
| 12 | 2:06 | 10 s | **Closing card** (ffmpeg) | "SafeRoute" / "VAST video archive · NVIDIA Cosmos3-Reason · YOLO11 · W&B Inference + Weave · Open-Meteo" / small: "Evacuation drill on archived footage. Not for real emergencies." |

Total: about 2:16. If a take runs long, trim scene 3, 9 and 11 holds first. If short, extend
scene 2 and scene 10 holds. Do not go below 2:00 or above 2:30.

---

## 5. How to record

### 5.1 Pre-flight (off camera)

1. `curl -s http://video-lab-team-1.cosmos.vastdata.com/app/state` → must contain
   `"status":"ready"`. If `running`, poll every 30 s until ready (up to 10 min). Never call prepare.
2. `mkdir -p /home/madhugarudala/vast-builders-challenge/demo_video /tmp/sr_video/frames`
3. Make sure `demo_video/` is ignored by git (add `demo_video/` to the repo `.gitignore` if it
   isn't).

### 5.2 Pick a good disaster before recording

The disaster is random. Before starting the recording, in the same browser page, click
`#newloc` until the disaster is visually interesting, then click `.tstep[data-step="0"]` and the
School button. A disaster is "good" if all of these hold (check from the DOM):

- At T+0, `#result` for School does **not** contain "No way".
- For at least one destination, `#dirs` text at T+0 differs from T+20 (the route reroutes).
- At T+10, `#result .verify` exists (there was a prediction to check).
- At T+0 `#avoid li[data-id]` exists, and its first item's chip is "Not passable" or
  "Predicted to fail" (so scene 2 shows a smoky clip, not a clean one).

Try up to 15 times. Each click is instant (the pool refills about 1 s per disaster in the
background; wait 1.5 s between clicks). Then start recording.

### 5.3 Recorder: headless Chrome + DevTools screencast

Use a single Node script (ES module, `node record.mjs`). Skeleton:

```javascript
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";

const URL = "http://video-lab-team-1.cosmos.vastdata.com/app/";
const OUT = "/tmp/sr_video";
mkdirSync(`${OUT}/frames`, { recursive: true });
const W = 1920, H = 1080;

const chrome = spawn("google-chrome", [
  "--headless=new", "--no-sandbox", "--disable-gpu", "--hide-scrollbars",
  "--autoplay-policy=no-user-gesture-required", `--window-size=${W},${H}`,
  "--remote-debugging-port=9340", "--user-data-dir=/tmp/sr_video/profile", "about:blank",
], { stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let target;
for (let i = 0; i < 60 && !target; i++) {
  await sleep(250);
  try { target = (await (await fetch("http://127.0.0.1:9340/json")).json()).find((t) => t.type === "page"); } catch {}
}
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener("open", r));
let id = 0; const pending = new Map(); const errors = [];
const frames = [];               // { file, ts }
ws.addEventListener("message", (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  if (m.method === "Page.screencastFrame") {
    const file = `${OUT}/frames/f${String(frames.length).padStart(6, "0")}.jpg`;
    writeFileSync(file, Buffer.from(m.params.data, "base64"));
    frames.push({ file, ts: m.params.metadata.timestamp });
    send("Page.screencastFrameAck", { sessionId: m.params.sessionId });
  }
  if (m.method === "Runtime.exceptionThrown") errors.push(m.params.exceptionDetails.text);
});
const send = (method, params = {}) => new Promise((r) => { id++; pending.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
const js = async (expr) => (await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true })).result?.result?.value;

await send("Page.enable"); await send("Runtime.enable");
await send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 1, mobile: false });
await send("Page.navigate", { url: URL });
await sleep(8000);                       // tiles, first disaster, thumbnails

// ... inject cursor (5.5), pick a good disaster (5.2) ...

const marks = [];                        // caption timing log
const t0 = Date.now() / 1000;
const mark = (scene) => marks.push({ scene, t: Date.now() / 1000 - t0 });
await send("Page.startScreencast", { format: "jpeg", quality: 92, maxWidth: W, maxHeight: H, everyNthFrame: 1 });
const recordStart = frames.length;

// ... scenes 1-11 with mark("s1") etc. and sleeps (section 6) ...

await sleep(500);
await send("Page.stopScreencast");
const stopTs = Date.now() / 1000;
writeFileSync(`${OUT}/frames.json`, JSON.stringify({ frames: frames.slice(recordStart), stopTs, t0, marks, errors }));
ws.close(); chrome.kill(); process.exit(0);
```

Important details:
- **Screencast frames are sent only when the page changes.** Each frame has a
  `metadata.timestamp` in seconds. Build the video with the ffmpeg concat demuxer, giving each
  frame `duration = next.ts - this.ts` (last frame: `stopTs - last.ts`). This keeps real timing.
- **Ack every frame** (`Page.screencastFrameAck`) or Chrome stops sending.
- Clock alignment: `metadata.timestamp` is wall-clock epoch seconds in current Chrome. Verify by
  comparing the first frame's ts with `t0`; if they differ by more than a few seconds, compute
  caption times relative to the first frame's ts instead and offset `marks` accordingly.
- If the screencast misses frames during map animation, it's acceptable; if it stutters badly,
  fall back to a capture loop: `Page.captureScreenshot` (jpeg, quality 90) every 66 ms with
  `Date.now()` timestamps, same concat approach.

### 5.4 Resetting the map view
Opening a camera zooms the map in (to level 17+). The Leaflet map object is not global, so zoom
back out with Leaflet's own zoom-out button: click `.leaflet-control-zoom-out` 3 times, about
400 ms apart, then wait 1.5 s for tiles. Do not switch scenario to reset the view; that composes
a new disaster.

### 5.5 Visible cursor (headless has none)
Inject a fake cursor so viewers can follow clicks. Before recording:

```javascript
await js(`(() => {
  const c = document.createElement('div');
  c.id = 'democursor';
  c.style.cssText = 'position:fixed;z-index:99999;width:22px;height:22px;border-radius:50%;'
    + 'background:rgba(255,255,255,.9);border:3px solid #5b8cff;box-shadow:0 0 0 6px rgba(91,140,255,.25);'
    + 'left:960px;top:540px;transform:translate(-50%,-50%);transition:left .7s ease,top .7s ease,transform .15s;pointer-events:none';
  document.body.appendChild(c);
  window.demoClick = async (sel) => {
    const el = document.querySelector(sel); if (!el) return false;
    const r = el.getBoundingClientRect();
    c.style.left = (r.left + r.width / 2) + 'px'; c.style.top = (r.top + r.height / 2) + 'px';
    await new Promise((res) => setTimeout(res, 800));
    c.style.transform = 'translate(-50%,-50%) scale(.7)';
    await new Promise((res) => setTimeout(res, 150));
    el.click();
    c.style.transform = 'translate(-50%,-50%) scale(1)';
    return true;
  };
  window.demoHover = (sel) => { const el = document.querySelector(sel); if (!el) return;
    const r = el.getBoundingClientRect(); c.style.left = (r.left + r.width/2) + 'px'; c.style.top = (r.top + r.height/2) + 'px'; };
})()`);
// usage: await js(`demoClick('#newloc')`);  (returns after the click, ~1 s)
```

Every click in section 6 should go through `demoClick(selector)`.

---

## 6. Scene-by-scene automation (inside the recording)

Durations include the ~1 s that `demoClick` takes. Call `mark("sN")` at the start of each scene.

```text
s1  (12 s)  demoHover('#result'); sleep 4000; demoHover('#dirs'); sleep 7000
s2  (18 s)  demoClick('#avoid li[data-id]'); sleep 16500
            // verify: document.getElementById('camera').classList.contains('open')
s3  ( 4 s)  demoClick('#camera .x'); zoom out x3 via '.leaflet-control-zoom-out' (400 ms apart); sleep 1500
s4  (16 s)  demoClick('#play'); sleep 15000          // T+0 -> T+30, auto-stops
s5  ( 6 s)  demoClick('.tstep[data-step="2"]'); demoHover('#result .verify'); sleep 4500
s6  (14 s)  demoClick('#dest [data-cell="C9"]'); sleep 3500
            demoClick('#dest [data-cell="H5"]'); sleep 3500
            demoHover('#brief'); sleep 2000
            demoClick('#dest [data-cell="J8"]'); sleep 1500
s7  (12 s)  demoClick('.tstep[data-step="0"]'); sleep 1000
            demoClick('#newloc'); sleep 4000
            demoClick('#newloc'); sleep 4000
s8  (14 s)  demoClick('#scenario [data-value="hurricane"]'); sleep 3000
            demoClick('.tstep[data-step="2"]'); sleep 1000
            demoClick('#wall-btn'); sleep 7000            // let thumbnails load
s9  ( 4 s)  demoClick('#wall-close'); sleep 3000
s10 (16 s)  demoClick('#calls-btn'); sleep 6000
            demoClick('#newloc'); sleep 8000             // optional fresh rows
s11 ( 4 s)  demoClick('#calls-close'); sleep 3000
```

After switching to hurricane in s8, the page composes a hurricane disaster from the pool
(instant). If `#result` shows "No way to School" at T+20 in hurricane, that is fine and honest;
the wall still looks good.

---

## 7. Captions and optional narration

### 7.1 Captions (burned in)
Generate an SRT from `marks` (shift by the 6 s title card if you burn captions after
concatenation, or burn onto the screencast segment before concatenation; the latter is simpler).
Use these lines per scene (split into the two timed halves shown in the storyboard):

```text
s1a  A simulated wildfire hits Midtown Manhattan. Where can you still drive?
s1b  100 real NYC street cameras from the VAST archive, one per intersection.
s2a  NVIDIA Cosmos3-Reason watches each feed: passable? visibility? hazards?
s2b  A pixel check catches dead cameras. YOLO11 counts cars and people.
s4a  Live wind from Open-Meteo spreads the fire. Orange rings: predicted to fail next.
s4b  Each step checks the last prediction against what the cameras actually saw.
s5   Predict, then verify: the score comes from the models' own verdicts.
s6a  Every trip starts at Home. Switch destination and the route recomputes instantly.
s6b  W&B Inference (Llama 3.1 8B) writes a dispatcher briefing for each route.
s7   New disaster location: different start, different spread, different safe route.
s8a  Hurricane: flooding, lightning and dead cameras, rendered onto the same footage.
s8b  All 100 feeds, laid out like the map, each judged by the models.
s10a Every model call, live: Cosmos3-Reason, YOLO11, pixel check, Llama briefings.
s10b Each call is traced to W&B Weave. 700 clips analyzed once, so demos are instant.
```

Caption style (ASS via `force_style`): `FontName=DejaVu Sans,FontSize=26,PrimaryColour=&H00FFFFFF,
OutlineColour=&H00000000,BackColour=&H99000000,BorderStyle=4,Outline=0,Shadow=0,MarginV=60,Alignment=2`.
BorderStyle 4 gives a translucent box behind the text. Keep captions out of the left sidebar's
bottom if they cover the "New disaster location" button; MarginV=60 at bottom-center is fine
because the bottom-center of the map is mostly tiles.

### 7.2 Narration script (for an optional human voice-over, about 150 words per minute)
No TTS exists on the VM, so this is for a teammate to record on a laptop and lay over the video
later (or to paste into a TTS tool elsewhere). It matches the storyboard timing.

```text
[0:00] SafeRoute: AI evacuation routing from real street cameras.
[0:06] A simulated wildfire hits Midtown Manhattan. We pinned 100 real New York street cameras
       from the VAST video archive to these intersections.
[0:18] For every feed, NVIDIA Cosmos3-Reason watches the clip and says whether the road is
       passable, how far you can see, and what hazards it spots. A pixel check catches dead
       cameras, and YOLO11 counts cars and people.
[0:40] Live wind from Open-Meteo drives the spread. Orange rings are corners we predict will
       fail next, and at every step we check those predictions against what the cameras
       actually saw.
[1:02] Every trip starts at Home. Pick School, Work or Times Square and the safest route
       updates instantly, with a dispatcher briefing written by Llama 3.1 on W&B Inference.
[1:16] Each new disaster starts somewhere else, so the routes really change.
[1:28] Hurricanes work the same way: flooding, lightning and dead cameras on the same footage.
       Here are all 100 feeds, each judged by the models.
[1:46] Every model call is visible live and traced to W&B Weave. We analyzed 700 clips once,
       so the demo is instant.
[2:06] SafeRoute. Built on VAST, NVIDIA Cosmos, YOLO and Weights & Biases.
```

---

## 8. Assembly with ffmpeg

All commands run in `/tmp/sr_video`. Font paths:
`F=/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf`, `FB=/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf`.

1. **Concat list from frames** (write with Node or Python from `frames.json`):
   ```text
   ffconcat version 1.0
   file 'frames/f000000.jpg'
   duration 0.0333
   ...
   file 'frames/f00NNNN.jpg'
   duration <stopTs - lastTs>
   file 'frames/f00NNNN.jpg'
   ```
   (Repeat the last file once at the end; the concat demuxer ignores the last duration otherwise.)
   Clamp any single duration to at most 5 s to avoid accidental freezes from timestamp gaps.

2. **Main segment with captions:**
   ```bash
   ffmpeg -y -f concat -safe 0 -i list.ffconcat \
     -vf "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,fps=30,format=yuv420p,subtitles=captions.srt:force_style='FontName=DejaVu Sans,FontSize=26,PrimaryColour=&H00FFFFFF,BackColour=&H99000000,BorderStyle=4,Outline=0,Shadow=0,MarginV=60,Alignment=2'" \
     -c:v libx264 -preset medium -crf 18 -r 30 main.mp4
   ```

3. **Title card (6 s) and closing card (10 s)** on the app's dark background `#0a0e15`:
   ```bash
   ffmpeg -y -f lavfi -i color=c=0x0a0e15:s=1920x1080:d=6:r=30 -vf "\
   drawtext=fontfile=$FB:text='SafeRoute':fontcolor=white:fontsize=110:x=(w-text_w)/2:y=(h/2)-150,\
   drawtext=fontfile=$F:text='AI evacuation routing from real street cameras':fontcolor=0xe8ecf4:fontsize=46:x=(w-text_w)/2:y=(h/2)-10,\
   drawtext=fontfile=$F:text='VAST Builders Challenge · team-1':fontcolor=0x8b95aa:fontsize=32:x=(w-text_w)/2:y=(h/2)+80,\
   fade=t=in:st=0:d=0.6,fade=t=out:st=5.4:d=0.6,format=yuv420p" -c:v libx264 -crf 18 title.mp4
   ```
   Closing card: same pattern, 10 s, lines "SafeRoute" /
   "VAST video archive · NVIDIA Cosmos3-Reason · YOLO11" /
   "W&B Inference + Weave · Open-Meteo" /
   "Evacuation drill on archived footage. Not for real emergencies." (smaller, grey).
   Escape special characters for drawtext: `:` → `\:`, `'` → `\'`, `&` is fine, `·` is fine
   with DejaVu.

4. **Concatenate** (all three share codec, size, fps, pix_fmt):
   ```bash
   printf "file 'title.mp4'\nfile 'main.mp4'\nfile 'closing.mp4'\n" > parts.txt
   ffmpeg -y -f concat -safe 0 -i parts.txt -c copy \
     /home/madhugarudala/vast-builders-challenge/demo_video/saferoute_demo.mp4
   ```
   If `-c copy` complains about mismatched streams, re-encode with `-c:v libx264 -crf 18`.
   The video is silent (no audio track). That's expected; a voice-over can be added later with
   `-i voiceover.m4a -c:v copy -c:a aac -shortest`.

5. **Also save** `demo_video/captions.srt` and `demo_video/narration.txt` (section 7.2).

---

## 9. Quality checklist (do all of these before reporting done)

1. `ffprobe -v error -show_entries format=duration -of csv=p=0 demo_video/saferoute_demo.mp4`
   → between **120 and 150** seconds.
2. Extract one frame per scene and look at each image:
   `ffmpeg -ss <t> -i saferoute_demo.mp4 -frames:v 1 /tmp/sr_video/check_<t>.png`
   at t = 3, 12, 28, 45, 60, 70, 82, 95, 110, 120, 132. Confirm:
   - title readable; map tiles loaded (not grey squares); blue route visible;
   - camera panel shows a smoky or flooded clip and the Cosmos quote (scene 2);
   - timeline steps visibly change and orange rings appear (scene 4);
   - destination labels HOME / SCHOOL / WORK / TIMES SQ visible;
   - hurricane feed wall shows 100 thumbnails with colored borders;
   - Model calls panel shows non-zero counts and "Weave trace" ids;
   - captions never cover the camera panel's key text and are legible;
   - nothing on screen shows tokens, env vars, terminals or URLs with secrets.
3. `frames.json` → `errors` is empty (no page exceptions).
4. No stutter longer than ~1 s where something should be moving (check scene 4).
5. If any check fails, fix and re-record only what's needed; the whole take is ~2 minutes.

---

## 10. Troubleshooting

| Symptom | Fix |
|---------|-----|
| `/app/state` says `running` | The library is rebuilding (someone redeployed). Wait until `ready`. Do not intervene. |
| Page shows "Analyze the camera network" with a Start button | Same as above, or the app just restarted. Wait 30 s and reload. Never click Start. |
| Grey map tiles | Wait longer after zoom (1.5–2 s); tiles come through the app's own `/tiles` proxy with a cache. |
| Camera clip is black in the panel | It may genuinely be a "camera lost" clip. Pick another `#avoid` item, or a smoky one. |
| `#avoid` is empty | Rare: the disaster is far from the route. Click `#newloc` (pre-flight) until it isn't. |
| Screencast produces few frames | The page didn't change; that's fine. Durations come from timestamps. |
| Captions out of sync | Recompute SRT from `marks` relative to the first frame's timestamp. |
| Video over 2:30 | Shorten holds in scenes 3, 9, 11, then scene 2 by 3 s and scene 10 by 4 s. |
| `drawtext` error | Escape `:` and `'`, quote the filter, check the font path. |

---

## 11. Final handoff message to the team

When done, report: the output path, the duration from ffprobe, a list of the scene check frames
you inspected, and anything that looked off. Remind the team that the MP4 is silent and that
`demo_video/narration.txt` is ready for an optional voice-over. Do not commit the video.
