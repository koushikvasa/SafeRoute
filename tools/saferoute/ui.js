(function (root) {
  const STATUS = {
    unread: { cls: "neutral", label: "Not analyzed" },
    clear: { cls: "clear", label: "Safe" },
    caution: { cls: "caution", label: "Caution" },
    risk: { cls: "risk", label: "Predicted to fail" },
    blocked: { cls: "blocked", label: "Not passable" },
    offline: { cls: "offline", label: "Camera lost" },
  };
  const ROWS = "ABCDEFGHIJ";
  const BEARING = { north: -29, east: 61, south: 151, west: 241 };
  const THUMB_ZOOM = 17;

  function esc(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, (ch) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[ch]));
  }

  function parse(id) {
    return [ROWS.indexOf(id[0]), Number(id.slice(1)) - 1];
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

  function labelOf(id, places) {
    const cell = places[id];
    return cell.place ? cell.place.label : cell.name;
  }

  function directions(path, places) {
    if (!path.length) return [];
    const out = [{ id: path[0], text: "Leave " + labelOf(path[0], places), detail: places[path[0]].name }];
    let i = 1;
    while (i < path.length) {
      const dir = heading(path[i - 1], path[i]);
      let j = i;
      while (j + 1 < path.length && heading(path[j], path[j + 1]) === dir) j += 1;
      const from = places[path[i - 1]];
      const to = places[path[j]];
      const alongAvenue = from.avenue === to.avenue;
      let dist = 0;
      for (let k = i; k <= j; k += 1) dist += meters(places[path[k - 1]], places[path[k]]);
      out.push({
        id: path[j],
        text: "Head " + dir + " on " + (alongAvenue ? from.avenue : from.street) + " to " + (alongAvenue ? to.street : to.avenue),
        detail: Math.round(dist) + " m · " + (j - i + 1) + " block" + (j === i ? "" : "s"),
      });
      i = j + 1;
    }
    out.push({ id: path[path.length - 1], text: "Arrive at " + labelOf(path[path.length - 1], places), detail: places[path[path.length - 1]].name });
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

  const api = { directions, heading, shown, reason, parse, STATUS, esc };
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
  let player = null;
  let busy = false;
  const trip = { from: "A1", to: root.NAMED.find((p) => p.key !== "home").cell };
  const label = (id) => labelOf(id, places);

  const theme = () => document.documentElement.dataset.theme;
  const setThemeLabel = () => { $("theme-btn").textContent = theme() === "dark" ? "Dark" : "Light"; };
  setThemeLabel();
  $("theme-btn").addEventListener("click", () => {
    const next = theme() === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    localStorage.setItem("saferoute-theme", next);
    setThemeLabel();
    paintMap();
  });

  const L = root.L;
  let map = null;
  let hazardLayer = null;
  let routeLayer = null;
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
    root.PLACES.forEach((cell) => {
      const marker = L.marker([cell.lat, cell.lon], { icon: pinIcon(cell.id, "unread", false), riseOnHover: true })
        .addTo(map)
        .bindTooltip(cell.id + " · " + cell.name, { direction: "top", offset: [0, -14] });
      marker.on("click", () => openCamera(cell.id));
      markers[cell.id] = marker;
    });
    map.on("zoomend", paintMap);
  } else {
    document.querySelector(".mapbox").insertAdjacentHTML("beforeend", '<div class="mapfail">The map could not load. The sidebar still works.</div>');
  }

  function current() {
    if (!timeline) return null;
    const step = timeline.steps[stepIndex];
    return Object.assign({}, step, step.routes[trip.to]);
  }

  function media(kind, id, step) {
    const cell = (step || current()).cells[id];
    return prefix + kind + "/" + scenario + "/" + cell.level + "/" + id + "." + (kind === "clip" ? "mp4" : "jpg");
  }

  function pinIcon(id, status, onRoute) {
    const cell = places[id];
    const cls = (STATUS[status] || STATUS.unread).cls + (onRoute ? " onroute" : "") + (selected === id ? " selected" : "");
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
      html = '<div class="dotpin ' + cls + '"></div>';
    }
    return L.divIcon({ className: "", html: html, iconSize: [0, 0] });
  }

  function css(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }

  function paintMap() {
    if (!map) return;
    const step = current();
    hazardLayer.clearLayers();
    routeLayer.clearLayers();
    ids.forEach((id) => {
      const status = step ? shown(step, id) : "unread";
      markers[id].setIcon(pinIcon(id, status, step ? step.path.includes(id) : false));
      const p = places[id];
      if (status === "offline") L.circle([p.lat, p.lon], { radius: 95, color: css("--blocked"), weight: 0, fillOpacity: 0.28 }).addTo(hazardLayer);
      if (status === "blocked") L.circle([p.lat, p.lon], { radius: 80, color: css("--blocked"), weight: 0, fillOpacity: 0.16 }).addTo(hazardLayer);
      if (status === "risk") L.circle([p.lat, p.lon], { radius: 70, color: css("--risk"), weight: 2, dashArray: "5 5", fillOpacity: 0.08 }).addTo(hazardLayer);
      if (status === "caution") L.circle([p.lat, p.lon], { radius: 70, color: css("--caution"), weight: 0, fillOpacity: 0.12 }).addTo(hazardLayer);
    });
    if (step && step.path.length > 1) {
      const points = step.path.map((id) => [places[id].lat, places[id].lon]);
      L.polyline(points, { color: css("--route"), weight: 10, opacity: 0.25, className: "route-glow" }).addTo(routeLayer);
      L.polyline(points, { color: css("--route"), weight: 5, opacity: 0.95, dashArray: "12 12", className: "route-ants" }).addTo(routeLayer);
    }
  }

  function paintWind() {
    const w = timeline.weather || {};
    $("wind").hidden = false;
    $("needle").style.transform = "rotate(" + ((BEARING[timeline.spread_direction] || 0) - 90) + "deg)";
    $("wind-title").textContent = (scenario === "hurricane" ? "Storm" : "Fire") + " spreading " + timeline.spread_direction;
    $("wind-text").textContent = w.available && w.wind_mph != null ? "Live wind " + Math.round(w.wind_mph) + " mph · Open-Meteo" : "Weather unavailable · default direction";
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
    return " Cosmos rejected " + rejected + " archive clip" + (rejected === 1 ? "" : "s")
      + " as a normal-day baseline (e.g. <i>" + esc(first.evidence || "")
      + "</i>) and swapped in other footage.";
  }

  function paintSide() {
    const step = current();
    const count = (s) => ids.filter((id) => shown(step, id) === s).length;
    const stats = '<div class="stats">'
      + '<div class="stat"><b>' + count("offline") + "</b><span>Lost</span></div>"
      + '<div class="stat"><b>' + count("blocked") + "</b><span>Not passable</span></div>"
      + '<div class="stat"><b>' + count("risk") + "</b><span>Predicted</span></div>"
      + '<div class="stat"><b>' + (count("clear") + count("caution")) + "</b><span>Usable</span></div></div>";
    let verify = "";
    if (step.verification && step.verification.predicted.length) {
      const v = step.verification;
      const shownIds = v.predicted.slice(0, 6).join(", ") + (v.predicted.length > 6 ? "…" : "");
      verify = '<div class="verify">Prediction check: at T+' + timeline.steps[stepIndex - 1].minute + " we flagged <b>" + v.predicted.length
        + "</b> corners (" + shownIds + ") to fail next. <b>" + v.correct.length + " of " + v.predicted.length + "</b> did.</div>";
    } else if (stepIndex === 0) {
      verify = '<div class="verify">Each step predicts which corners fail next. Move forward in time to check them.</div>';
    }
    let head;
    if (!step.path.length) {
      $("result").className = "card bad";
      head = '<h2><span class="dot"></span>T+' + step.minute + " · No way to " + esc(label(trip.to)) + "</h2><p>" + esc(step.warning) + "</p>";
    } else {
      const miles = step.distance_m / 1609.34;
      const minutes = Math.max(1, Math.round((miles / 12) * 60));
      $("result").className = "card " + (step.warning ? "warn" : "ok");
      head = '<h2><span class="dot"></span>T+' + step.minute + " · " + miles.toFixed(1) + " mi · ~" + minutes + " min · " + (step.path.length - 1) + " blocks</h2>"
        + "<p>" + esc(step.warning || "Avoids every lost, blocked and predicted corner.") + "</p>";
    }
    const live = step.reanalyzed_seconds ? '<p class="muted">Re-analyzed live in ' + step.reanalyzed_seconds + " s.</p>" : "";
    const rerouted = '<p class="muted">All ' + timeline.destinations.length + " destinations were routed and briefed when this disaster was built, so switching is instant.</p>";
    $("result").innerHTML = '<p class="muted" style="margin:0 0 6px">' + esc(label(trip.from)) + " → " + esc(label(trip.to)) + "</p>"
      + head + stats + verify + live + rerouted
      + '<div class="row"><button class="btn ghost small" id="reanalyze" type="button">Re-analyze T+' + step.minute + " live (100 feeds)</button></div>";
    $("reanalyze").addEventListener("click", reanalyze);

    $("brief").hidden = !step.briefing;
    if (step.briefing) $("brief").innerHTML = "<h5>Dispatcher briefing · W&amp;B Inference (Llama 3.1 8B)</h5><p>" + esc(step.briefing) + "</p>";

    $("dirs").innerHTML = directions(step.path, places).map((s) =>
      '<li><button type="button" data-id="' + s.id + '"><span>' + esc(s.text) + "<small>" + esc(s.detail) + "</small></span></button></li>"
    ).join("") || '<li class="muted">No route.</li>';

    const order = { offline: 0, blocked: 1, risk: 2 };
    const flagged = ids.filter((id) => shown(step, id) in order).sort((a, b) => order[shown(step, a)] - order[shown(step, b)]);
    const nearRoute = flagged.filter((id) => step.path.some((p) => {
      const [r1, c1] = parse(p);
      const [r2, c2] = parse(id);
      return Math.abs(r1 - r2) + Math.abs(c1 - c2) <= 1;
    }));
    const list = (nearRoute.length ? nearRoute : flagged).slice(0, 8);
    $("avoid-label").textContent = nearRoute.length ? "Hazards next to your route" : "What the cameras flagged";
    $("avoid").innerHTML = list.length ? list.map((id) => {
      const info = STATUS[shown(step, id)];
      return '<li data-id="' + id + '"><img alt="" src="' + media("thumb", id) + '"><div><span class="chip ' + info.cls + '">' + esc(info.label)
        + "</span> <b>" + esc(places[id].name) + '</b><span class="why">' + esc(reason(step, id, places)) + "</span></div></li>";
    }).join("") : '<li><span class="muted">Every camera shows a usable road.</span></li>';

    document.querySelectorAll(".tstep").forEach((b) => b.setAttribute("aria-pressed", String(Number(b.dataset.step) === stepIndex)));
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
    $("camera").innerHTML = '<header><div><h4>' + esc(id + " · " + places[id].name) + "</h4>"
      + (places[id].place ? '<p class="muted" style="margin:0 0 4px">' + esc(places[id].place.label) + "</p>" : "")
      + '<span class="chip ' + info.cls + '">' + esc(info.label) + "</span> "
      + '<span class="chip neutral">T+' + step.minute + " min</span></div>"
      + '<button class="x" type="button" aria-label="Close">×</button></header>'
      + '<video controls autoplay muted loop playsinline src="' + media("clip", id) + '"></video>'
      + '<p class="muted">Simulated effect on this feed: <b>' + esc(cell.effect || "None") + "</b>. The verdicts below come from the models watching it.</p>"
      + '<div class="verdict"><h5>NVIDIA Cosmos3-Reason · ' + esc(obs.model || "") + '</h5><div class="kv">'
      + "<div>Passable<b>" + yesNo(obs.passable) + "</b></div>"
      + "<div>Visibility<b>" + esc(obs.visibility || "–") + "</b></div>"
      + "<div>Traffic<b>" + esc(obs.traffic || "–") + "</b></div></div>"
      + '<div style="margin-top:8px">' + hazards + "</div>"
      + (obs.evidence ? "<q>" + esc(obs.evidence) + "</q>" : "")
      + '<p class="muted">Confidence ' + esc(obs.confidence != null ? obs.confidence : "–") + "</p></div>"
      + '<div class="verdict"><h5>Pixel signal check</h5><div class="kv">'
      + "<div>Signal<b>" + esc(h.signal || "–") + (h.lost_at != null ? " at " + h.lost_at + "s" : "") + "</b></div>"
      + "<div>Brightness<b>" + esc(h.brightness) + "</b></div>"
      + "<div>Motion<b>" + esc(h.motion) + "</b></div></div></div>"
      + '<div class="verdict"><h5>YOLO11 per frame</h5><div class="kv">'
      + "<div>Vehicles<b>" + (y ? y.vehicles : "–") + "</b></div>"
      + "<div>People<b>" + (y ? y.people : "–") + "</b></div>"
      + "<div>Run<b>" + (y ? "Yes" : "Skipped") + "</b></div></div></div>"
      + '<p class="muted">Source: ' + esc(cam.camera_id) + " · " + esc(cam.clip) + " (VAST archive)</p>";
    const panel = $("camera");
    panel.classList.add("open");
    panel.querySelector(".x").addEventListener("click", () => {
      panel.classList.remove("open");
      selected = null;
      paintMap();
    });
    paintMap();
    if (map && !keepView) map.setView([places[id].lat, places[id].lon], Math.max(map.getZoom(), THUMB_ZOOM), { animate: true });
  }

  function onPick(event) {
    const node = event.target.closest("[data-id]");
    if (node) openCamera(node.dataset.id);
  }
  $("dirs").addEventListener("click", onPick);
  $("avoid").addEventListener("click", onPick);
  $("wallgrid").addEventListener("click", (event) => {
    const node = event.target.closest("[data-id]");
    if (!node) return;
    $("wall").classList.remove("open");
    openCamera(node.dataset.id);
  });
  $("wall-btn").addEventListener("click", () => { paintWall(); $("wall").classList.add("open"); });
  $("wall-close").addEventListener("click", () => $("wall").classList.remove("open"));

  function goTo(index) {
    stepIndex = index;
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
  }
  $("play").addEventListener("click", () => {
    if (!timeline) return;
    if (player) { stopPlay(); return; }
    $("play").textContent = "❚❚";
    goTo(0);
    player = setInterval(() => {
      if (stepIndex >= timeline.steps.length - 1) { stopPlay(); return; }
      goTo(stepIndex + 1);
    }, 3500);
  });

  function setPrep(kind, title, text, progress, actions) {
    $("prep").className = "card " + kind;
    $("prep-title").textContent = title;
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
    const where = timeline.origins.map(nearest).join(" and ");
    setPrep("ok", "Disaster #" + timeline.seed,
      "A " + scenario + " starts near <b>" + esc(where) + "</b>. Built from " + timeline.feeds_analyzed
      + " pre-analyzed clips (Cosmos3-Reason + YOLO11), so a new location takes about a second."
      + swapNote(timeline.baseline_swaps), null,
      '<button class="btn primary" id="newloc" type="button">New disaster location</button>');
    $("newloc").addEventListener("click", newDisaster);
    $("drill").hidden = false;
    $("wall-btn").hidden = false;
    paintWind();
    paintStep();
  }

  async function newDisaster() {
    if (busy) return;
    busy = true;
    stopPlay();
    const button = $("newloc");
    if (button) { button.disabled = true; button.textContent = "Igniting somewhere new…"; }
    try {
      showTimeline(await post("compose", { scenario: scenario }));
    } catch (err) {
      setPrep("bad", "Could not build a disaster", "Try again in a moment.", null,
        '<button class="btn primary" id="newloc" type="button">Try again</button>');
      $("newloc").addEventListener("click", newDisaster);
    } finally {
      busy = false;
    }
  }

  async function refresh() {
    const state = await (await fetch(prefix + "state")).json();
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
        "Pins 100 real NYC feeds, renders each at every damage level, and lets Cosmos3-Reason and YOLO11 watch about 700 clips. One-time, about 6 minutes.",
        null, '<button class="btn primary" id="go" type="button">Start analysis</button>');
    }
    $("go").addEventListener("click", async () => { await post("prepare", {}); refresh(); });
  }

  async function reanalyze() {
    const button = $("reanalyze");
    button.disabled = true;
    button.textContent = "Cosmos3-Reason is re-watching 100 feeds…";
    try {
      showTimeline(await post("reanalyze", { scenario: scenario, step: stepIndex }), true);
    } catch (err) {
      button.textContent = "Re-analysis failed. Try again.";
      button.disabled = false;
    }
  }

  function setDest(cell) {
    trip.to = cell;
    $("dest").querySelectorAll("button").forEach((x) => x.setAttribute("aria-pressed", String(x.dataset.cell === cell)));
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
    return typeof o === "string" ? o : JSON.stringify(o);
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
    }).join("") : '<li class="muted">No model calls yet. Press "New disaster location" or "Re-analyze" to make some.</li>';
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
    if (panel.classList.toggle("open")) {
      $("camera").classList.remove("open");
      pollCalls();
      callsTimer = setInterval(pollCalls, 2500);
    } else {
      clearInterval(callsTimer);
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
    timeline = null;
    paintMap();
    refresh();
  });

  refresh();
})(typeof window !== "undefined" ? window : globalThis);
