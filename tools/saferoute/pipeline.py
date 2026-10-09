"""Analyze every feed once at every damage level, then compose random disasters from those verdicts.

Library: 100 feeds x (clear + 3 levels per scenario). Composing a new disaster only picks which
pre-analyzed clip each corner shows at each step, so the route changes without re-rendering.
"""

import json
import os
import random
import threading
import time
import traceback
from concurrent.futures import ThreadPoolExecutor

import briefing
import cameras
import router
import sim
import tracing
import vision
import weather
from map_model import DESTINATIONS, HOME, all_cell_ids, label_for, parse, place_for, role_for

DATA_DIR = os.environ.get("SAFEROUTE_DATA", "/tmp/saferoute")
SCENARIOS = ("wildfire", "hurricane")
DAMAGE = ("haze", "severe", "offline")
WORKERS = 12
EFFECT_LABELS = {
    ("wildfire", "clear"): "None",
    ("wildfire", "haze"): "Light smoke",
    ("wildfire", "severe"): "Heavy smoke",
    ("wildfire", "offline"): "Smoke, then camera failure",
    ("hurricane", "clear"): "None",
    ("hurricane", "haze"): "Rain and street flooding",
    ("hurricane", "severe"): "Deep flooding, lightning, shaking",
    ("hurricane", "offline"): "Flooding, then camera failure",
}

_lock = threading.Lock()
_state = {"status": "idle", "phase": "", "done": 0, "total": 0, "error": None, "seconds": None}
_library = {}
_network = {}
_timelines = {}
_weather = {}
_baseline_swaps = []


def clip_path(scenario, level, cell_id, kind="mp4"):
    folder = "clear" if level == "clear" else os.path.join(scenario, level)
    return os.path.join(DATA_DIR, "library", folder, f"{cell_id}.{kind}")


def _key(scenario, level):
    return "clear" if level == "clear" else f"{scenario}/{level}"


def state():
    with _lock:
        return dict(_state)


def ready():
    return state()["status"] == "ready"


def _update(**fields):
    with _lock:
        _state.update(fields)


def _tick():
    with _lock:
        _state["done"] += 1


def _fetch(cell_id, feed):
    base_dir = os.path.join(DATA_DIR, "base")
    os.makedirs(base_dir, exist_ok=True)
    raw = os.path.join(base_dir, f"{cell_id}.raw.mp4")
    for attempt in range(3):
        try:
            cameras.download(feed["source"], raw)
            break
        except Exception:
            if attempt == 2:
                raise
            time.sleep(2 * (attempt + 1))
    sim.prepare_base(raw, os.path.join(base_dir, f"{cell_id}.mp4"))
    os.remove(raw)


def _download_feeds():
    _update(phase="Pinning a real NYC street camera to each of 100 intersections")
    network, spares = cameras.build_network()
    _update(phase="Downloading 100 feeds from the VAST archive")

    def fetch(cell_id):
        _fetch(cell_id, network[cell_id])
        _tick()

    with ThreadPoolExecutor(8) as pool:
        list(pool.map(fetch, all_cell_ids()))
    _network.update(network)
    return spares


def _qualify_baseline(spares):
    """A corner's normal-day feed must be passable, or T+0 would already be blocked for reasons
    unrelated to the disaster (street fairs, closures). Swap those feeds for spare archive clips."""
    _update(phase="Checking every normal-day feed is passable before adding damage")
    swaps = []
    clear = _library[_key("wildfire", "clear")]
    for cell_id in all_cell_ids():
        rejected = []
        while clear[cell_id]["status"] in router.IMPASSABLE and spares:
            rejected.append({"clip": _network[cell_id]["clip"],
                             "evidence": (clear[cell_id]["observation"] or {}).get("evidence")})
            feed = spares.pop(0)
            _fetch(cell_id, feed)
            _network[cell_id] = feed
            _library_job("wildfire", "clear", cell_id, count=False)
        if rejected:
            swaps.append({"cell": cell_id, "rejected": rejected, "kept": _network[cell_id]["clip"],
                          "status": clear[cell_id]["status"]})
    _baseline_swaps[:] = swaps


def _analyze_clip(path, scenario, label=None):
    health = tracing.call("signal_check", vision.signal_check, path, label=label)
    try:
        observation = tracing.call("cosmos3_reason_assess", vision.cosmos_assess, path, scenario, label=label)
    except Exception as exc:
        observation = {"camera_ok": None, "visibility": "reduced", "hazards": [], "traffic": "none",
                       "passable": None, "confidence": 0, "evidence": f"Cosmos unavailable ({type(exc).__name__})."}
    counts = None
    if health["signal"] == "ok":
        try:
            counts = tracing.call("yolo11_counts", vision.yolo_counts, path, label=label)
        except Exception:
            counts = None
    status, risk = router.cell_status(health, observation)
    return {"status": status, "risk": risk, "health": health, "observation": observation, "yolo": counts}


