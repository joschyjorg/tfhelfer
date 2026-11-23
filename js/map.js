'use strict';
// Karte auf Canvas: Norden immer oben, Strecke, Betriebsstellen, Positionspfeil, Maßstab.
// Bedienung: ein Finger (oder Maus) verschiebt, zwei Finger zoomen (Pinch), Mausrad zoomt.
// Jede Geste schaltet "Folgen" aus. setFollow(true) bringt die Karte zurück zur Position.
function createMap(canvas, getColors) {
  const ctx = canvas.getContext('2d');
  const SIDES = [500, 1000, 2000, 4000, 8000, 16000]; // Stufen der Tasten + und −: Seitenlänge des Kartenquadrats in Metern
  const SIDE_MIN = 250, SIDE_MAX = 40000;              // Grenzen beim Pinch und Mausrad
  const FOLLOW_MAX = 16000;
  const st = {
    route: null, pos: null, heading: 0, s: 0, stale: false,
    side: SIDES[3], lastFollowSide: SIDES[3],
    follow: true, overview: false, cx: 0, cy: 0,   // cx, cy: Kartenmitte (Meter), nur wenn nicht gefolgt wird
    w: 0, h: 0, dpr: 1
  };
  const clampSide = v => Math.max(SIDE_MIN, Math.min(SIDE_MAX, v));
  const changed = () => { if (api.onViewChange) api.onViewChange(); };

  function origin() { return st.route.pts[0]; }
  function xy(lat, lon) {
    const o = origin(), M = Geo.M;
    return [(lon - o[1]) * M * Math.cos(o[0] * Geo.D2R), (o[0] - lat) * M];
  }

  function fit() {
    const size = Math.min(st.w, st.h);
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const p of st.route.pts) {
      const q = xy(p[0], p[1]);
      x0 = Math.min(x0, q[0]); x1 = Math.max(x1, q[0]); y0 = Math.min(y0, q[1]); y1 = Math.max(y1, q[1]);
    }
    const side = Math.max(x1 - x0, y1 - y0, 500) * 1.3;
    return { cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, ppm: size / side };
  }

  // Aktuelle Ansicht: Mitte (Meter) und Pixel pro Meter
  function view() {
    const size = Math.min(st.w, st.h);
    if (st.overview || (st.follow && !st.pos)) return fit();
    if (st.follow) { const c = xy(st.pos.lat, st.pos.lon); return { cx: c[0], cy: c[1], ppm: size / st.side }; }
    return { cx: st.cx, cy: st.cy, ppm: size / st.side };
  }

  // Aus "Folgen" oder "Gesamte Strecke" in die freie Ansicht wechseln, ohne dass die Karte springt
  function detach() {
    if (!st.follow && !st.overview) return;
    const v = view(), size = Math.min(st.w, st.h);
    if (st.follow && !st.overview) st.lastFollowSide = st.side;
    st.cx = v.cx; st.cy = v.cy; st.side = clampSide(size / v.ppm);
    st.follow = false; st.overview = false;
    changed();
  }

  function draw() {
    const w = st.w, h = st.h;
    if (!w || !h) return;
    const c = getColors();
    ctx.setTransform(st.dpr, 0, 0, st.dpr, 0, 0);
    ctx.fillStyle = c.mapbg;
    ctx.fillRect(0, 0, w, h);
    if (!st.route) return;
    const v = view();
    const px = (lat, lon) => { const q = xy(lat, lon); return [w / 2 + (q[0] - v.cx) * v.ppm, h / 2 + (q[1] - v.cy) * v.ppm]; };
    const route = st.route;

    // Strecke: ganze Linie, danach der bereits gefahrene Teil grau
    const line = (pts, color, width) => {
      ctx.beginPath();
      pts.forEach((p, i) => { const q = px(p[0], p[1]); i ? ctx.lineTo(q[0], q[1]) : ctx.moveTo(q[0], q[1]); });
      ctx.strokeStyle = color; ctx.lineWidth = width; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.stroke();
    };
    line(route.pts, c.route, 6);
    if (st.s > 0) {
      const done = [];
      for (let i = 0; i < route.pts.length && route.cum[i] <= st.s; i++) done.push(route.pts[i]);
      const e = Route.pointAt(route, st.s);
      done.push([e.lat, e.lon]);
      if (done.length > 1) line(done, c.done, 6);
    }

    // Betriebsstellen mit Namen
    ctx.font = '700 20px system-ui, "Segoe UI", Roboto, sans-serif';
    ctx.textBaseline = 'middle';
    route.stations.forEach((s, i) => {
      const q = px(s.lat, s.lon);
      if (q[0] < -60 || q[0] > w + 60 || q[1] < -30 || q[1] > h + 30) return;
      ctx.beginPath(); ctx.arc(q[0], q[1], 9, 0, 7);
      ctx.fillStyle = c.panel; ctx.fill(); ctx.lineWidth = 4; ctx.strokeStyle = c.tx; ctx.stroke();
      const right = i % 2 === 1;
      ctx.textAlign = right ? 'left' : 'right';
      const tx = q[0] + (right ? 18 : -18);
      ctx.lineWidth = 5; ctx.strokeStyle = c.mapbg; ctx.lineJoin = 'round';
      ctx.strokeText(s.name, tx, q[1]);
      ctx.fillStyle = c.tx; ctx.fillText(s.name, tx, q[1]);
    });

    // Positionspfeil (dreht sich mit der Fahrtrichtung); grau, wenn das GPS-Signal fehlt oder ungenau ist
    if (st.pos) {
      const q = px(st.pos.lat, st.pos.lon);
      const col = st.stale ? c.mut : c.route;
      ctx.save();
      ctx.translate(q[0], q[1]);
      ctx.beginPath(); ctx.arc(0, 0, 26, 0, 7); ctx.fillStyle = col; ctx.globalAlpha = 0.25; ctx.fill(); ctx.globalAlpha = 1;
      ctx.rotate(st.heading * Geo.D2R);
      ctx.beginPath();
      ctx.moveTo(0, -20); ctx.lineTo(14, 16); ctx.lineTo(0, 8); ctx.lineTo(-14, 16); ctx.closePath();
      ctx.fillStyle = st.stale ? c.done : c.tx; ctx.fill(); ctx.lineWidth = 3; ctx.strokeStyle = col; ctx.lineJoin = 'round'; ctx.stroke();
      ctx.restore();
    }

    // Maßstab
    const steps = [100, 200, 500, 1000, 2000, 5000, 10000]; // Meter, Beschriftung nur in km
    let len = steps[0];
    for (const m of steps) if (m * v.ppm <= w * 0.3) len = m;
    const bx = 16, by = h - 22, bw = len * v.ppm;
    ctx.beginPath(); ctx.moveTo(bx, by - 8); ctx.lineTo(bx, by); ctx.lineTo(bx + bw, by); ctx.lineTo(bx + bw, by - 8);
    ctx.lineWidth = 8; ctx.strokeStyle = c.mapbg; ctx.stroke();
    ctx.lineWidth = 3; ctx.strokeStyle = c.tx; ctx.stroke();
    ctx.font = '700 18px system-ui, "Segoe UI", Roboto, sans-serif';
    ctx.textAlign = 'left'; ctx.textBaseline = 'bottom';
    const label = (len / 1000).toFixed(1).replace('.', ',') + ' km';
    ctx.lineWidth = 5; ctx.strokeStyle = c.mapbg; ctx.strokeText(label, bx, by - 12);
    ctx.fillStyle = c.tx; ctx.fillText(label, bx, by - 12);

    // Norden
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.font = '700 20px system-ui, sans-serif';
    ctx.fillStyle = c.tx; ctx.fillText('N', w - 28, 44);
    ctx.beginPath(); ctx.moveTo(w - 28, 12); ctx.lineTo(w - 20, 30); ctx.lineTo(w - 36, 30); ctx.closePath(); ctx.fill();
  }

  function resize() {
    const r = canvas.getBoundingClientRect();
    st.dpr = window.devicePixelRatio || 1;
    st.w = r.width; st.h = r.height;
    canvas.width = Math.round(r.width * st.dpr);
    canvas.height = Math.round(r.height * st.dpr);
    draw();
  }
  new ResizeObserver(resize).observe(canvas);

  // ---------- Gesten ----------
  // Der Browser soll auf der Karte nichts selbst tun (kein Scrollen, kein Zoomen der Seite)
  canvas.style.touchAction = 'none';
  canvas.addEventListener('contextmenu', e => e.preventDefault());
  const ptrs = new Map();
  let prev = null;          // letzter Stand der Geste: { n, mid, dist }
  let travelled = 0;        // zurückgelegte Pixel seit Beginn, damit ein Antippen "Folgen" nicht ausschaltet

  function local(e) { const r = canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }
  function snapshot() {
    const p = [...ptrs.values()];
    if (!p.length) return null;
    if (p.length === 1) return { n: 1, mid: p[0], dist: 0 };
    const a = p[0], b = p[1];
    return { n: 2, mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, dist: Math.hypot(a.x - b.x, a.y - b.y) };
  }
  // Verschiebt und zoomt so, dass der Kartenpunkt unter "from" nach "to" wandert (scale > 1 = größer)
  function transform(from, to, scale) {
    detach();
    const size = Math.min(st.w, st.h);
    const v = view();
    const side2 = clampSide(size / (v.ppm * scale)), ppm2 = size / side2;
    const wx = v.cx + (from.x - st.w / 2) / v.ppm, wy = v.cy + (from.y - st.h / 2) / v.ppm;
    st.cx = wx - (to.x - st.w / 2) / ppm2; st.cy = wy - (to.y - st.h / 2) / ppm2;
    st.side = side2;
    draw();
  }

  canvas.addEventListener('pointerdown', e => {
    if (!st.route) return;
    try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* ignorieren */ }
    if (!ptrs.size) travelled = 0;
    ptrs.set(e.pointerId, local(e));
    prev = snapshot();
  });
  canvas.addEventListener('pointermove', e => {
    if (!ptrs.has(e.pointerId)) return;
    ptrs.set(e.pointerId, local(e));
    const cur = snapshot();
    if (prev && cur && prev.n === cur.n) {
      travelled += Math.hypot(cur.mid.x - prev.mid.x, cur.mid.y - prev.mid.y) + (cur.n === 2 ? Math.abs(cur.dist - prev.dist) : 0);
      if (travelled > 8) transform(prev.mid, cur.mid, cur.n === 2 && prev.dist > 0 ? cur.dist / prev.dist : 1);
      else cur.mid = prev.mid;   // unter der Schwelle noch nichts bewegen
    }
    prev = cur;
  });
  const lift = e => {
    if (!ptrs.delete(e.pointerId)) return;
    prev = snapshot();
  };
  canvas.addEventListener('pointerup', lift);
  canvas.addEventListener('pointercancel', lift);
  canvas.addEventListener('wheel', e => {
    if (!st.route) return;
    e.preventDefault();
    const p = local(e);
    transform(p, p, Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0015)));
  }, { passive: false });

  // ---------- Schnittstelle ----------
  function stepSide(dir) {
    if (dir < 0) { for (let i = SIDES.length - 1; i >= 0; i--) if (SIDES[i] < st.side * 0.97) return SIDES[i]; return SIDES[0]; }
    for (const s of SIDES) if (s > st.side * 1.03) return s;
    return SIDES[SIDES.length - 1];
  }
  function zoomStep(dir) {
    if (st.overview) { st.overview = false; st.follow = true; st.side = st.lastFollowSide; }
    st.side = stepSide(dir);
    if (st.follow) st.lastFollowSide = st.side;
    changed(); draw();
  }

  const api = {
    state: st,
    redraw: draw,
    onViewChange: null,
    setRoute(r) { st.route = r; st.s = 0; draw(); },
    setPosition(pos, heading, s) { st.pos = pos; st.heading = heading; st.s = s; draw(); },
    setStale(v) { if (st.stale !== v) { st.stale = v; draw(); } },
    zoomIn() { zoomStep(-1); },
    zoomOut() { zoomStep(1); },
    showAll() {
      if (st.follow && !st.overview) st.lastFollowSide = st.side;
      st.overview = true; st.follow = false; changed(); draw();
    },
    setFollow() {
      if (st.overview) st.side = st.lastFollowSide;
      else if (!st.follow) st.side = Math.min(st.side, FOLLOW_MAX);
      st.follow = true; st.overview = false; changed(); draw();
    },
    isFollowing() { return st.follow && !st.overview; },
    sideMeters() { return st.side; }
  };
  return api;
}
