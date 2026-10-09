"""Hidden disaster front. It decides how each camera's real footage is degraded at each step.

The rest of the app never reads these levels. Routing and prediction only use what the
models report after watching the rendered video.
"""

import math
import shutil
import subprocess

from map_model import SIZE, all_cell_ids, parse

STEPS = (0, 10, 20, 30)
LEVELS = ("clear", "haze", "severe", "offline")
DOWNWIND = {"north": (-1, 0), "south": (1, 0), "east": (0, 1), "west": (0, -1)}

# Front sizes are tuned in units of a quarter of the district, so they scale with the grid.
SCALE = SIZE / 4
GROWTH = {"wildfire": 0.4, "hurricane": 0.32}
START_RADIUS = {"wildfire": -0.4, "hurricane": -0.3}
IGNITIONS = {"wildfire": (1, 2), "hurricane": (1, 1)}
KEEP_CLEAR = 2.5


def random_origins(rng, scenario, keep=((0, 0, KEEP_CLEAR * SCALE), (SIZE - 1, SIZE - 1, KEEP_CLEAR * SCALE))):
    """Ignition points in grid cells, at least `radius` cells from each (row, col, radius) in keep."""
    low, high = IGNITIONS[scenario]
    wanted = rng.randint(low, high)
    origins = []
    for _ in range(500):
        if len(origins) >= wanted:
            break
        r = rng.uniform(1, SIZE - 2)
        c = rng.uniform(1, SIZE - 2)
        if any(math.hypot(r - kr, c - kc) < radius for kr, kc, radius in keep):
            continue
        origins.append((round(r, 2), round(c, 2)))
    return origins or [(round(rng.uniform(1, SIZE - 2), 2), round(rng.uniform(1, SIZE - 2), 2))]


def _ffmpeg():
    found = shutil.which("ffmpeg")
    if found:
        return found
    import imageio_ffmpeg

    return imageio_ffmpeg.get_ffmpeg_exe()


FFMPEG = None


def ffmpeg_bin():
    global FFMPEG
    if FFMPEG is None:
        FFMPEG = _ffmpeg()
    return FFMPEG


def _level(dist, radius):
    if dist < radius - 0.3:
        return 3
    if dist < radius + 0.25:
        return 2
    if dist < radius + 1.0:
        return 1
    return 0


def front_levels(scenario, spread_direction, wind_mph, step_index, origins):
    dr, dc = DOWNWIND.get(spread_direction, (0, 1))
    speed = 0.25 + min(wind_mph or 0, 40) * 0.008
    radius = START_RADIUS[scenario] + GROWTH[scenario] * step_index
    levels = {}
    for cell_id in all_cell_ids():
        r, c = parse(cell_id)
        worst = 0
        for origin_r, origin_c in origins:
            vr = (r - origin_r) / SCALE - dr * speed * step_index
            vc = (c - origin_c) / SCALE - dc * speed * step_index
            along = vr * dr + vc * dc
            perp = vr * -dc + vc * dr
            stretch = 1.5 if along > 0 else 1.0
            worst = max(worst, _level(math.hypot(along / stretch, perp), radius))
        levels[cell_id] = LEVELS[worst]
    return levels


_BASE = "scale=640:360,fps=15"

FILTERS = {
    ("wildfire", "clear"): _BASE,
    ("wildfire", "haze"): _BASE + ",eq=contrast=0.75:saturation=0.55,colorchannelmixer=rr=1:gg=0.8:bb=0.55,"
    "drawbox=x=0:y=0:w=iw:h=ih:color=0xB06428@0.45:t=fill,gblur=sigma=2,noise=alls=10:allf=t",
    ("wildfire", "severe"): _BASE + ",eq=contrast=0.6:saturation=0.45:brightness='-0.06+0.06*sin(2*PI*t*3)':eval=frame,"
    "colorchannelmixer=rr=1:gg=0.72:bb=0.45,drawbox=x=0:y=0:w=iw:h=ih:color=0x9A5222@0.6:t=fill,"
    "gblur=sigma=3.5,noise=alls=14:allf=t,vignette=PI/4",
    ("wildfire", "offline"): _BASE + ",eq=contrast=0.6:saturation=0.45,colorchannelmixer=rr=1:gg=0.72:bb=0.45,"
    "drawbox=x=0:y=0:w=iw:h=ih:color=0x9A5222@0.6:t=fill,gblur=sigma=3.5,"
    "drawbox=x=0:y=0:w=iw:h=ih:color=black@1:t=fill:enable='gte(t,1.5)',noise=alls=6:allf=t",
    ("hurricane", "clear"): _BASE,
    ("hurricane", "haze"): _BASE + ",eq=brightness=-0.16:contrast=0.8:saturation=0.5,"
    "colorchannelmixer=rr=0.82:gg=0.92:bb=1.1,drawbox=x=0:y=ih*0.7:w=iw:h=ih*0.3:color=0x3E4C55@0.75:t=fill,"
    "gblur=sigma=1.6,noise=alls=34:allf=t+u",
    ("hurricane", "severe"): _BASE + ",eq=brightness='-0.3+0.55*gt(mod(t\\,2.3)\\,2.12)':contrast=0.75:saturation=0.4:eval=frame,"
    "colorchannelmixer=rr=0.78:gg=0.9:bb=1.12,drawbox=x=0:y=ih*0.45:w=iw:h=ih*0.55:color=0x34424A@0.85:t=fill,"
    "gblur=sigma=2.8,noise=alls=45:allf=t+u,crop=iw-24:ih-24:12+8*sin(t*23):12+8*cos(t*19),scale=640:360",
    ("hurricane", "offline"): _BASE + ",eq=brightness=-0.3:contrast=0.75:saturation=0.4,"
    "colorchannelmixer=rr=0.78:gg=0.9:bb=1.12,drawbox=x=0:y=ih*0.45:w=iw:h=ih*0.55:color=0x34424A@0.85:t=fill,"
    "gblur=sigma=2.8,noise=alls=45:allf=t+u,drawbox=x=0:y=0:w=iw:h=ih:color=black@1:t=fill:enable='gte(t,1.5)'",
}


def _run(args):
    subprocess.run([ffmpeg_bin(), "-v", "error", "-y", *args], check=True, timeout=120)


def prepare_base(raw_path, base_path):
    _run(["-i", raw_path, "-an", "-t", "5", "-vf", _BASE, "-c:v", "libx264", "-preset", "veryfast",
          "-crf", "26", "-pix_fmt", "yuv420p", "-movflags", "+faststart", base_path])


def render(base_path, out_path, scenario, level):
    _run(["-i", base_path, "-an", "-t", "5", "-vf", FILTERS[(scenario, level)], "-c:v", "libx264",
          "-preset", "veryfast", "-crf", "28", "-pix_fmt", "yuv420p", "-movflags", "+faststart", out_path])


def thumbnail(clip_path, out_path):
    _run(["-ss", "1.0", "-i", clip_path, "-frames:v", "1", "-vf", "scale=320:180", "-q:v", "5", out_path])
