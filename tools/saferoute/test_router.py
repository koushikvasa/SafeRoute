"""Routing and prediction only use model observations."""

import router
from map_model import all_cell_ids

CLEAR = ({"signal": "ok"}, {"visibility": "clear", "hazards": [], "passable": True, "traffic": "moving"})
SMOKE = ({"signal": "ok"}, {"visibility": "poor", "hazards": ["smoke"], "passable": True, "traffic": "slow"})
BLOCKED = ({"signal": "ok"}, {"visibility": "poor", "hazards": ["smoke"], "passable": False})
LOST = ({"signal": "lost"}, {"camera_ok": False})


def grid(overrides):
    cells = {}
    for cid in all_cell_ids():
        health, observation = overrides.get(cid, CLEAR)
        status, risk = router.cell_status(health, observation)
        cells[cid] = {"status": status, "risk": risk, "observation": observation}
    return cells


def test_status_from_models():
    assert router.cell_status(*CLEAR) == ("clear", 0)
    assert router.cell_status(*SMOKE)[0] == "caution"
    assert router.cell_status(*BLOCKED)[0] == "blocked"
    assert router.cell_status(*LOST)[0] == "offline"
    assert router.cell_status({"signal": "ok"}, {"camera_ok": False})[0] == "offline"


def test_normal_day_route():
    result = router.plan(grid({}), "east", 10)
    assert result["path"][0] == "A1" and result["path"][-1] == "J10"
    assert len(result["path"]) == 19
    assert result["warning"] is None


def test_lost_camera_predicts_downwind_and_reroutes():
    cells = grid({"B2": LOST, "B3": BLOCKED})
    result = router.plan(cells, "east", 10)
    assert "B4" in result["predicted"]
    assert not {"B2", "B3", "B4"} & set(result["path"])


def test_strong_wind_reaches_two_cells():
    cells = grid({"A2": LOST})
    result = router.plan(cells, "east", 30)
    assert {"A3", "A4"} <= set(result["predicted"])


def test_prediction_score():
    cells = grid({"B4": LOST, "C4": SMOKE})
    score = router.score_prediction(["B4", "C4", "A4"], cells)
    assert score["correct"] == ["B4", "C4"]


def test_no_route():
    cells = grid({"B1": LOST, "A2": LOST})
    result = router.plan(cells, "east", 10)
    assert result["path"] == []
    assert "Shelter in place" in result["warning"]


def test_any_trip_routes_around_hazards():
    cells = grid({"E3": LOST, "E4": BLOCKED})
    result = router.plan(cells, "east", 10, start="D2", goal="F6")
    assert result["path"][0] == "D2" and result["path"][-1] == "F6"
    assert not {"E3", "E4", "E5"} & set(result["path"])
    back = router.plan(cells, "east", 10, start="F6", goal="D2")
    assert back["path"][0] == "F6" and back["path"][-1] == "D2"


def test_same_start_and_goal():
    assert router.plan(grid({}), "east", 10, start="H5", goal="H5")["path"] == ["H5"]


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_"):
            fn()
    print("router tests ok")
