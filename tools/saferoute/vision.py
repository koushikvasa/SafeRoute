"""What each camera actually shows: pixel signal check, Cosmos3-Reason verdict, YOLO counts."""

import base64
import json
import os
import re
import subprocess

import numpy as np
import requests

from sim import ffmpeg_bin

_model = {"id": None}
VEHICLES = ("car", "truck", "bus", "motorcycle", "bicycle")


def _gpu_headers():
    return {"Authorization": f"Bearer {os.environ['GPU_BEARER_TOKEN']}"}


def signal_check(path):
    """Decode small gray frames. Black or frozen tail means the camera is lost."""
    raw = subprocess.run(
        [ffmpeg_bin(), "-v", "error", "-i", path, "-vf", "fps=6,scale=64:36,format=gray", "-f", "rawvideo", "-"],
        capture_output=True, check=True, timeout=60,
    ).stdout
    frames = np.frombuffer(raw, dtype=np.uint8).reshape(-1, 36, 64).astype(np.float32)
    if len(frames) < 3:
        return {"signal": "lost", "brightness": 0.0, "motion": 0.0, "lost_at": 0.0}
    brightness = frames.mean(axis=(1, 2))
    motion = np.abs(np.diff(frames, axis=0)).mean(axis=(1, 2))
    tail = len(frames) * 3 // 5
    dark = brightness < 22
    lost_at = None
    if dark[tail:].all():
        first = int(np.argmax(dark)) if dark.any() else tail
        lost_at = round(first / 6, 1)
        signal = "lost"
    elif motion[tail - 1:].mean() < 0.25:
        signal = "frozen"
    else:
        signal = "ok"
    return {
        "signal": signal,
        "brightness": round(float(brightness[tail:].mean()), 1),
        "motion": round(float(motion.mean()), 2),
        "lost_at": lost_at,
    }


def _cosmos_model():
    if not _model["id"]:
        response = requests.get(f"{os.environ['COSMOS3_REASON_URL']}/v1/models", headers=_gpu_headers(), timeout=10)
        response.raise_for_status()
        _model["id"] = response.json()["data"][0]["id"]
    return _model["id"]


def _prompt(scenario):
    return (
        f"You are watching a fixed traffic camera at a city intersection during a {scenario} evacuation drill. "
        "Judge only what is visible. Return JSON only with keys: "
        '"camera_ok" (bool, false if feed is black, frozen or unusable), '
        '"visibility" ("clear"|"reduced"|"poor"|"none"), '
        '"hazards" (list of short strings, e.g. smoke, fire, flooding, debris, downed lines, stalled vehicles, crowd), '
        '"traffic" ("moving"|"slow"|"stopped"|"none"), '
        '"passable" (bool, can a car safely drive through now), '
        '"confidence" (0-1), "evidence" (one sentence citing what you see).'
    )


def _parse(text):
    match = re.search(r"\{.*\}", text or "", re.S)
    if not match:
        return None
    try:
        return json.loads(match.group(0))
    except json.JSONDecodeError:
        return None


def cosmos_assess(path, scenario):
    with open(path, "rb") as handle:
        video = base64.b64encode(handle.read()).decode()
    response = requests.post(
        f"{os.environ['COSMOS3_REASON_URL']}/v1/chat/completions",
        headers=_gpu_headers(),
        json={
            "model": _cosmos_model(),
            "max_tokens": 260,
            "temperature": 0,
            "messages": [{"role": "user", "content": [
                {"type": "text", "text": _prompt(scenario)},
                {"type": "video_url", "video_url": {"url": f"data:video/mp4;base64,{video}"}},
            ]}],
        },
        timeout=90,
    )
    response.raise_for_status()
    parsed = _parse(response.json()["choices"][0]["message"]["content"])
    if not parsed:
        return {"camera_ok": None, "visibility": "reduced", "hazards": [], "traffic": "none",
                "passable": None, "confidence": 0, "evidence": "Cosmos reply could not be read.", "model": _model["id"]}
    junk = ("hazards", "none", "drill", "pedestrians crossing", "n/a")
    parsed["hazards"] = [str(h) for h in parsed.get("hazards") or [] if not any(j in str(h).lower() for j in junk)][:5]
    parsed["model"] = _model["id"]
    return parsed


def yolo_counts(path):
    with open(path, "rb") as handle:
        video = base64.b64encode(handle.read()).decode()
    response = requests.post(
        f"{os.environ['YOLO_URL']}/v1/infer",
        headers=_gpu_headers(),
        json={"video_base64": video, "filename": os.path.basename(path)},
        timeout=90,
    )
    response.raise_for_status()
    counts = response.json().get("object_counts") or {}
    frames = 15 * 5
    per_frame = {k: round(v / frames, 1) for k, v in counts.items() if k in VEHICLES + ("person",)}
    return {
        "vehicles": round(sum(per_frame.get(k, 0) for k in VEHICLES), 1),
        "people": per_frame.get("person", 0),
        "classes": per_frame,
    }
