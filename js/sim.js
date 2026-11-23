'use strict';
// Simulation der Fahrt. Sie kennt nur die Route und ruft onPosition(lat, lon) auf,
// genau so, wie später das GPS es tun wird.
function createSim(getRoute, onPosition, onEnd) {
  const sim = { playing: false, s: 0, speedKmh: 80, factor: 30, offset: 0, last: null };

  sim.emit = function () {
    const r = getRoute();
    if (!r) return;
    const pt = Route.pointAt(r, sim.s);
    let p = [pt.lat, pt.lon];
    if (sim.offset) p = Geo.offset(p, pt.bearing + 90, sim.offset); // seitlicher Versatz (rechts positiv)
    // Dritter Parameter wie beim GPS: Geschwindigkeit (m/s) und Richtung (Grad)
    onPosition(p[0], p[1], { speed: sim.playing ? sim.speedKmh / 3.6 : 0, heading: pt.bearing });
  };

  sim.tick = function (nowMs) {
    const dt = sim.last == null ? 0 : Math.min(1.5, (nowMs - sim.last) / 1000);
    sim.last = nowMs;
    const r = getRoute();
    if (!sim.playing || !r) return false;
    sim.s += sim.speedKmh / 3.6 * sim.factor * dt;
    if (sim.s >= r.total) { sim.s = r.total; sim.playing = false; if (onEnd) onEnd(); }
    sim.emit();
    return true;
  };

  sim.reset = function () { sim.s = 0; sim.playing = false; sim.last = null; };
  return sim;
}
