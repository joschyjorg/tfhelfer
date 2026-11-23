'use strict';
// Karte auf Canvas: Norden immer oben, Strecke, Betriebsstellen, Positionspfeil, Maßstab.
function createMap(canvas, getColors) {
  const ctx = canvas.getContext('2d');
  const SIDES = [500, 1000, 2000, 4000, 8000, 16000]; // Seitenlänge des Kartenquadrats in Metern
  const st = { route: null, pos: null, heading: 0, s: 0, zoom: 3, overview: false, w: 0, h: 0, dpr: 1 };

  function origin() { return st.route.pts[0]; }
  function xy(lat, lon) {
    const o = origin(), M = Geo.M;
    return [(lon - o[1]) * M * Math.cos(o[0] * Geo.D2R), (o[0] - lat) * M];
  }

  function view() {
    const size = Math.min(st.w, st.h);
    if (st.overview || !st.pos) {
      let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
      for (const p of st.route.pts) {
        const q = xy(p[0], p[1]);
        x0 = Math.min(x0, q[0]); x1 = Math.max(x1, q[0]); y0 = Math.min(y0, q[1]); y1 = Math.max(y1, q[1]);
      }
      const side = Math.max(x1 - x0, y1 - y0, 500) * 1.3;
      return { cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, ppm: size / side };
    }
    const c = xy(st.pos.lat, st.pos.lon);
    return { cx: c[0], cy: c[1], ppm: size / SIDES[st.zoom] };
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

    // Positionspfeil (dreht sich mit der Fahrtrichtung)
    if (st.pos) {
      const q = px(st.pos.lat, st.pos.lon);
      ctx.save();
      ctx.translate(q[0], q[1]);
      ctx.beginPath(); ctx.arc(0, 0, 26, 0, 7); ctx.fillStyle = c.route; ctx.globalAlpha = 0.25; ctx.fill(); ctx.globalAlpha = 1;
      ctx.rotate(st.heading * Geo.D2R);
      ctx.beginPath();
      ctx.moveTo(0, -20); ctx.lineTo(14, 16); ctx.lineTo(0, 8); ctx.lineTo(-14, 16); ctx.closePath();
      ctx.fillStyle = c.tx; ctx.fill(); ctx.lineWidth = 3; ctx.strokeStyle = c.route; ctx.lineJoin = 'round'; ctx.stroke();
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

  return {
    state: st,
    redraw: draw,
    setRoute(r) { st.route = r; st.s = 0; draw(); },
    setPosition(pos, heading, s) { st.pos = pos; st.heading = heading; st.s = s; draw(); },
    zoomIn() { st.overview = false; st.zoom = Math.max(0, st.zoom - 1); draw(); },
    zoomOut() { st.overview = false; st.zoom = Math.min(SIDES.length - 1, st.zoom + 1); draw(); },
    toggleOverview() { st.overview = !st.overview; draw(); return st.overview; },
    setOverview(v) { st.overview = v; draw(); },
    sideMeters() { return SIDES[st.zoom]; }
  };
}
