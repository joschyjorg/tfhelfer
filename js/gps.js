'use strict';
// GPS-Quelle: Geolocation des Browsers. Sie kennt nur zwei Rückrufe, genau wie die Simulation:
//   onFix({ lat, lon, acc, speed, heading })   acc in Metern, speed in m/s (oder null), heading in Grad (oder null)
//   onError({ code })                          code: 'denied' | 'unavailable' | 'timeout' | 'unsupported'
// getGeolocation lässt sich austauschen (Tests mit eigenen Werten), sonst gilt navigator.geolocation.
function createGps(opts) {
  const g = { running: false, watchId: null, geo: null };

  function api() {
    if (opts.getGeolocation) return opts.getGeolocation();
    return typeof navigator !== 'undefined' && navigator.geolocation ? navigator.geolocation : null;
  }
  const num = v => (typeof v === 'number' && isFinite(v) ? v : null);

  function ok(pos) {
    const c = pos.coords;
    opts.onFix({ lat: c.latitude, lon: c.longitude, acc: num(c.accuracy), speed: num(c.speed), heading: num(c.heading) });
  }
  function fail(err) {
    // PositionError: 1 = Zugriff verweigert, 2 = nicht verfügbar, 3 = Zeitüberschreitung
    const code = err && err.code === 1 ? 'denied' : err && err.code === 3 ? 'timeout' : 'unavailable';
    if (code === 'denied') g.stop();      // ohne Erlaubnis gibt es nichts zu beobachten
    opts.onError({ code });
  }

  g.supported = () => !!api();
  // Für Tests: eigene "Geolocation" mit vorgegebenen Werten einsetzen
  g.useGeolocation = geo => { opts.getGeolocation = () => geo; };

  g.start = function () {
    if (g.running) return true;
    const geo = api();
    if (!geo) { opts.onError({ code: 'unsupported' }); return false; }
    g.geo = geo;
    g.running = true;
    try {
      g.watchId = geo.watchPosition(ok, fail, { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 });
    } catch (e) {
      g.running = false;
      opts.onError({ code: 'unsupported' });
      return false;
    }
    return true;
  };

  g.stop = function () {
    if (g.geo && g.watchId != null) { try { g.geo.clearWatch(g.watchId); } catch (e) { /* ignorieren */ } }
    g.watchId = null;
    g.running = false;
  };

  return g;
}
