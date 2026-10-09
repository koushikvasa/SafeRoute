(function (root) {
  const STATUS = {
    unread: { cls: "neutral", label: "Not analyzed" },
    clear: { cls: "clear", label: "Clear on camera" },
    caution: { cls: "caution", label: "Caution" },
    risk: { cls: "risk", label: "Predicted to fail" },
    blocked: { cls: "blocked", label: "Not passable" },
    offline: { cls: "offline", label: "Camera lost" },
  };
  const HAZARD = { offline: 0, blocked: 1, risk: 2 };
  const ROWS = "ABCDEFGHIJ";
  const BEARING = { north: -29, east: 61, south: 151, west: 241 };
  const COMPASS = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
  const THUMB_ZOOM = 17;
  const METERS_PER_MILE = 1609.34;

  function esc(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, (ch) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[ch]));
  }

  function parse(id) {
    return [ROWS.indexOf(id[0]), Number(id.slice(1)) - 1];
  }

  function blocksApart(a, b) {
    const [r1, c1] = parse(a);
    const [r2, c2] = parse(b);
    return Math.abs(r1 - r2) + Math.abs(c1 - c2);
  }

  function heading(from, to) {
    const [r1, c1] = parse(from);
    const [r2, c2] = parse(to);
    if (r2 > r1) return "south";
    if (r2 < r1) return "north";
    if (c2 > c1) return "east";
    return "west";
  }

  function meters(a, b) {
    const rad = Math.PI / 180;
    const dLat = (b.lat - a.lat) * rad;
    const dLon = (b.lon - a.lon) * rad;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
    return 2 * 6371000 * Math.asin(Math.sqrt(h));
  }

  function miles(m) {
    return (m / METERS_PER_MILE).toFixed(m < METERS_PER_MILE ? 2 : 1) + " mi";
  }

  function labelOf(id, places) {
    const cell = places[id];
    return cell.place ? cell.place.label : cell.name;
  }

  const DIRS = ["north", "east", "south", "west"];

  // Left/right relative to the direction you were already driving.
  function turnOf(prevDir, dir) {
    if (!prevDir) return "depart";
    return ["straight", "right", "uturn", "left"][(DIRS.indexOf(dir) - DIRS.indexOf(prevDir) + 4) % 4];
  }

  // Each leg keeps the path indexes it covers (from..to) so the map can highlight it.
  function directions(path, places) {
    if (!path.length) return [];
    const out = [{ id: path[0], kind: "start", text: "Leave " + labelOf(path[0], places), detail: places[path[0]].name, from: 0, to: 0 }];
    let i = 1;
    let prevDir = null;
    while (i < path.length) {
      const dir = heading(path[i - 1], path[i]);
      let j = i;
      while (j + 1 < path.length && heading(path[j], path[j + 1]) === dir) j += 1;
      const from = places[path[i - 1]];
      const to = places[path[j]];
      const alongAvenue = from.avenue === to.avenue;
      const road = alongAvenue ? from.avenue : from.street;
      const cross = alongAvenue ? to.street : to.avenue;
      let dist = 0;
      for (let k = i; k <= j; k += 1) dist += meters(places[path[k - 1]], places[path[k]]);
      const turn = turnOf(prevDir, dir);
      const blocks = j - i + 1;
      const verb = turn === "depart" ? "Head " + dir + " on " : turn === "straight" ? "Continue " + dir + " on " : turn === "uturn" ? "Turn around onto " : "Turn " + turn + " onto ";
      out.push({
        id: path[j],
        kind: turn,
        dir: dir,
        road: road,
        text: verb + road,
        detail: "Go " + blocks + " block" + (blocks === 1 ? "" : "s") + " to " + cross,
        distance: miles(dist),
        from: i - 1,
        to: j,
      });
      prevDir = dir;
      i = j + 1;
    }
    const last = path.length - 1;
    out.push({ id: path[last], kind: "arrive", text: "Arrive at " + labelOf(path[last], places), detail: places[path[last]].name, from: last, to: last });
    return out;
  }

  function shown(step, id) {
    const cell = step.cells[id];
    if ((cell.status === "clear" || cell.status === "caution") && step.predicted && step.predicted[id]) return "risk";
    return cell.status;
  }

  function reason(step, id, places) {
    const cell = step.cells[id];
    const obs = cell.observation || {};
    if (cell.status === "offline") {
      const lostAt = cell.health && cell.health.lost_at != null ? " at " + cell.health.lost_at + " s" : "";
      return "Feed went dark" + lostAt + ". Pixel check and Cosmos both report the camera is lost.";
    }
    if (step.predicted && step.predicted[id]) {
      return "Downwind of " + places[step.predicted[id]].name + ", which is already hit. " + (obs.evidence || "");
    }
    return obs.evidence || "";
  }

  function samePath(a, b) {
    return a.length === b.length && a.every((id, i) => id === b[i]);
  }

  // Compare the route at one step with the step before it. Pure, so it can be unit tested.
  function rerouteInfo(prevStep, step, prevPath, path) {
    if (!prevStep) return null;
    if (samePath(prevPath, path)) return { changed: false };
    const causes = prevPath.filter((id) => !path.includes(id) && shown(step, id) in HAZARD)
      .sort((a, b) => HAZARD[shown(step, a)] - HAZARD[shown(step, b)]);
    return { changed: true, causes: causes, extraBlocks: (path.length - 1) - (prevPath.length - 1) };
  }

  function nearestHazard(step, path, ids) {
    let best = null;
    ids.forEach((id) => {
      if (!(shown(step, id) in HAZARD) || path.includes(id)) return;
      path.forEach((p) => {
        const d = blocksApart(p, id);
        if (!best || d < best.blocks) best = { id: id, blocks: d };
      });
    });
    return best;
  }

  function cleanBriefing(text) {
    return String(text || "").trim().replace(/^["“]+|["”]+$/g, "").trim();
  }

  function compass(degrees) {
    return COMPASS[Math.round((((degrees % 360) + 360) % 360) / 22.5) % 16];
  }

  const api = { directions, heading, shown, reason, parse, STATUS, esc, rerouteInfo, nearestHazard, cleanBriefing, compass, samePath };
  if (typeof module !== "undefined") module.exports = api;
  if (typeof document === "undefined") return;

  const places = {};
  root.PLACES.forEach((cell) => { places[cell.id] = cell; });
  const ids = root.PLACES.map((c) => c.id);
  const prefix = root.location.pathname.replace(/\/?$/, "/");
  const $ = (id) => document.getElementById(id);
  let scenario = "wildfire";
  let timeline = null;
  let stepIndex = 0;
  let selected = null;
  let poller = null;
  let retryTimer = null;
  let player = null;
  let busy = false;
  let pendingCompose = false;
  let reanalyzing = false;
  let savedView = null;
  let changed = {};
  let changedUntil = 0;
  const trip = { from: "A1", to: root.NAMED.find((p) => p.key !== "home").cell };
  const label = (id) => labelOf(id, places);
  const store = {
    get: (k) => { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set: (k, v) => { try { localStorage.setItem(k, v); } catch (e) { /* private mode */ } },
  };

  const theme = () => document.documentElement.dataset.theme;
  const setThemeLabel = () => { $("theme-btn").textContent = theme() === "dark" ? "Light mode" : "Dark mode"; };
  setThemeLabel();
  $("theme-btn").addEventListener("click", () => {
    const next = theme() === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    store.set("saferoute-theme", next);
    setThemeLabel();
    paintMap();
  });

  if (root.matchMedia && root.matchMedia("(max-width: 1000px)").matches) {
    $("legend").open = false;
    $("dirwrap").open = false;
  }

  const L = root.L;
  let map = null;
  let hazardLayer = null;
  let routeLayer = null;
  let originLayer = null;
  let legLayer = null;
  const markers = {};
  if (L) {
    map = L.map("map", { zoomControl: false });
    L.control.zoom({ position: "topleft" }).addTo(map);
    L.tileLayer(prefix + "tiles/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    }).addTo(map);
    map.fitBounds(L.latLngBounds(root.PLACES.map((c) => [c.lat, c.lon])).pad(0.06));
    hazardLayer = L.layerGroup().addTo(map);
    routeLayer = L.layerGroup().addTo(map);
    originLayer = L.layerGroup().addTo(map);
    legLayer = L.layerGroup().addTo(map);
    root.PLACES.forEach((cell) => {
      const marker = L.marker([cell.lat, cell.lon], { icon: pinIcon(cell.id, "unread", false), riseOnHover: true, title: cell.name })
        .addTo(map)
        .bindTooltip(cell.name, { direction: "top", offset: [0, -14] });
      marker.on("click", () => openCamera(cell.id));
      markers[cell.id] = marker;
    });
    map.on("zoomend", paintMap);
  } else {
    document.querySelector(".mapbox").insertAdjacentHTML("beforeend", '<div class="mapfail">The map could not load. The sidebar still works.</div>');
  }

  function routeAt(index) {
    const step = timeline.steps[index];
    return step.routes[trip.to] || { path: [], warning: null, briefing: null, distance_m: 0 };
  }

  function current() {
    if (!timeline) return null;
    return Object.assign({}, timeline.steps[stepIndex], routeAt(stepIndex));
  }

  function previous() {
    if (!timeline || stepIndex === 0) return null;
    return Object.assign({}, timeline.steps[stepIndex - 1], routeAt(stepIndex - 1));
  }

  function rerouteAt(index) {
    if (!timeline || index === 0) return null;
    return rerouteInfo(timeline.steps[index - 1], timeline.steps[index], routeAt(index - 1).path, routeAt(index).path);
  }

  function media(kind, id, step) {
    const cell = (step || current()).cells[id];
    // Use the timeline's own scenario so media never mixes with a newer toggle.
    return prefix + kind + "/" + timeline.scenario + "/" + cell.level + "/" + id + "." + (kind === "clip" ? "mp4" : "jpg");
  }

  function pinIcon(id, status, onRoute) {
    const cell = places[id];
    const cls = (STATUS[status] || STATUS.unread).cls + (onRoute ? " onroute" : "") + (selected === id ? " selected" : "")
      + (changed[id] && Date.now() < changedUntil ? " changed" : "");
    const big = map && map.getZoom() >= THUMB_ZOOM && current();
    const isEnd = id === trip.from || id === trip.to;
    const tagText = cell.place ? cell.place.tag : isEnd ? (id === trip.from ? "START" : "END") : "";
    const tag = tagText ? '<i class="' + (STATUS[status] || STATUS.unread).cls + '"></i>' + esc(tagText) : "";
    let html;
    if (big) {
      const role = tag ? '<span class="role' + (isEnd ? " end" : "") + '">' + tag + "</span>" : "";
      html = '<div class="pin ' + cls + '" style="background-image:url(\'' + media("thumb", id) + '\')">' + role + "<b>" + id + "</b></div>";
    } else if (tag) {
      html = '<div class="dotpin place' + (isEnd ? " end" : "") + (onRoute ? " onroute" : "") + '">' + tag + "</div>";
    } else {
      const glyph = status === "offline" ? "✕" : status === "blocked" ? "!" : "";
      html = '<div class="dotpin ' + cls + '">' + glyph + "</div>";
    }
    return L.divIcon({ className: "", html: html, iconSize: [0, 0] });
  }

  function css(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }

  function gridLatLng(r, c) {
    const clamp = (v) => Math.min(ROWS.length - 1, Math.max(0, v));
    const r0 = clamp(Math.floor(r));
    const c0 = clamp(Math.floor(c));
    const r1 = clamp(r0 + 1);
    const c1 = clamp(c0 + 1);
    const fr = clamp(r) - r0;
    const fc = clamp(c) - c0;
    const at = (rr, cc) => places[ROWS[rr] + (cc + 1)];
    const mix = (key) => (at(r0, c0)[key] * (1 - fr) + at(r1, c0)[key] * fr) * (1 - fc)
      + (at(r0, c1)[key] * (1 - fr) + at(r1, c1)[key] * fr) * fc;
    return [mix("lat"), mix("lon")];
  }

  function paintMap() {
    if (!map) return;
    const step = current();
    hazardLayer.clearLayers();
    routeLayer.clearLayers();
    originLayer.clearLayers();
    legLayer.clearLayers();
    ids.forEach((id) => {
      const status = step ? shown(step, id) : "unread";
      markers[id].setIcon(pinIcon(id, status, step ? step.path.includes(id) : false));
      const p = places[id];
      if (status === "offline") L.circle([p.lat, p.lon], { radius: 95, color: css("--offline"), weight: 0, fillOpacity: 0.22, interactive: false }).addTo(hazardLayer);
      if (status === "blocked") L.circle([p.lat, p.lon], { radius: 80, color: css("--blocked"), weight: 0, fillOpacity: 0.18, interactive: false }).addTo(hazardLayer);
      if (status === "caution") L.circle([p.lat, p.lon], { radius: 60, color: css("--caution"), weight: 0, fillOpacity: 0.1, interactive: false }).addTo(hazardLayer);
    });
    if (!step) return;
    const icon = timeline.scenario === "hurricane" ? "◎" : "▲";
    (timeline.origins || []).forEach((o) => {
      L.marker(gridLatLng(o[0], o[1]), {
        icon: L.divIcon({ className: "", html: '<div class="firepin">' + icon + "</div>", iconSize: [0, 0] }),
        interactive: false, keyboard: false, zIndexOffset: -500,
      }).addTo(originLayer);
    });
    const info = rerouteAt(stepIndex);
    const prev = previous();
    if (info && info.changed && prev && prev.path.length > 1) {
      L.polyline(prev.path.map((id) => [places[id].lat, places[id].lon]), { color: css("--ghost"), weight: 4, opacity: 0.7, dashArray: "4 8", interactive: false }).addTo(routeLayer);
    }
    if (step.path.length > 1) {
      const points = step.path.map((id) => [places[id].lat, places[id].lon]);
      L.polyline(points, { color: css("--route"), weight: 10, opacity: 0.25, className: "route-glow", interactive: false }).addTo(routeLayer);
      L.polyline(points, { color: css("--route"), weight: 5, opacity: 0.95, dashArray: "12 12", className: "route-ants", interactive: false }).addTo(routeLayer);
    }
  }

  function fitRoute() {
    const step = current();
    if (!map || !step || step.path.length < 2) return;
    savedView = null;
    map.fitBounds(L.latLngBounds(step.path.map((id) => [places[id].lat, places[id].lon])).pad(0.2));
  }

  function paintWind() {
    const w = timeline.weather || {};
    $("wind").hidden = false;
    $("needle").style.transform = "rotate(" + ((BEARING[timeline.spread_direction] || 0) - 90) + "deg)";
    $("wind-title").textContent = (timeline.scenario === "hurricane" ? "Storm" : "Fire") + " spreading " + timeline.spread_direction;
    if (w.available && w.wind_mph != null) {
      const from = w.wind_from_degrees != null ? "Wind from " + compass(w.wind_from_degrees) + " · " : "Wind ";
      $("wind-text").textContent = from + Math.round(w.wind_mph) + " mph · live Open-Meteo";
    } else {
      $("wind-text").textContent = "Weather unavailable · default direction";
    }
  }

  function nearest(origin) {
    const r = Math.min(ROWS.length - 1, Math.max(0, Math.round(origin[0])));
    const c = Math.min(ROWS.length - 1, Math.max(0, Math.round(origin[1])));
    return places[ROWS[r] + (c + 1)].name;
  }

  function swapNote(swaps) {
    if (!swaps || !swaps.length) return "";
    const rejected = swaps.reduce((n, s) => n + s.rejected.length, 0);
    const first = swaps[0].rejected[0];
    return '<p class="muted">Before the drill, Cosmos reviewed the archive clips meant to show a normal day and rejected ' + rejected
      + " that already looked hazardous (e.g. <i>" + esc(first.evidence || "") + "</i>). Other footage was swapped in.</p>";
  }

  function placeButton(id) {
    return '<button type="button" class="linkish" data-id="' + id + '">' + esc(places[id].name) + "</button>";
  }

  function routeCallout(step) {
    if (!step.path.length) {
      return '<div class="callout none"><span class="ico">✕</span><span>Every way to ' + esc(label(trip.to))
        + " crosses a flagged corner. " + esc(step.warning || "") + "</span></div>";
    }
    const info = rerouteAt(stepIndex);
    if (info && info.changed) {
      const cause = info.causes.length
        ? placeButton(info.causes[0]) + " is now <b>" + esc(STATUS[shown(step, info.causes[0])].label.toLowerCase()) + "</b>"
          + (info.causes.length > 1 ? " (and " + (info.causes.length - 1) + " more on the old route)" : "") + "."
        : "the router found a path further from the flagged corners.";
      const extra = info.extraBlocks > 0 ? " New route is " + info.extraBlocks + " block" + (info.extraBlocks === 1 ? "" : "s") + " longer."
        : info.extraBlocks < 0 ? " New route is " + (-info.extraBlocks) + " block" + (info.extraBlocks === -1 ? "" : "s") + " shorter." : "";
      return '<div class="callout reroute"><span class="ico">↻</span><span><b>Rerouted at T+' + step.minute + ".</b> "
        + (info.causes.length ? "" : "Since T+" + timeline.steps[stepIndex - 1].minute + ", ") + cause + extra + " The grey dashed line is the old route.</span></div>";
    }
    const near = nearestHazard(step, step.path, ids);
    const since = stepIndex > 0 ? " since T+" + sinceMinute() : "";
    const nearText = near
      ? " Nearest flagged corner: " + placeButton(near.id) + ", " + near.blocks + " block" + (near.blocks === 1 ? "" : "s") + " away."
      : "";
    return '<div class="callout held"><span class="ico">✓</span><span><b>Route ' + (stepIndex > 0 ? "held" + since : "avoids every flagged corner")
      + ".</b>" + nearText + "</span></div>";
  }

  function sinceMinute() {
    let i = stepIndex;
    while (i > 0 && !(rerouteAt(i) || {}).changed) i -= 1;
    return timeline.steps[i].minute;
  }

  function paintTimelineBadges() {
    document.querySelectorAll(".tstep").forEach((b) => {
      const i = Number(b.dataset.step);
      b.disabled = !timeline;
      b.setAttribute("aria-pressed", String(!!timeline && i === stepIndex));
      const old = b.querySelector(".rr");
      if (old) old.remove();
      const info = timeline ? rerouteAt(i) : null;
      if (info && info.changed) {
        b.insertAdjacentHTML("beforeend", '<span class="rr" title="Route changes here">↻</span>');
        b.setAttribute("aria-label", "T+" + timeline.steps[i].minute + " minutes, rerouted");
      } else {
        b.removeAttribute("aria-label");
      }
    });
  }

  const ARROW = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">';
  const TURN_ICON = {
    start: '<svg viewBox="0 0 24 24" width="14" height="14"><circle cx="12" cy="12" r="7" fill="currentColor"/></svg>',
    depart: ARROW + '<path d="M12 20V5M6 11l6-6 6 6"/></svg>',
    straight: ARROW + '<path d="M12 20V5M6 11l6-6 6 6"/></svg>',
    left: ARROW + '<path d="M17 20v-7a4 4 0 0 0-4-4H5M9 5L5 9l4 4"/></svg>',
    right: ARROW + '<path d="M7 20v-7a4 4 0 0 1 4-4h8M15 5l4 4-4 4"/></svg>',
    uturn: ARROW + '<path d="M8 20V9a4 4 0 0 1 8 0v4M12 10l4 4 4-4"/></svg>',
    arrive: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M6 21V4M6 4h11l-2 4 2 4H6"/></svg>',
  };
  let legs = [];

  function paintDirections(step) {
    legs = directions(step.path, places);
    const turns = legs.filter((s) => s.kind === "left" || s.kind === "right").length;
    $("dirs-label").textContent = legs.length
      ? "Directions · " + turns + " turn" + (turns === 1 ? "" : "s") + " · " + miles(step.distance_m)
      : "Directions";
    $("dirs").innerHTML = legs.map((s, n) => {
      // Corners this leg drives through that the cameras are not fully happy with.
      const watch = step.path.slice(s.from + 1, s.to + 1).filter((id) => shown(step, id) !== "clear");
      const note = watch.length
        ? '<span class="leg-note chip ' + STATUS[shown(step, watch[0])].cls + '">' + esc(STATUS[shown(step, watch[0])].label) + " at " + esc(places[watch[0]].name)
          + (watch.length > 1 ? " +" + (watch.length - 1) : "") + "</span>"
        : "";
      return '<li class="leg ' + s.kind + '"><button type="button" data-id="' + s.id + '" data-leg="' + n + '">'
        + '<span class="turn" aria-hidden="true">' + TURN_ICON[s.kind] + "</span>"
        + '<span class="what"><b>' + esc(s.text) + "</b><small>" + esc(s.detail) + "</small>" + note + "</span>"
        + (s.distance ? '<span class="dist">' + esc(s.distance) + "</span>" : "")
        + "</button></li>";
    }).join("") || '<li class="muted">No route.</li>';
  }

  function highlightLeg(n) {
    if (!map) return;
    legLayer.clearLayers();
    const step = current();
    const leg = legs[n];
    if (!step || !leg) return;
    const pts = step.path.slice(leg.from, leg.to + 1).map((id) => [places[id].lat, places[id].lon]);
    if (pts.length > 1) {
      L.polyline(pts, { color: css("--text"), weight: 11, opacity: 0.9, interactive: false }).addTo(legLayer);
      L.polyline(pts, { color: css("--route"), weight: 6, opacity: 1, interactive: false }).addTo(legLayer);
    } else {
      L.circleMarker(pts[0], { radius: 11, color: css("--route"), weight: 3, fillOpacity: 0.2, interactive: false }).addTo(legLayer);
    }
  }

  function paintSide() {
    const step = current();
    const count = (s) => ids.filter((id) => shown(step, id) === s).length;
    let head;
    if (!step.path.length) {
      $("result").className = "card route-card bad";
      head = '<p class="big">No clear route</p>';
    } else {
      $("result").className = "card route-card " + (step.warning ? "warn" : "ok");
      head = '<p class="big">' + miles(step.distance_m) + " <small>· " + (step.path.length - 1) + " blocks · drill route, not verified safe</small></p>"
        + (step.warning ? "<p>" + esc(step.warning) + "</p>" : "");
    }
    $("result").innerHTML = '<p class="trip">' + esc(label(trip.from)) + " → <b>" + esc(label(trip.to)) + "</b> · T+" + step.minute + " min</p>"
      + head + routeCallout(step);

    $("brief").hidden = !step.briefing;
    if (step.briefing) {
      $("brief").innerHTML = "<h5>AI dispatcher note · W&amp;B Inference (Llama 3.1 8B)</h5><p>" + esc(cleanBriefing(step.briefing)) + "</p>"
        + '<p class="caveat">Written by an LLM from the camera facts. If it disagrees with the directions below, follow the directions.</p>';
    }

    paintDirections(step);

    const flagged = ids.filter((id) => shown(step, id) in HAZARD).sort((a, b) => HAZARD[shown(step, a)] - HAZARD[shown(step, b)]);
    const nearRoute = flagged.filter((id) => step.path.some((p) => blocksApart(p, id) <= 1));
    const list = (nearRoute.length ? nearRoute : flagged).slice(0, 8);
    $("avoid-label").textContent = nearRoute.length ? "Hazards next to your route" : "What the cameras flagged";
    $("avoid").innerHTML = list.length ? list.map((id) => {
      const info = STATUS[shown(step, id)];
      return '<li data-id="' + id + '" tabindex="0" role="button"><img alt="" src="' + media("thumb", id) + '"><div><span class="chip ' + info.cls + '">' + esc(info.label)
        + "</span> <b>" + esc(places[id].name) + '</b><span class="why">' + esc(reason(step, id, places)) + "</span></div></li>";
    }).join("") : '<li><span class="muted">Every camera shows a usable road.</span></li>';

    let verify = "";
    if (step.verification && step.verification.predicted.length) {
      const v = step.verification;
      const names = v.predicted.slice(0, 3).map((id) => places[id].name).join("; ") + (v.predicted.length > 3 ? "; …" : "");
      verify = '<div class="verify">Prediction check: at T+' + timeline.steps[stepIndex - 1].minute + " we flagged <b>" + v.predicted.length
        + "</b> corners to fail next (" + esc(names) + "). <b>" + v.correct.length + " of " + v.predicted.length + "</b> did.</div>";
    } else if (stepIndex === 0) {
      verify = '<div class="verify">Each step predicts which corners fail next. Move the drill clock forward to check them.</div>';
    }
    const stats = '<div class="stats">'
      + '<div class="stat"><b>' + count("offline") + "</b><span>Lost</span></div>"
      + '<div class="stat"><b>' + count("blocked") + "</b><span>Not passable</span></div>"
      + '<div class="stat"><b>' + count("risk") + "</b><span>Predicted</span></div>"
      + '<div class="stat"><b>' + (count("clear") + count("caution")) + "</b><span>Usable</span></div></div>";
    const live = step.reanalyzed_seconds ? '<p class="muted">Re-analyzed live in ' + step.reanalyzed_seconds + " s.</p>" : "";
    $("hood-body").innerHTML = stats + verify + live
      + '<p class="muted">Disaster #' + esc(timeline.seed) + " · built from " + esc(timeline.feeds_analyzed)
      + " pre-analyzed clips. Every destination was routed and briefed up front, so switching is instant.</p>"
      + swapNote(timeline.baseline_swaps)
      + '<div class="row"><button class="btn ghost small" id="reanalyze" type="button"' + (reanalyzing ? " disabled" : "") + ">"
      + (reanalyzing ? "Cosmos3-Reason is re-watching 100 feeds…" : "Re-analyze T+" + step.minute + " live (100 feeds)") + "</button></div>";
    $("reanalyze").addEventListener("click", reanalyze);

    paintTimelineBadges();
  }

  function paintWall() {
    const step = current();
    $("wall-title").textContent = "All 100 feeds at T+" + step.minute + " min, laid out like the map · click any feed";
    $("wallgrid").innerHTML = ids.map((id) => {
      const cls = STATUS[shown(step, id)].cls + (step.path.includes(id) ? " onroute" : "");
      return '<div class="feed ' + cls + '" data-id="' + id + '" title="' + esc(places[id].name + " · " + ((step.cells[id].observation || {}).evidence || "")) + '">'
        + '<img loading="lazy" alt="" src="' + media("thumb", id) + '"><span class="id">' + id + "</span></div>";
    }).join("");
  }

  function paintStep() {
    paintMap();
    paintSide();
    if ($("wall").classList.contains("open")) paintWall();
    if (selected) openCamera(selected, true);
  }

  function yesNo(value) {
    return value === true ? "Yes" : value === false ? "No" : "Unknown";
  }

  function closeCamera() {
    $("camera").classList.remove("open");
    selected = null;
    if (map && savedView) map.setView(savedView.center, savedView.zoom, { animate: true });
    savedView = null;
    paintMap();
  }

  function openCamera(id, keepView) {
    const step = current();
    if (!step) return;
    selected = id;
    const cell = step.cells[id];
    const info = STATUS[shown(step, id)];
    const obs = cell.observation || {};
    const h = cell.health || {};
    const y = cell.yolo;
    const cam = timeline.cameras[id] || {};
    const hazards = (obs.hazards || []).map((x) => '<span class="chip neutral">' + esc(x) + "</span>").join(" ") || '<span class="muted">none</span>';
    const pct = obs.confidence != null ? Math.round(Number(obs.confidence) * 100) + "% sure" : "";
    const verdict = obs.passable === false ? "Not passable" : obs.passable ? "Passable" : "Unsure";
    $("camera").innerHTML = '<header><div><h4>' + esc(places[id].name) + "</h4>"
      + (places[id].place ? '<p class="muted" style="margin:0 0 4px">' + esc(places[id].place.label) + "</p>" : "")
      + '<span class="chip ' + info.cls + '">' + esc(info.label) + "</span> "
      + '<span class="chip neutral">T+' + step.minute + " min</span></div>"
      + '<button class="x" type="button" aria-label="Close camera">×</button></header>'
      + '<video controls autoplay muted loop playsinline src="' + media("clip", id) + '"></video>'
      + '<p class="say"><b>Cosmos3-Reason: ' + verdict + "</b>" + (pct ? " · " + pct : "") + (obs.evidence ? "<br>" + esc(obs.evidence) : "") + "</p>"
      + '<p class="muted">Simulated effect added to this archived clip: <b>' + esc(cell.effect || "None") + "</b>. The verdict comes from the model watching the result.</p>"
      + "<details><summary>Model readouts (Cosmos, pixel check, YOLO11)</summary>"
      + '<div class="verdict"><h5>NVIDIA Cosmos3-Reason · ' + esc(obs.model || "") + '</h5><div class="kv">'
      + "<div>Passable<b>" + yesNo(obs.passable) + "</b></div>"
      + "<div>Visibility<b>" + esc(obs.visibility || "–") + "</b></div>"
      + "<div>Traffic<b>" + esc(obs.traffic || "–") + "</b></div></div>"
      + '<div style="margin-top:8px">' + hazards + "</div>"
      + '<p class="muted">Confidence ' + esc(obs.confidence != null ? obs.confidence : "–") + "</p></div>"
      + '<div class="verdict"><h5>Pixel signal check</h5><div class="kv">'
      + "<div>Signal<b>" + esc(h.signal || "–") + (h.lost_at != null ? " at " + h.lost_at + "s" : "") + "</b></div>"
      + "<div>Brightness<b>" + esc(h.brightness) + "</b></div>"
      + "<div>Motion<b>" + esc(h.motion) + "</b></div></div></div>"
      + '<div class="verdict"><h5>YOLO11 per frame</h5><div class="kv">'
      + "<div>Vehicles<b>" + (y ? y.vehicles : "–") + "</b></div>"
      + "<div>People<b>" + (y ? y.people : "–") + "</b></div>"
      + "<div>Run<b>" + (y ? "Yes" : "Skipped") + "</b></div></div></div></details>"
      + '<p class="muted">Source: ' + esc(cam.camera_id) + " · " + esc(cam.clip) + " (archived VAST clip assigned to this corner for the drill, not a live feed)</p>";
    const panel = $("camera");
    panel.classList.add("open");
    $("calls").classList.remove("open");
    clearInterval(callsTimer);
    panel.querySelector(".x").addEventListener("click", closeCamera);
    paintMap();
    if (map && !keepView) {
      if (!savedView) savedView = { center: map.getCenter(), zoom: map.getZoom() };
      map.setView([places[id].lat, places[id].lon], Math.max(map.getZoom(), THUMB_ZOOM), { animate: true });
    }
  }

  function onPick(event) {
    const node = event.target.closest("[data-id]");
    if (node) openCamera(node.dataset.id);
  }
  $("dirs").addEventListener("click", onPick);
  const legOf = (event) => { const b = event.target.closest("[data-leg]"); return b ? Number(b.dataset.leg) : null; };
  $("dirs").addEventListener("mouseover", (event) => { const n = legOf(event); if (n != null) highlightLeg(n); });
  $("dirs").addEventListener("focusin", (event) => { const n = legOf(event); if (n != null) highlightLeg(n); });
  $("dirs").addEventListener("mouseleave", () => { if (legLayer) legLayer.clearLayers(); });
  $("dirs").addEventListener("focusout", () => { if (legLayer) legLayer.clearLayers(); });
  $("avoid").addEventListener("click", onPick);
  $("avoid").addEventListener("keydown", (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onPick(event); } });
  $("result").addEventListener("click", onPick);
  $("wallgrid").addEventListener("click", (event) => {
    const node = event.target.closest("[data-id]");
    if (!node) return;
    $("wall").classList.remove("open");
    openCamera(node.dataset.id);
  });
  $("wall-btn").addEventListener("click", () => { paintWall(); $("wall").classList.add("open"); });
  $("wall-close").addEventListener("click", () => $("wall").classList.remove("open"));
  $("fit-btn").addEventListener("click", fitRoute);
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    if ($("wall").classList.contains("open")) $("wall").classList.remove("open");
    else if ($("camera").classList.contains("open")) closeCamera();
  });

  function goTo(index) {
    const from = stepIndex;
    stepIndex = index;
    changed = {};
    if (timeline && index > 0 && index !== from) {
      const before = timeline.steps[index - 1];
      const now = timeline.steps[index];
      ids.forEach((id) => { if (shown(now, id) in HAZARD && shown(before, id) !== shown(now, id)) changed[id] = true; });
      changedUntil = Date.now() + 3000;
    }
    paintStep();
  }
  $("timeline").addEventListener("click", (event) => {
    const button = event.target.closest(".tstep");
    if (button && timeline) { stopPlay(); goTo(Number(button.dataset.step)); }
  });
  function stopPlay() {
    if (player) clearInterval(player);
    player = null;
    $("play").textContent = "▶";
    $("play").setAttribute("aria-label", "Play timeline");
  }
  $("play").addEventListener("click", () => {
    if (!timeline) return;
    if (player) { stopPlay(); return; }
    $("play").textContent = "❚❚";
    $("play").setAttribute("aria-label", "Pause timeline");
    if (stepIndex >= timeline.steps.length - 1) goTo(0);
    player = setInterval(() => {
      if (stepIndex >= timeline.steps.length - 1) { stopPlay(); return; }
      goTo(stepIndex + 1);
    }, 3500);
  });

  function setPrep(kind, title, text, progress, actions) {
    $("prep").className = "card " + kind;
    $("prep-title").innerHTML = title;
    $("prep-text").innerHTML = text;
    $("prep-bar").hidden = progress == null;
    if (progress != null) $("prep-bar").querySelector("i").style.width = Math.round(progress * 100) + "%";
    $("prep-actions").innerHTML = actions || "";
  }

  async function post(path, body) {
    const response = await fetch(prefix + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (!response.ok) throw new Error(path + " failed");
    return response.json();
  }

  function showTimeline(next, keepStep) {
    timeline = next;
    if (!keepStep) stepIndex = 0;
    changed = {};
    const where = timeline.origins.map(nearest).join(" and ");
    const icon = timeline.scenario === "hurricane" ? "◎" : "▲";
    setPrep("ok", '<i class="fire-ico">' + icon + "</i> " + (timeline.scenario === "hurricane" ? "Hurricane" : "Wildfire") + " starts near <b>" + esc(where) + "</b>",
      "", null, '<button class="btn ghost small" id="newloc" type="button">New location</button>');
    $("newloc").addEventListener("click", newDisaster);
    $("drill").hidden = false;
    $("wall-btn").hidden = false;
    $("fit-btn").hidden = false;
    paintWind();
    paintStep();
  }

  async function newDisaster() {
    if (busy) { pendingCompose = true; return; }
    busy = true;
    stopPlay();
    const want = scenario;
    const button = $("newloc");
    if (button) { button.disabled = true; button.textContent = want === "hurricane" ? "Moving the storm…" : "Igniting somewhere new…"; }
    try {
      const next = await post("compose", { scenario: want });
      if (want === scenario) showTimeline(next);
      else pendingCompose = true;
    } catch (err) {
      setPrep("bad", "Could not build a disaster", "The server did not answer. Try again in a moment.", null,
        '<button class="btn primary" id="newloc" type="button">Try again</button>');
      $("newloc").addEventListener("click", newDisaster);
    } finally {
      busy = false;
      if (pendingCompose) { pendingCompose = false; newDisaster(); }
    }
  }

  function scheduleRetry() {
    if (retryTimer) return;
    retryTimer = setTimeout(() => { retryTimer = null; refresh(); }, 5000);
  }

  async function refresh() {
    let state;
    try {
      const response = await fetch(prefix + "state");
      if (!response.ok) throw new Error("state " + response.status);
      state = await response.json();
    } catch (err) {
      if (poller) { clearInterval(poller); poller = null; }
      if (!timeline) {
        $("drill").hidden = true;
        setPrep("bad", "Can't reach the drill server", "It may be restarting. Retrying every 5 seconds…", null,
          '<button class="btn primary" id="go-retry" type="button">Retry now</button>');
        $("go-retry").addEventListener("click", () => { clearTimeout(retryTimer); retryTimer = null; refresh(); });
      }
      scheduleRetry();
      return;
    }
    if (state.status === "ready") {
      if (poller) { clearInterval(poller); poller = null; }
      if (!timeline || timeline.scenario !== scenario) newDisaster();
      return;
    }
    $("drill").hidden = true;
    if (state.status === "running") {
      const pct = state.total ? state.done / state.total : 0;
      setPrep("run", "Analyzing the camera network", esc(state.phase) + " (" + state.done + "/" + state.total + "). One-time step, about 6 minutes.", pct);
      if (!poller) poller = setInterval(refresh, 2000);
      return;
    }
    if (poller) { clearInterval(poller); poller = null; }
    if (state.status === "error") {
      setPrep("bad", "Analysis failed", esc(state.error || "Unknown error"), null, '<button class="btn primary" id="go" type="button">Try again</button>');
    } else {
      setPrep("", "Analyze the camera network",
        "Pins 100 archived street clips to Midtown corners, renders each at every damage level, and lets Cosmos3-Reason and YOLO11 watch about 700 clips. One-time, about 6 minutes.",
        null, '<button class="btn primary" id="go" type="button">Start analysis</button>');
    }
    $("go").addEventListener("click", async (event) => {
      event.target.disabled = true;
      try { await post("prepare", {}); } catch (err) { /* refresh shows the error state */ }
      refresh();
    });
  }

  async function reanalyze() {
    if (reanalyzing || !timeline) return;
    reanalyzing = true;
    const want = scenario;
    const at = stepIndex;
    paintSide();
    try {
      const next = await post("reanalyze", { scenario: want, step: at });
      reanalyzing = false;
      if (want === scenario) showTimeline(next, true);
    } catch (err) {
      reanalyzing = false;
      if (timeline) paintSide();
      const button = $("reanalyze");
      if (button) button.textContent = "Re-analysis failed. Try again.";
    }
  }

  function setDest(cell) {
    trip.to = cell;
    $("dest").querySelectorAll("button").forEach((x) => x.setAttribute("aria-pressed", String(x.dataset.cell === cell)));
    changed = {};
    if (timeline) paintStep();
  }

  $("dest").addEventListener("click", (event) => {
    const button = event.target.closest("button");
    if (button) setDest(button.dataset.cell);
  });

  const OPS = {
    cosmos3_reason_assess: { name: "Cosmos3-Reason", what: "NVIDIA · watches the clip" },
    yolo11_counts: { name: "YOLO11", what: "Counts vehicles and people" },
    signal_check: { name: "Pixel check", what: "Brightness and motion" },
    wandb_briefing: { name: "Llama 3.1 8B", what: "W&B Inference · briefing" },
  };
  let callsTimer = null;
  let lastSeq = 0;

  function callSummary(c) {
    const o = c.output;
    if (!c.ok) return "Failed: " + (o || "error");
    if (!o) return "";
    if (c.op === "cosmos3_reason_assess") {
      return (o.passable === false ? "Not passable" : o.passable ? "Passable" : "Unsure") + " · visibility " + (o.visibility || "?")
        + ((o.hazards || []).length ? " · " + o.hazards.join(", ") : "") + (o.evidence ? ". " + o.evidence : "");
    }
    if (c.op === "yolo11_counts") return o.vehicles + " vehicles · " + o.people + " people per frame";
    if (c.op === "signal_check") return "Signal " + o.signal + " · brightness " + o.brightness + " · motion " + o.motion;
    return typeof o === "string" ? cleanBriefing(o) : JSON.stringify(o);
  }

  function paintCalls(data) {
    const w = data.weave || {};
    $("calls-note").textContent = "Every model call this app makes, newest first. "
      + (w.enabled ? "Each one is also traced to W&B Weave (" + w.project + ")." : "W&B Weave tracing is off.");
    $("opstats").innerHTML = Object.keys(OPS).map((op) => {
      const s = (data.stats || {})[op] || { count: 0, avg_ms: 0, errors: 0 };
      return '<div class="opstat"><b>' + OPS[op].name + "</b><span>" + OPS[op].what + "</span>"
        + "<em>" + s.count + "</em> calls · avg " + (s.avg_ms / 1000).toFixed(2) + " s" + (s.errors ? " · " + s.errors + " failed" : "") + "</div>";
    }).join("");
    const calls = data.calls || [];
    $("calllist").innerHTML = calls.length ? calls.map((c) => {
      const meta = OPS[c.op] || { name: c.op };
      return '<li class="' + (lastSeq && c.seq > lastSeq ? "fresh" : "") + '"><div class="top">'
        + '<span class="chip ' + (c.ok ? "neutral" : "blocked") + '">' + esc(meta.name) + "</span>"
        + '<span class="where">' + esc(c.label || "") + "</span>"
        + '<span class="ms">' + new Date(c.at).toLocaleTimeString() + " · " + (c.ms / 1000).toFixed(2) + " s</span></div>"
        + '<div class="out">' + esc(callSummary(c)) + "</div>"
        + (c.trace_id ? '<div class="tid">Weave trace ' + esc(c.trace_id) + "</div>" : "") + "</li>";
    }).join("") : '<li class="muted">No model calls yet. Press "New location" or "Re-analyze" to make some.</li>';
    lastSeq = calls.length ? calls[0].seq : lastSeq;
  }

  async function pollCalls() {
    try {
      paintCalls(await (await fetch(prefix + "calls")).json());
    } catch (err) {
      $("calls-note").textContent = "Could not load model calls. Retrying…";
    }
  }

  $("calls-btn").addEventListener("click", () => {
    const panel = $("calls");
    clearInterval(callsTimer);
    if (panel.classList.toggle("open")) {
      if ($("camera").classList.contains("open")) closeCamera();
      pollCalls();
      callsTimer = setInterval(pollCalls, 2500);
    }
  });
  $("calls-close").addEventListener("click", () => {
    $("calls").classList.remove("open");
    clearInterval(callsTimer);
  });

  $("scenario").addEventListener("click", (event) => {
    const button = event.target.closest("button");
    if (!button || button.dataset.value === scenario) return;
    scenario = button.dataset.value;
    $("scenario").querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", String(b === button)));
    stopPlay();
    $("camera").classList.remove("open");
    $("wall").classList.remove("open");
    selected = null;
    savedView = null;
    timeline = null;
    changed = {};
    $("drill").hidden = true;
    $("wind").hidden = true;
    $("fit-btn").hidden = true;
    $("wall-btn").hidden = true;
    paintTimelineBadges();
    setPrep("run", scenario === "hurricane" ? "Building a hurricane…" : "Building a wildfire…", "", null);
    paintMap();
    refresh();
  });

  refresh();
})(typeof window !== "undefined" ? window : globalThis);
