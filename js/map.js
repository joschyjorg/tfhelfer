'use strict';
// Karte auf Canvas: Norden immer oben, Hintergrundkarte (Natural Earth), Strecke, Betriebsstellen, Positionspfeil, Maßstab.
// Bedienung: ein Finger (oder Maus) verschiebt, zwei Finger zoomen (Pinch), Mausrad zoomt.
// Jede Geste schaltet "Folgen" aus. setFollow() bringt die Karte zurück zur Position.
function createMap(canvas, getColors) {
  const ctx = canvas.getContext('2d');
  // Stufen der Tasten + und −: Seitenlänge des Kartenquadrats in Metern. Die letzte Stufe zeigt ganz Deutschland.
  const SIDES = [500, 1000, 2000, 4000, 8000, 16000, 32000, 64000, 128000, 256000, 512000, 1024000];
  const SIDE_MIN = 250;        // stärkstes Heranzoomen (Pinch und Mausrad)
  const SIDE_MAX = 1200000;    // kleinster Maßstab beim Pinch und Mausrad: ganz Deutschland (ca. 870 km hoch) passt auf den Schirm
  const FOLLOW_MAX = 16000;    // größter Ausschnitt, in den "Folgen" zurückkehrt
  const st = {
    route: null, pos: null, heading: 0, s: 0, stale: false,
    side: SIDES[3], lastFollowSide: SIDES[3],
    follow: true, overview: false, cx: 0, cy: 0,   // cx, cy: Kartenmitte (Meter), nur wenn nicht gefolgt wird
    bgData: null, bgOn: true, bg: null, moving: false, focus: 0,
    w: 0, h: 0, dpr: 1
  };
  const clampSide = (v, max) => Math.max(SIDE_MIN, Math.min(max == null ? SIDE_MAX : max, v));
  const changed = () => { if (api.onViewChange) api.onViewChange(); };

  function origin() { return st.route.pts[0]; }
  function xy(lat, lon) {
    const o = origin(), M = Geo.M;
    return [(lon - o[1]) * M * Math.cos(o[0] * Geo.D2R), (o[0] - lat) * M];
  }

  // "Gesamte Strecke": passt sich jeder Route an, ohne Begrenzung durch den kleinsten Maßstab
  function fit() {
    const size = Math.min(st.w, st.h);
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const p of st.route.pts) {
      const q = xy(p[0], p[1]);
      x0 = Math.min(x0, q[0]); x1 = Math.max(x1, q[0]); y0 = Math.min(y0, q[1]); y1 = Math.max(y1, q[1]);
    }
    const side = Math.max(x1 - x0, y1 - y0, 500) * 1.3; // 15 % Rand auf jeder Seite
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
    st.cx = v.cx; st.cy = v.cy; st.side = Math.max(SIDE_MIN, size / v.ppm); // keine obere Grenze: die Gesamtansicht bleibt wie sie ist
    st.follow = false; st.overview = false;
    changed();
  }

  // ---------- Hintergrundkarte ----------
  // Rohdaten (Grad, ganze Zahlen in 0,001 Grad, Linien als Differenzen) in Meter der Karte umrechnen. Einmal je Route.
  function projectBackground() {
    st.bg = null;
    if (!st.route || !st.bgData) return;
    const d = st.bgData, E = d.einheit || 0.001, o = origin(), M = Geo.M, k = Math.cos(o[0] * Geo.D2R);
    const X = lon => (lon - o[1]) * M * k, Y = lat => (o[0] - lat) * M;
    const lines = list => (list || []).map(flat => {
      const n = flat.length / 2, a = new Float32Array(n * 2);
      let lon = 0, lat = 0, minx = Infinity, maxx = -Infinity, miny = Infinity, maxy = -Infinity;
      for (let i = 0; i < n; i++) {
        lon += flat[2 * i]; lat += flat[2 * i + 1];
        const x = X(lon * E), y = Y(lat * E);
        a[2 * i] = x; a[2 * i + 1] = y;
        if (x < minx) minx = x; if (x > maxx) maxx = x; if (y < miny) miny = y; if (y > maxy) maxy = y;
      }
      return { a, minx, maxx, miny, maxy };
    });
    st.bg = {
      nachbarn: lines(d.nachbarn), deutschland: lines(d.deutschland), laender: lines(d.laender),
      kueste: lines(d.kueste), fluesse: lines(d.fluesse), seen: lines(d.seen),
      staedte: (d.staedte || []).map(s => ({ name: s[0], x: X(s[1] * E), y: Y(s[2] * E), tier: s[3], de: s[4] === 'DEU' }))
    };
  }

  const hex = c => {
    c = String(c).trim();
    if (c[0] !== '#') return null;
    if (c.length === 4) c = '#' + c[1] + c[1] + c[2] + c[2] + c[3] + c[3];
    return [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16)];
  };
  // Farbe zwischen a und b (t = 0 ... 1). So bleiben die Hintergrundlinien in jedem Thema blass und decken sich nicht auf.
  const mix = (a, b, t) => {
    const A = hex(a), B = hex(b);
    return !A || !B ? b : 'rgb(' + A.map((v, i) => Math.round(v + (B[i] - v) * t)).join(',') + ')';
  };

  // avoid: Rechtecke, die frei bleiben sollen (Betriebsstellen, Pfeil). Nur Beschriftungen von Städten weichen aus.
  function drawBackground(c, v, w, h, avoid) {
    const bg = st.bg;
    if (!bg || !st.bgOn) return;
    const size = Math.min(w, h), side = size / v.ppm, fast = st.moving;
    const x0 = v.cx - w / 2 / v.ppm, x1 = v.cx + w / 2 / v.ppm, y0 = v.cy - h / 2 / v.ppm, y1 = v.cy + h / 2 / v.ppm;
    const minStep = fast ? 4 : 1.5;   // Punkte, die weniger als so viele Pixel auseinander liegen, werden übersprungen
    const lineCol = (t) => mix(c.mapbg, c.tx, t);
    const strokeLines = (lines, color, width) => {
      ctx.beginPath();
      for (const L of lines) {
        if (L.maxx < x0 || L.minx > x1 || L.maxy < y0 || L.miny > y1) continue;
        const a = L.a, n = a.length;
        let lx = w / 2 + (a[0] - v.cx) * v.ppm, ly = h / 2 + (a[1] - v.cy) * v.ppm;
        ctx.moveTo(lx, ly);
        for (let i = 2; i < n; i += 2) {
          const px = w / 2 + (a[i] - v.cx) * v.ppm, py = h / 2 + (a[i + 1] - v.cy) * v.ppm;
          if (i < n - 2 && Math.abs(px - lx) + Math.abs(py - ly) < minStep) continue;
          ctx.lineTo(px, py); lx = px; ly = py;
        }
      }
      ctx.strokeStyle = color; ctx.lineWidth = width; ctx.lineJoin = 'round'; ctx.lineCap = 'round'; ctx.stroke();
    };
    const water = mix(c.mapbg, c.route, 0.38);
    if (!fast) {
      strokeLines(bg.nachbarn, lineCol(0.16), 1);
      strokeLines(bg.fluesse, water, 1);
      strokeLines(bg.seen, water, 1.2);
    }
    strokeLines(bg.laender, lineCol(0.2), 1);
    strokeLines(bg.kueste, lineCol(0.34), 1.3);
    strokeLines(bg.deutschland, lineCol(0.36), 1.6);

    // Städte: auf kleinem Maßstab nur die großen, auf großem mehr. Beschriftungen weichen Betriebsstellen aus.
    if (fast) return;
    const maxTier = side <= 150000 ? 2 : side <= 450000 ? 1 : 0;
    ctx.font = '600 14px system-ui, "Segoe UI", Roboto, sans-serif';
    ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    for (const s of bg.staedte) {
      if (s.tier > maxTier) continue;
      const px = w / 2 + (s.x - v.cx) * v.ppm, py = h / 2 + (s.y - v.cy) * v.ppm;
      if (px < 4 || px > w - 4 || py < 4 || py > h - 4) continue;
      const tw = ctx.measureText(s.name).width;
      const r = { x0: px - 5, x1: px + 9 + tw, y0: py - 9, y1: py + 9 };
      if (avoid.some(a => r.x0 < a.x1 && r.x1 > a.x0 && r.y0 < a.y1 && r.y1 > a.y0)) continue;
      avoid.push(r);
      const col = mix(c.mapbg, c.tx, s.de ? 0.55 : 0.42);
      ctx.beginPath(); ctx.arc(px, py, 3, 0, 7); ctx.fillStyle = col; ctx.fill();
      ctx.lineWidth = 4; ctx.strokeStyle = c.mapbg; ctx.lineJoin = 'round'; ctx.strokeText(s.name, px + 7, py);
      ctx.fillStyle = col; ctx.fillText(s.name, px + 7, py);
    }
  }

  // ---------- Beschriftung der Betriebsstellen ----------
  // Wichtigkeit: Start, Ziel, nächste und übernächste Betriebsstelle immer (0), dann Bf (1), Hp (2), alles andere (3).
  // Jede Beschriftung probiert rechts, links, oben, unten und wird nur gezeigt, wenn ihr Rahmen keine schon gesetzte
  // Beschriftung, keinen Stationspunkt, den Pfeil und keine Bedienelemente der Karte berührt. Übrige bleiben Punkte
  // und bekommen ihre Beschriftung beim Hineinzoomen. Die Städtenamen des Hintergrunds weichen den Beschriftungen aus.
  const PRIO_TYP = { Bf: 1, Hp: 2 };
  const LABEL_H = 26, DOT_R = 11, GAP = 3;
  const hit = (a, b, pad) => a.x0 - pad < b.x1 && a.x1 + pad > b.x0 && a.y0 - pad < b.y1 && a.y1 + pad > b.y0;

  function controlRects() {
    const out = [];
    const host = canvas.parentElement, cr = canvas.getBoundingClientRect();
    if (!host) return out;
    host.querySelectorAll('.mapctl, .gpsstat:not(.hide), .simpanel:not(.hide)').forEach(e => {
      const r = e.getBoundingClientRect();
      if (r.width) out.push({ x0: r.left - cr.left, y0: r.top - cr.top, x1: r.right - cr.left, y1: r.bottom - cr.top });
    });
    return out;
  }

  function planLabels(route, px, w, h) {
    ctx.font = '700 20px system-ui, "Segoe UI", Roboto, sans-serif';
    const n = route.stations.length, f = st.focus || 0;
    const items = route.stations.map((s, i) => {
      const q = px(s.lat, s.lon);
      const inside = q[0] > -20 && q[0] < w + 20 && q[1] > -20 && q[1] < h + 20;
      return { s, i, q, inside, tw: inside ? ctx.measureText(s.name).width : 0, label: null };
    });
    const dots = items.filter(it => it.inside).map(it => ({ it, r: { x0: it.q[0] - DOT_R, x1: it.q[0] + DOT_R, y0: it.q[1] - DOT_R, y1: it.q[1] + DOT_R } }));
    const fixed = controlRects();
    if (st.pos) { const q = px(st.pos.lat, st.pos.lon); fixed.push({ x0: q[0] - 30, x1: q[0] + 30, y0: q[1] - 30, y1: q[1] + 30 }); }
    const prio = it => (it.i === 0 || it.i === n - 1 || it.i === f || it.i === f + 1) ? 0 : (PRIO_TYP[it.s.typ] || 3);
    const order = items.filter(it => it.inside).sort((a, b) => prio(a) - prio(b) || Math.abs(a.i - f) - Math.abs(b.i - f));
    const placed = [];
    for (const it of order) {
      const x = it.q[0], y = it.q[1], tw = it.tw;
      const cands = [
        { pos: 'right', r: { x0: x + 14, x1: x + 14 + tw, y0: y - LABEL_H / 2, y1: y + LABEL_H / 2 } },
        { pos: 'left', r: { x0: x - 14 - tw, x1: x - 14, y0: y - LABEL_H / 2, y1: y + LABEL_H / 2 } },
        { pos: 'top', r: { x0: x - tw / 2, x1: x + tw / 2, y0: y - 14 - LABEL_H, y1: y - 14 } },
        { pos: 'bottom', r: { x0: x - tw / 2, x1: x + tw / 2, y0: y + 14, y1: y + 14 + LABEL_H } }
      ];
      const free = r => r.x0 >= 2 && r.x1 <= w - 2 && r.y0 >= 2 && r.y1 <= h - 2 &&
        !placed.some(p => hit(r, p, GAP)) && !fixed.some(p => hit(r, p, 2)) && !dots.some(d => d.it !== it && hit(r, d.r, 1));
      let best = cands.find(cd => free(cd.r));
      if (!best && prio(it) === 0) {
        // Wichtige Stationen bekommen immer eine Beschriftung: die Stelle mit der kleinsten Überdeckung
        // Rahmen erst in den sichtbaren Bereich schieben, dann die Stelle mit der kleinsten Überdeckung nehmen
        const inside = r => {
          const dx = r.x0 < 2 ? 2 - r.x0 : (r.x1 > w - 2 ? (w - 2) - r.x1 : 0);
          const dy = r.y0 < 2 ? 2 - r.y0 : (r.y1 > h - 2 ? (h - 2) - r.y1 : 0);
          return { x0: r.x0 + dx, x1: r.x1 + dx, y0: r.y0 + dy, y1: r.y1 + dy };
        };
        const cost = r => placed.concat(fixed).reduce((s, p) => s + (hit(r, p, 0) ? Math.min(r.x1, p.x1) - Math.max(r.x0, p.x0) : 0), 0);
        const moved = cands.map(cd => ({ pos: cd.pos, r: inside(cd.r) }));
        best = moved.sort((a, b) => cost(a.r) - cost(b.r))[0];
      }
      if (best) { it.label = best; placed.push(best.r); }
    }
    const obst = dots.map(d => d.r).concat(fixed);
    return { items, placed, obst };
  }

  // ---------- Zeichnen ----------
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

    // Beschriftung planen; die Hintergrundkarte (Städte) weicht Beschriftungen, Punkten und Pfeil aus
    const plan = planLabels(route, px, w, h);
    const avoid = plan.obst.concat(plan.placed.map(r => ({ x0: r.x0 - 4, x1: r.x1 + 4, y0: r.y0 - 4, y1: r.y1 + 4 })));

    drawBackground(c, v, w, h, avoid);

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

    // Betriebsstellen: Punkte immer, Namen nur wo Platz ist
    ctx.font = '700 20px system-ui, "Segoe UI", Roboto, sans-serif';
    ctx.textBaseline = 'middle';
    for (const it of plan.items) {
      if (!it.inside) continue;
      ctx.beginPath(); ctx.arc(it.q[0], it.q[1], 9, 0, 7);
      ctx.fillStyle = c.panel; ctx.fill(); ctx.lineWidth = 4; ctx.strokeStyle = c.tx; ctx.stroke();
    }
    for (const it of plan.items) {
      if (!it.label) continue;
      const r = it.label.r, pos = it.label.pos, cy = (r.y0 + r.y1) / 2;
      ctx.textAlign = pos === 'right' ? 'left' : pos === 'left' ? 'right' : 'center';
      const tx = pos === 'right' ? r.x0 : pos === 'left' ? r.x1 : (r.x0 + r.x1) / 2;
      ctx.lineWidth = 5; ctx.strokeStyle = c.mapbg; ctx.lineJoin = 'round';
      ctx.strokeText(it.s.name, tx, cy);
      ctx.fillStyle = c.tx; ctx.fillText(it.s.name, tx, cy);
    }

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

    // Maßstab (Beschriftung nur in km, eine Nachkommastelle)
    const steps = [100, 200, 500, 1000, 2000, 5000, 10000, 20000, 50000, 100000, 200000, 500000];
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

  // Mehrere Änderungen kurz hintereinander (Geste, GPS-Werte) ergeben nur ein Zeichnen pro Bild
  let raf = 0;
  function scheduleDraw() {
    if (raf) return;
    raf = requestAnimationFrame(() => { raf = 0; draw(); });
  }
  // Während einer Geste einfacher zeichnen (weniger Schichten, keine Städte); danach einmal vollständig
  let settle = 0;
  function gestureDraw() {
    st.moving = true;
    scheduleDraw();
    clearTimeout(settle);
    settle = setTimeout(() => { st.moving = false; scheduleDraw(); }, 160);
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
    // Wer aus einer sehr großen Gesamtansicht kommt, wird beim Verkleinern nicht auf SIDE_MAX zurückgeworfen
    const side2 = clampSide(size / (v.ppm * scale), Math.max(SIDE_MAX, st.side)), ppm2 = size / side2;
    const wx = v.cx + (from.x - st.w / 2) / v.ppm, wy = v.cy + (from.y - st.h / 2) / v.ppm;
    st.cx = wx - (to.x - st.w / 2) / ppm2; st.cy = wy - (to.y - st.h / 2) / ppm2;
    st.side = side2;
    gestureDraw();
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
    return st.side;     // schon am kleinsten Maßstab (oder größer): nichts tun
  }
  function zoomStep(dir) {
    if (st.overview) detach();   // von der Gesamtansicht aus weiterzoomen, nicht zurück zum Folgen springen
    st.side = stepSide(dir);
    if (st.follow) st.lastFollowSide = st.side;
    changed(); draw();
  }

  const api = {
    state: st,
    redraw: draw,
    onViewChange: null,
    setRoute(r) { st.route = r; st.s = 0; projectBackground(); draw(); },
    setBackground(data) { st.bgData = data; projectBackground(); draw(); },
    setBackgroundVisible(on) { st.bgOn = !!on; draw(); },
    setPosition(pos, heading, s) { st.pos = pos; st.heading = heading; st.s = s; scheduleDraw(); },
    setFocus(i) { if (st.focus !== i) { st.focus = i; scheduleDraw(); } },
    setStale(v) { if (st.stale !== v) { st.stale = v; scheduleDraw(); } },
    zoomIn() { zoomStep(-1); },
    zoomOut() { zoomStep(1); },
    showAll() {
      if (st.follow && !st.overview) st.lastFollowSide = st.side;
      st.overview = true; st.follow = false; changed(); draw();
    },
    setFollow() {
      if (st.overview) st.side = st.lastFollowSide;
      else if (!st.follow) st.side = st.side > FOLLOW_MAX ? st.lastFollowSide : st.side;
      st.follow = true; st.overview = false; changed(); draw();
    },
    isFollowing() { return st.follow && !st.overview; },
    sideMeters() { return view().ppm ? Math.min(st.w, st.h) / view().ppm : st.side; }
  };
  return api;
}