def _library_job(scenario, level, cell_id, render=True, count=True):
    out = clip_path(scenario, level, cell_id)
    if render:
        os.makedirs(os.path.dirname(out), exist_ok=True)
        source = os.path.join(DATA_DIR, "base", f"{cell_id}.mp4")
        sim.render(source, out, scenario, level)
        sim.thumbnail(out, clip_path(scenario, level, cell_id, "jpg"))
    label = f"{cell_id} · {place_for(cell_id)['name']} · " + ("normal day" if level == "clear" else f"{scenario} {level}")
    result = _analyze_clip(out, "disaster" if level == "clear" else scenario, label)
    _library.setdefault(_key(scenario, level), {})[cell_id] = result
    if count:
        _tick()


def _build():
    started = time.time()
    try:
        baseline = [("wildfire", "clear", cid) for cid in all_cell_ids()]
        damage = [(s, level, cid) for s in SCENARIOS for level in DAMAGE for cid in all_cell_ids()]
        _update(status="running", done=0, total=len(all_cell_ids()) + len(baseline) + len(damage), error=None)
        with _pool_lock:
            for pending in _pool.values():
                pending.clear()
        spares = _download_feeds()
        _weather.update(weather.fetch_weather_outlook())
        _update(phase="Cosmos3-Reason and YOLO11 are checking every normal-day feed")
        with ThreadPoolExecutor(WORKERS) as pool:
            list(pool.map(lambda job: _library_job(*job), baseline))
        _qualify_baseline(spares)
        _update(phase="Cosmos3-Reason and YOLO11 are watching every feed at every damage level")
        with ThreadPoolExecutor(WORKERS) as pool:
            list(pool.map(lambda job: _library_job(*job), damage))
        with open(os.path.join(DATA_DIR, "library.json"), "w") as handle:
            json.dump({"library": _library, "network": _network, "weather": _weather,
                       "baseline_swaps": _baseline_swaps}, handle)
        _update(status="ready", phase="Ready", seconds=round(time.time() - started))
        _fill_pool()
    except Exception as exc:
        traceback.print_exc()
        _update(status="error", phase="Failed", error=f"{type(exc).__name__}: {exc}"[:300])


def prepare(force=False):
    with _lock:
        if _state["status"] == "running" or (_state["status"] == "ready" and not force):
            return
        _state["status"] = "running"
    threading.Thread(target=_build, daemon=True).start()


def load_cached():
    path = os.path.join(DATA_DIR, "library.json")
    if not os.path.exists(path):
        return False
    with open(path) as handle:
        saved = json.load(handle)
    _library.update(saved["library"])
    _network.update(saved["network"])
    _weather.update(saved["weather"])
    _baseline_swaps[:] = saved.get("baseline_swaps") or []
    _update(status="ready", phase="Ready")
    _fill_pool()
    return True


def _facts(scenario, step, direction, mph, start, goal):
    names = lambda ids: ", ".join(label_for(c) for c in ids[:4]) or "none"
    lost = sorted(c for c, cell in step["cells"].items() if cell["status"] == "offline")
    blocked = sorted(c for c, cell in step["cells"].items() if cell["status"] == "blocked")
    path = step["path"]
    turns = []
    for before, here, after in zip(path, path[1:], path[2:]):
        a, b, c = place_for(before), place_for(here), place_for(after)
        if a["row"] != c["row"] and a["col"] != c["col"]:
            turns.append(b["name"])
    route_text = "none, shelter in place" if not path else "turning at " + (", ".join(turns[:4]) or "no turns")
    return (
        f"Trip: from {label_for(start)} ({place_for(start)['name']}) to {label_for(goal)} ({place_for(goal)['name']}).\n"
        f"Wind pushes the {scenario} {direction} at {round(mph or 0)} mph.\n"
        f"Cameras lost: {len(lost)} ({names(lost)}).\nNot passable: {len(blocked)} ({names(blocked)}).\n"
        f"Predicted to fail next: {names(sorted(step['predicted']))}.\n"
        f"Route: {route_text}.\n"
        f"Warning: {step['warning'] or 'none'}."
    )


def _assemble(scenario, origins, direction, mph):
    """The disaster at each step: what every camera shows and what fails next. Independent of any trip."""
    steps = []
    previous = None
    for index, minute in enumerate(sim.STEPS):
        levels = sim.front_levels(scenario, direction, mph, index, origins)
        cells = {}
        for cid, level in levels.items():
            cells[cid] = dict(_library[_key(scenario, level)][cid], level=level,
                              effect=EFFECT_LABELS[(scenario, level)])
        step = {
            "minute": minute,
            "cells": cells,
            "predicted": router.predict_next(cells, direction, mph),
            "verification": router.score_prediction(list(previous["predicted"]), cells) if previous else None,
        }
        steps.append(step)
        previous = step
    return steps


