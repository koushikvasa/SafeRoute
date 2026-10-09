"""SafeRoute: a disaster drill where real video models decide which intersections are safe."""

import atexit
import os
import re
import requests
from flask import Flask, Response, jsonify, render_template, request, send_file, send_from_directory

import pipeline
import sim
import tracing
from map_model import PLACES, SIZE, all_cell_ids, place_for, role_for

app = Flask(__name__, template_folder=".")
SECRET_NAMES = (
    "VSS_URL",
    "VSS_USERNAME",
    "VSS_PASSWORD",
    "GPU_BEARER_TOKEN",
    "COSMOS3_REASON_URL",
    "YOLO_URL",
    "WANDB_API_KEY",
    "WANDB_TEAM",
    "WANDB_PROJECT",
)
CELL_RE = re.compile(r"^[A-Z](10|[1-9])$")
ASSETS = {"leaflet.js": "application/javascript", "leaflet.css": "text/css"}
_tile_session = requests.Session()
_tile_cache = {}


def _scenario(value):
    return value if value in pipeline.SCENARIOS else "wildfire"


@app.get("/health")
def health():
    return jsonify({
        "ok": True,
        "secrets_present": {name: bool(os.environ.get(name)) for name in SECRET_NAMES},
        "library": pipeline.state()["status"],
    })


@app.get("/")
def index():
    cells = [{"id": cid, "role": role_for(cid), **place_for(cid)} for cid in all_cell_ids()]
    return render_template("index.html", cells=cells, steps=list(sim.STEPS), size=SIZE, places=PLACES)


@app.get("/state")
def library_state():
    return jsonify(pipeline.state())


@app.get("/calls")
def calls():
    return jsonify(tracing.recent())


@app.post("/prepare")
def prepare():
    pipeline.prepare()
    return jsonify(pipeline.state())


@app.post("/compose")
def compose():
    body = request.get_json(silent=True) or {}
    seed = body.get("seed")
    timeline = pipeline.compose(_scenario(body.get("scenario")), int(seed) if str(seed).isdigit() else None)
    if timeline is None:
        return jsonify({"error": "The feed library is still being analyzed."}), 409
    return jsonify(timeline)


@app.post("/reanalyze")
def reanalyze():
    body = request.get_json(silent=True) or {}
    try:
        step = int(body.get("step", 0))
    except (TypeError, ValueError):
        step = 0
    timeline = pipeline.reanalyze(_scenario(body.get("scenario")), step)
    if timeline is None:
        return jsonify({"error": "Compose a disaster first."}), 409
    return jsonify(timeline)


def _media(scenario, level, cell_id, kind, mimetype):
    if scenario not in pipeline.SCENARIOS or level not in sim.LEVELS or not CELL_RE.match(cell_id):
        return jsonify({"error": "not found"}), 404
    path = pipeline.clip_path(scenario, level, cell_id, kind)
    if not os.path.exists(path):
        return jsonify({"error": "not found"}), 404
    return send_file(path, mimetype=mimetype, conditional=True, max_age=3600)


@app.get("/clip/<scenario>/<level>/<cell_id>.mp4")
def clip(scenario, level, cell_id):
    return _media(scenario, level, cell_id, "mp4", "video/mp4")


@app.get("/thumb/<scenario>/<level>/<cell_id>.jpg")
def thumb(scenario, level, cell_id):
    return _media(scenario, level, cell_id, "jpg", "image/jpeg")


@app.get("/assets/<name>")
def asset(name):
    if name not in ASSETS:
        return jsonify({"error": "not found"}), 404
    return send_from_directory(os.path.dirname(os.path.abspath(__file__)), name, mimetype=ASSETS[name], max_age=86400)


@app.get("/tiles/<int:z>/<int:x>/<int:y>.png")
def tile(z, x, y):
    if not 0 <= z <= 19:
        return jsonify({"error": "bad tile"}), 404
    key = (z, x, y)
    if key not in _tile_cache:
        try:
            upstream = _tile_session.get(
                f"https://tile.openstreetmap.org/{z}/{x}/{y}.png",
                headers={"User-Agent": "SafeRoute-drill-demo/1.0 (hackathon)"},
                timeout=8,
            )
        except requests.RequestException:
            return Response(status=504)
        if upstream.status_code != 200:
            return Response(status=upstream.status_code)
        if len(_tile_cache) > 4000:
            _tile_cache.clear()
        _tile_cache[key] = upstream.content
    return Response(_tile_cache[key], mimetype="image/png", headers={"Cache-Control": "public, max-age=86400"})


CALL_LOG = os.path.join(pipeline.DATA_DIR, "calls.json")


def _save_calls():
    try:
        tracing.save(CALL_LOG)
    except OSError:
        pass


if __name__ == "__main__":
    # Load the saved library and call log before serving, so a restart never looks like an empty app.
    tracing.load(CALL_LOG)
    atexit.register(_save_calls)
    if not pipeline.load_cached() and os.environ.get("GPU_BEARER_TOKEN"):
        pipeline.prepare()
    port = int(os.environ.get("PORT", "8080"))
    app.run(host="0.0.0.0", port=port, threaded=True)
