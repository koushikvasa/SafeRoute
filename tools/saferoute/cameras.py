"""Pin one real NYC street-camera clip to each intersection. Same feed for every timestep."""

import os
import time

import requests

import vast_client
from map_model import all_cell_ids

NYC_CAMERAS = ("nyc_streets_cam-1", "nyc_streets_cam-2")
QUERIES = (
    "city street intersection with cars and pedestrians",
    "traffic on an avenue",
    "crosswalk with people",
    "buses and taxis on a street",
    "quiet street",
    "pedestrians waiting at a corner",
    "delivery truck at an intersection",
)
# Skip clips where the road is already blocked on a normal day, so T+0 is a fair baseline.
NORMAL_DAY_SKIP = ("barricade", "barrel", "flag", "cone", "directing traffic", "barrier", "construction")


def _search(camera_id, query):
    body = {"query": query, "top_k": 100, "include_public": True, "metadata_filters": {"camera_id": camera_id}}
    url = f"{os.environ['VSS_URL'].rstrip('/')}/api/v1/search"
    for attempt in range(3):
        try:
            response = requests.post(url, headers=vast_client._headers(), json=body, timeout=60)
            if response.status_code == 401:
                vast_client.login(force=True)
                response = requests.post(url, headers=vast_client._headers(), json=body, timeout=60)
            if response.status_code < 500:
                response.raise_for_status()
                return response.json().get("results") or []
        except (requests.Timeout, requests.ConnectionError):
            pass
        time.sleep(3 * (attempt + 1))
    print(f"search skipped after retries: {camera_id} / {query}", flush=True)
    return []


def build_network():
    segments = {}
    for camera_id in NYC_CAMERAS:
        for query in QUERIES:
            for row in _search(camera_id, query):
                caption = (row.get("reasoning_content") or "").lower()
                if row.get("source") and not any(word in caption for word in NORMAL_DAY_SKIP):
                    segments.setdefault(row["source"], row)
    by_chunk = {}
    for row in segments.values():
        by_chunk.setdefault(row.get("original_video") or row["source"], []).append(row)
    for rows in by_chunk.values():
        rows.sort(key=lambda r: r.get("segment_number") or 0)
    # Round-robin across chunks so neighbors come from different moments and cameras.
    chunks = sorted(by_chunk, key=lambda k: (by_chunk[k][0].get("camera_id"), k))
    picked = []
    depth = 0
    while len(picked) < len(all_cell_ids()) and any(len(by_chunk[k]) > depth for k in chunks):
        for k in chunks:
            if len(by_chunk[k]) > depth:
                picked.append(by_chunk[k][depth])
        depth += 1
    cells = all_cell_ids()
    if len(picked) < len(cells):
        raise RuntimeError(f"Only {len(picked)} usable NYC clips found; need {len(cells)}.")
    stride = 37
    order = [picked[(i * stride) % len(picked)] for i in range(len(picked))]
    seen, unique = set(), []
    for row in order + picked:
        if row["source"] not in seen:
            seen.add(row["source"])
            unique.append(row)
    network = {cell_id: entry(row) for cell_id, row in zip(cells, unique)}
    spares = [entry(row) for row in unique[len(cells):]]
    return network, spares


def entry(row):
    return {
        "source": row["source"],
        "camera_id": row.get("camera_id"),
        "clip": (row.get("original_video") or row["source"]).split("/")[-1],
        "segment": [row.get("segment_start_sec"), row.get("segment_end_sec")],
        "archive_caption": (row.get("reasoning_content") or "")[:400],
    }


def download(source, out_path):
    response = vast_client.open_stream(source, None)
    response.raise_for_status()
    with open(out_path, "wb") as handle:
        for chunk in response.iter_content(chunk_size=256 * 1024):
            handle.write(chunk)