def _route_all(steps):
    for step in steps:
        step["routes"] = {}
        for goal in DESTINATIONS:
            result = router.route(step["cells"], step["predicted"], HOME, goal)
            path = result["path"]
            step["routes"][goal] = {"path": path, "warning": result["warning"], "briefing": None,
                                    "distance_m": round(sum(router.meters(a, b) for a, b in zip(path, path[1:])))}


def _brief_all(timeline):
    scenario, direction, mph = timeline["scenario"], timeline["spread_direction"], timeline["wind_mph"]
    jobs = [(step, goal) for step in timeline["steps"] for goal in DESTINATIONS]

    def write(job):
        step, goal = job
        view = dict(step, **step["routes"][goal])
        return _brief(scenario, view, direction, mph, HOME, goal)

    with ThreadPoolExecutor(len(jobs)) as pool:
        texts = list(pool.map(write, jobs))
    for (step, goal), text in zip(jobs, texts):
        step["routes"][goal]["briefing"] = text


def _build_timeline(scenario, seed):
    direction = router.spread_direction(scenario, _weather)
    mph = _weather.get("wind_mph") or 0
    rng = random.Random(seed)
    keep = [(*parse(HOME), 3.0)] + [(*parse(goal), 1.5) for goal in DESTINATIONS]
    for _ in range(25):
        origins = sim.random_origins(rng, scenario, keep)
        steps = _assemble(scenario, origins, direction, mph)
        _route_all(steps)
        if all(step["routes"][goal]["path"] for step in steps[:2] for goal in DESTINATIONS):
            break
    timeline = {
        "scenario": scenario,
        "seed": seed,
        "origins": origins,
        "composed_at": int(time.time() * 1000),
        "weather": _weather,
        "spread_direction": direction,
        "wind_mph": mph,
        "feeds_analyzed": sum(len(v) for v in _library.values()),
        "library_seconds": state()["seconds"],
        "baseline_swaps": _baseline_swaps,
        "cameras": {cid: {"camera_id": c["camera_id"], "clip": c["clip"], "role": role_for(cid)} for cid, c in _network.items()},
        "start": HOME,
        "destinations": [{"cell": goal, "label": label_for(goal)} for goal in DESTINATIONS],
        "steps": steps,
    }
    _brief_all(timeline)
    return timeline


POOL_SIZE = 3
_pool = {s: [] for s in SCENARIOS}
_pool_lock = threading.Lock()
_filling = threading.Event()


def _fill_pool():
    """Keep a few fully routed and briefed disasters ready so a new one appears instantly."""
    if _filling.is_set():
        return
    _filling.set()

    def run():
        try:
            while ready():
                needed = [s for s in SCENARIOS if len(_pool[s]) < POOL_SIZE]
                if not needed:
                    break
                timeline = _build_timeline(needed[0], random.randrange(1, 10_000))
                with _pool_lock:
                    _pool[needed[0]].append(timeline)
        except Exception:
            traceback.print_exc()
        finally:
            _filling.clear()

    threading.Thread(target=run, daemon=True).start()


def compose(scenario, seed=None):
    if not ready():
        return None
    timeline = None
    if seed is None:
        with _pool_lock:
            timeline = _pool[scenario].pop(0) if _pool[scenario] else None
    if timeline is None:
        timeline = _build_timeline(scenario, seed if seed is not None else random.randrange(1, 10_000))
    timeline["composed_at"] = int(time.time() * 1000)
    _timelines[scenario] = timeline
    _fill_pool()
    return timeline


def _brief(scenario, step, direction, mph, start, goal):
    try:
        return tracing.call("wandb_briefing", briefing.write, scenario, step["minute"],
                            _facts(scenario, step, direction, mph, start, goal),
                            label=f"{scenario} T+{step['minute']} · {label_for(start)} to {label_for(goal)}")
    except Exception:
        return None


def reanalyze(scenario, step_index):
    timeline = _timelines.get(scenario)
    if not timeline or not 0 <= step_index < len(timeline["steps"]):
        return None
    started = time.time()
    levels = {cid: cell["level"] for cid, cell in timeline["steps"][step_index]["cells"].items()}
    with ThreadPoolExecutor(16) as pool:
        list(pool.map(lambda cid: _library_job(scenario, levels[cid], cid, render=False, count=False), levels))
    with _pool_lock:
        _pool[scenario].clear()
    rebuilt = compose(scenario, timeline["seed"])
    rebuilt["steps"][step_index]["reanalyzed_seconds"] = round(time.time() - started, 1)
    return rebuilt
