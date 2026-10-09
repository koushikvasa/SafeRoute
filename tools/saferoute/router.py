"""Status, prediction, and routing from what the models saw. Never reads the hidden front."""

import heapq

from map_model import HOME, SHELTER, SIZE, cell_name, label_for, parse, place_for

DELTAS = ((1, 0), (-1, 0), (0, 1), (0, -1))
DOWNWIND = {"north": (-1, 0), "south": (1, 0), "east": (0, 1), "west": (0, -1)}
HAZARD_WORDS = ("smoke", "fire", "flame", "flood", "water", "debris", "storm", "rain", "haze", "ash", "visibility")
IMPASSABLE = {"offline", "blocked"}


def downwind_cardinal(from_degrees):
    if from_degrees is None:
        return None
    toward = (float(from_degrees) + 180) % 360
    return ("north", "east", "south", "west")[int(((toward + 45) % 360) // 90)]


def spread_direction(scenario, weather):
    found = downwind_cardinal((weather or {}).get("wind_from_degrees"))
    if found:
        return found
    return "north" if scenario == "hurricane" else "east"


def _hazardous(observation):
    text = " ".join(observation.get("hazards") or []).lower()
    return any(word in text for word in HAZARD_WORDS)


def cell_status(health, observation):
    """health: pixel check. observation: Cosmos verdict (may be None)."""
    observation = observation or {}
    if health.get("signal") != "ok" or observation.get("camera_ok") is False:
        return "offline", 99
    visibility = observation.get("visibility") or "clear"
    if observation.get("passable") is False or visibility == "none":
        return "blocked", 99
    risk = 0
    if visibility == "reduced":
        risk += 1
    if visibility == "poor":
        risk += 3
    if _hazardous(observation):
        risk += 2
    if observation.get("traffic") in {"stopped", "slow"}:
        risk += 1
    if risk == 0:
        return "clear", 0
    return "caution", risk


def _step(cell_id, dr, dc):
    r, c = parse(cell_id)
    r, c = r + dr, c + dc
    if 0 <= r < SIZE and 0 <= c < SIZE:
        return cell_name(r, c)
    return None


def _neighbors(cell_id):
    for dr, dc in DELTAS:
        found = _step(cell_id, dr, dc)
        if found:
            yield found


def impacted(cells):
    return [
        cid for cid, cell in cells.items()
        if cell["status"] in IMPASSABLE or (cell["status"] == "caution" and _hazardous(cell.get("observation") or {}))
    ]


def predict_next(cells, direction, wind_mph):
    """Cells not yet lost that sit downwind of an impacted cell, plus hazy cells beside a lost one."""
    dr, dc = DOWNWIND[direction]
    reach = 2 if (wind_mph or 0) >= 25 else 1
    reasons = {}
    for source in impacted(cells):
        cursor = source
        for _ in range(reach):
            cursor = _step(cursor, dr, dc)
            if cursor is None:
                break
            if cells[cursor]["status"] not in IMPASSABLE:
                reasons.setdefault(cursor, source)
        if cells[source]["status"] in IMPASSABLE:
            for side in ((dc, dr), (-dc, -dr)):
                lateral = _step(source, *side)
                if lateral and cells[lateral]["status"] == "caution" and _hazardous(cells[lateral].get("observation") or {}):
                    reasons.setdefault(lateral, source)
    return reasons


def lost(cell):
    return cell["status"] in IMPASSABLE or (cell.get("observation") or {}).get("visibility") == "poor"


def score_prediction(previous_predicted, cells):
    hits = [cid for cid in previous_predicted if lost(cells[cid])]
    return {"predicted": sorted(previous_predicted), "correct": sorted(hits)}


def meters(a, b):
    pa, pb = place_for(a), place_for(b)
    dlat = (pa["lat"] - pb["lat"]) * 111_000
    dlon = (pa["lon"] - pb["lon"]) * 84_000
    return (dlat * dlat + dlon * dlon) ** 0.5


def best_route(cells, avoid, start=HOME, goal=SHELTER):
    """Dijkstra: cost = block length x (1 + risk). Cells in avoid are skipped, except the goal."""
    queue = [(0.0, start, [start])]
    best = {start: 0.0}
    while queue:
        cost, cell_id, path = heapq.heappop(queue)
        if cell_id == goal:
            return path, cost
        if cost > best.get(cell_id, float("inf")):
            continue
        for nxt in _neighbors(cell_id):
            if nxt in avoid and nxt != goal:
                continue
            total = cost + meters(cell_id, nxt) * (1 + cells[nxt]["risk"])
            if total < best.get(nxt, float("inf")):
                best[nxt] = total
                heapq.heappush(queue, (total, nxt, path + [nxt]))
    return [], None


def route(cells, predicted, start=HOME, goal=SHELTER):
    """Safest path for one trip. The disaster state (cells, predicted) does not depend on the trip."""
    if start == goal:
        return {"path": [start], "warning": "You are already there."}
    lost_now = {cid for cid, cell in cells.items() if cell["status"] in IMPASSABLE}
    path, _ = best_route(cells, lost_now | set(predicted), start, goal)
    warning = None
    if not path:
        path, _ = best_route(cells, lost_now, start, goal)
        warning = "No route avoids every at-risk corner. This route passes one that may fail soon." if path else None
    if not path:
        warning = f"No route reaches {label_for(goal)}. Every way there passes a lost camera. Shelter in place."
    elif cells[goal]["status"] in IMPASSABLE:
        warning = f"The camera at {label_for(goal)} is down or blocked. You can reach the corner, but check before going in."
    if cells[start]["status"] in IMPASSABLE:
        warning = f"The camera at your starting point ({label_for(start)}) is lost. Leave now if you can."
    return {"path": path, "warning": warning}


def plan(cells, direction, wind_mph, start=HOME, goal=SHELTER):
    predicted = predict_next(cells, direction, wind_mph)
    return {"predicted": predicted, **route(cells, predicted, start, goal)}
