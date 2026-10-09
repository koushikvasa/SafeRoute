"""10x10 Midtown grid. Rows are cross streets (A = north), columns are avenues (1 = west)."""

ROWS = "ABCDEFGHIJ"
SIZE = len(ROWS)
STREET_NUMBERS = (59, 57, 55, 53, 51, 49, 47, 45, 43, 41)
STREETS = tuple(f"W {n}{ {1: 'st', 3: 'rd'}.get(n % 10, 'th') } St" for n in STREET_NUMBERS)
AVENUES = ("11th Ave", "10th Ave", "9th Ave", "8th Ave", "7th Ave", "6th Ave", "5th Ave",
           "Madison Ave", "Park Ave", "Lexington Ave")
# Distance east of 8th Ave in long-block units. East of 5th the avenues are closer together.
AVENUE_OFFSETS = (-3, -2, -1, 0, 1, 2, 3, 3.5, 4.0, 4.5)
# 8th Ave & W 41st St, then offsets for one long block east and one street north.
_ORIGIN = (40.75639, -73.99014)
_AVENUE_STEP = (-0.00113, 0.00280)
_STREET_STEP = (0.000613, 0.000438)
HOME = "A1"
SHELTER = f"{ROWS[-1]}{SIZE}"
# Every trip starts at Home; these are the destinations routed for every disaster.
PLACES = (
    {"key": "home", "label": "Home", "tag": "HOME", "cell": HOME},
    {"key": "school", "label": "School", "tag": "SCHOOL", "cell": "J8"},
    {"key": "work", "label": "Work", "tag": "WORK", "cell": "C9"},
    {"key": "times", "label": "Times Square", "tag": "TIMES SQ", "cell": "H5"},
)
DESTINATIONS = tuple(p["cell"] for p in PLACES if p["cell"] != HOME)
_BY_CELL = {p["cell"]: p for p in PLACES}


def parse(cell_id):
    return ROWS.index(cell_id[0]), int(cell_id[1:]) - 1


def cell_name(row, col):
    return f"{ROWS[row]}{col + 1}"


def all_cell_ids():
    return [cell_name(r, c) for r in range(SIZE) for c in range(SIZE)]


def role_for(cell_id):
    place = _BY_CELL.get(cell_id)
    return place["key"] if place else "camera"


def label_for(cell_id):
    """Place name if a named place sits on this corner, else the intersection."""
    place = _BY_CELL.get(cell_id)
    return place["label"] if place else place_for(cell_id)["name"]


def place_for(cell_id):
    row, col = parse(cell_id)
    east = AVENUE_OFFSETS[col]
    north = STREET_NUMBERS[row] - 41
    lat = _ORIGIN[0] + east * _AVENUE_STEP[0] + north * _STREET_STEP[0]
    lon = _ORIGIN[1] + east * _AVENUE_STEP[1] + north * _STREET_STEP[1]
    street = STREETS[row] if AVENUE_OFFSETS[col] <= 3 else STREETS[row].replace("W ", "E ", 1)
    return {
        "street": street,
        "avenue": AVENUES[col],
        "name": f"{AVENUES[col]} & {street}",
        "lat": round(lat, 6),
        "lon": round(lon, 6),
        "row": row,
        "col": col,
        "place": _BY_CELL.get(cell_id),
    }
