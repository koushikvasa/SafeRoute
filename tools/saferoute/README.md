# SafeRoute

AI evacuation routing from real street cameras. During a simulated wildfire or hurricane,
SafeRoute uses video models on 100 real NYC street-camera clips to decide which Midtown
intersections are still usable, predicts which ones fail next, and routes a driver from Home
to School, Work or Times Square around the danger.

This is an **evacuation drill on archived footage**, built for the VAST Builders Challenge.
It is not a real emergency system and does not use live cameras or GPS.

## How it works

1. **Footage:** 100 clips from the VAST video archive (`nyc_streets_cam-1` and `-2`) are
   pinned to a 10x10 grid of Midtown intersections, 11th Ave to Lexington and W 59th to W 41st.
2. **Simulated damage:** ffmpeg renders each clip at three damage levels per scenario (smoke,
   or flooding, lightning and shaking, then camera failure).
3. **Analysis (once, about 7 minutes, 700 clips):**
   - a pixel check flags dark or frozen feeds,
   - NVIDIA Cosmos3-Reason judges passable, visibility, traffic and hazards,
   - YOLO11 counts vehicles and people.

   Normal-day clips Cosmos already calls impassable are swapped for other archive footage.
4. **Disasters:** each one starts at a random spot and spreads downwind using live
   Open-Meteo wind over T+0 to T+30. Corners downwind of a hit are predicted to fail next, and
   each prediction is scored at the next step against what the models saw.
5. **Routing:** Dijkstra from Home to each destination. It avoids lost and blocked corners,
   avoids predicted ones where possible, and makes caution corners cost more.
6. **Briefings and tracing:** W&B Inference (Llama 3.1 8B) writes a dispatcher briefing per
   step and destination. Every model call is traced to W&B Weave and shown in the app's
   **Model calls** panel.
7. **Precomputed:** every disaster comes with all routes and briefings, and a few disasters
   per scenario are kept ready, so switching destination or disaster is instant.

## Files

| File | Purpose |
|------|---------|
| `main.py` | Flask app: page, `/state`, `/compose`, `/reanalyze`, `/calls`, clips, thumbnails, map tiles |
| `pipeline.py` | Builds the clip library, composes disasters, precomputes routes, briefings and the pool |
| `cameras.py` | Picks and downloads the 100 archive clips through the VSS search API |
| `sim.py` | Disaster spread model and the ffmpeg damage effects |
| `vision.py` | Pixel check, Cosmos3-Reason and YOLO11 calls |
| `router.py` | Cell status, downwind prediction, prediction scoring, routing |
| `map_model.py` | Grid geometry, street names, Home and destinations |
| `briefing.py`, `weather.py`, `tracing.py`, `vast_client.py` | W&B Inference, Open-Meteo, Weave plus the call log, VSS login |
| `index.html`, `ui.js`, `leaflet.*` | Single-page UI with a Leaflet map (Leaflet is vendored) |
| `test_router.py` | Routing and prediction tests: `python3 test_router.py` |

## Running it

The app needs these environment variables. Values come from the team environment; never
commit them.

```text
VSS_URL  VSS_USERNAME  VSS_PASSWORD           VAST video search and stream API
GPU_BEARER_TOKEN  COSMOS3_REASON_URL  YOLO_URL GPU model endpoints
WANDB_API_KEY  WANDB_TEAM  WANDB_PROJECT      W&B Inference and Weave (optional)
SAFEROUTE_DATA (default /tmp/saferoute)       where clips and library.json are stored
PORT (default 8080)
```

```bash
pip install -r requirements.txt
python main.py
```

On first start it builds the library (about 7 minutes), then serves at `http://localhost:8080/`.
Later starts load `library.json` from `SAFEROUTE_DATA` instantly.

## Deployment (team-1)

It runs in Kubernetes namespace `team-1` as `deploy/saferoute`:
- image `python:3.12-slim`; installs `requirements.txt` at start, then runs `main.py`;
- code from the ConfigMap `saferoute-code`, built from this folder and mounted at `/code`;
- credentials from the Secret `saferoute-vss-creds`;
- clips on an `emptyDir` at `/data`;
- exposed through an Ingress at `/app`.

Users open https://workshop.thecosmoslabs.com and click **App**.

To update UI or routing code without rebuilding the clip library:

```bash
kubectl -n team-1 create configmap saferoute-code --from-file=tools/saferoute \
  --dry-run=client -o yaml | kubectl replace -f -
# wait about 10 s for the files to sync, then restart only the app process:
kubectl -n team-1 exec deploy/saferoute -- sh -c 'kill -INT 1'
```

A full `rollout restart` creates a new pod with an empty `/data`, so the 7-minute analysis
runs again.

## Demo video

See `video_demo_script.md` at the repo root for the full production script.
