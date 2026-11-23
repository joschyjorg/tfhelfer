'use strict';
// Route aus network.json bauen: Graph aus Abschnitten, kürzester Weg nach Länge,
// Projektion einer Position auf die Linie der Route.
const Route = (() => {
  function buildGraph(net) {
    const adj = {};
    for (const st of net.stations) adj[st.ril100] = [];
    for (const sg of net.segments) {
      const len = sg.length_km * 1000;
      if (!adj[sg.from] || !adj[sg.to]) continue;
      // Abschnitte sind in beide Richtungen befahrbar: Geometrie von from nach to, rückwärts umgekehrt
      adj[sg.from].push({ to: sg.to, len, id: sg.id, pts: sg.geometry });
      adj[sg.to].push({ to: sg.from, len, id: sg.id, pts: sg.geometry.slice().reverse() });
    }
    return adj;
  }

  // Dijkstra. b = null: Abstände von a zu allen Knoten.
  function dijkstra(adj, a, b) {
    const dist = {}, prev = {}, done = {};
    for (const k in adj) dist[k] = Infinity;
    dist[a] = 0;
    for (;;) {
      let u = null;
      for (const k in dist) if (!done[k] && (u === null || dist[k] < dist[u])) u = k;
      if (u === null || dist[u] === Infinity || u === b) break;
      done[u] = true;
      for (const e of adj[u]) {
        const nd = dist[u] + e.len;
        if (nd < dist[e.to]) { dist[e.to] = nd; prev[e.to] = { from: u, edge: e }; }
      }
    }
    if (b === null) return { dist };
    if (dist[b] === Infinity) return null;
    const edges = [];
    for (let c = b; c !== a;) { const p = prev[c]; edges.unshift(p.edge); c = p.from; }
    return { edges, dist };
  }

  // Ergebnis: { pts, cum, total, stations:[{ril100,name,typ,idx,s,lat,lon}] } oder { error }
  function build(net, startId, zielId, viaIds) {
    if (!startId || !zielId) return { error: 'missing' };
    if (startId === zielId) return { error: 'same' };
    const adj = buildGraph(net);
    const byId = {};
    net.stations.forEach(s => { byId[s.ril100] = s; });
    const fromStart = dijkstra(adj, startId, null).dist;
    const via = [...new Set(viaIds || [])]
      .filter(v => v !== startId && v !== zielId && byId[v] && fromStart[v] < Infinity)
      .sort((x, y) => fromStart[x] - fromStart[y]);
    const way = [startId, ...via, zielId];
    const edges = [];
    for (let i = 0; i < way.length - 1; i++) {
      const leg = dijkstra(adj, way[i], way[i + 1]);
      if (!leg) return { error: 'nopath' };
      edges.push(...leg.edges);
    }
    const pts = [];
    const nodes = [{ id: startId, idx: 0 }];
    edges.forEach((e, i) => {
      e.pts.forEach((p, j) => { if (!(i > 0 && j === 0)) pts.push(p); });
      nodes.push({ id: e.to, idx: pts.length - 1 });
    });
    const cum = [0];
    for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Geo.dist(pts[i - 1], pts[i]));
    // Betriebsstellen: Stoßpunkte der Abschnitte = auf die Linie projizierte Stationen
    const stations = nodes.map(n => ({
      ril100: n.id, name: byId[n.id].name, typ: byId[n.id].typ,
      idx: n.idx, s: cum[n.idx], lat: pts[n.idx][0], lon: pts[n.idx][1]
    }));
    return { pts, cum, total: cum[cum.length - 1], stations, startId, zielId, via };
  }

  // Position auf die Route projizieren. hintS: letzte bekannte Stelle (für Mehrdeutigkeit).
  // win = { from, to } (Meter entlang der Route): nur Abschnitte in diesem Fenster werden betrachtet.
  // Damit springt die Position nicht auf einen benachbarten Streckenteil, der nur räumlich nahe liegt.
  function project(route, lat, lon, hintS, win) {
    const k = Math.cos(lat * Geo.D2R), M = Geo.M;
    let best = null;
    for (let i = 0; i < route.pts.length - 1; i++) {
      if (win && (route.cum[i + 1] < win.from || route.cum[i] > win.to)) continue;
      const a = route.pts[i], b = route.pts[i + 1];
      const ax = (a[1] - lon) * M * k, ay = (a[0] - lat) * M;
      const bx = (b[1] - lon) * M * k, by = (b[0] - lat) * M;
      const dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy;
      let t = L > 0 ? (-ax * dx - ay * dy) / L : 0;
      t = Math.max(0, Math.min(1, t));
      const d = Math.hypot(ax + t * dx, ay + t * dy);
      const s = route.cum[i] + t * (route.cum[i + 1] - route.cum[i]);
      // Bei (fast) gleichem Abstand (Route läuft über dieselbe Linie zurück) gilt die Stelle nahe der letzten Position
      const better = !best || d < best.off - 3 ||
        (Math.abs(d - best.off) <= 3 && hintS != null && Math.abs(s - hintS) < Math.abs(best.s - hintS));
      if (better) best = { off: d, s, i, t, lat: a[0] + t * (b[0] - a[0]), lon: a[1] + t * (b[1] - a[1]), bearing: Geo.bearing(a, b) };
    }
    return best;
  }

  // Punkt bei Strecke s (Meter ab Start der Route)
  function pointAt(route, s) {
    s = Math.max(0, Math.min(route.total, s));
    let i = 0;
    while (i < route.pts.length - 2 && route.cum[i + 1] < s) i++;
    const a = route.pts[i], b = route.pts[i + 1];
    const seg = route.cum[i + 1] - route.cum[i];
    const t = seg > 0 ? (s - route.cum[i]) / seg : 0;
    return { lat: a[0] + t * (b[0] - a[0]), lon: a[1] + t * (b[1] - a[1]), bearing: Geo.bearing(a, b), i };
  }

  return { build, project, pointAt };
})();
