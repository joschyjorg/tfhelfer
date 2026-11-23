'use strict';
// Geometrie-Hilfsfunktionen. Punkte sind immer [lat, lon].
const Geo = (() => {
  const R = 6371000, D2R = Math.PI / 180;
  const M = R * D2R; // Meter pro Grad Breite (auch pro Grad Länge am Äquator)

  function dist(a, b) {
    const dl = (b[0] - a[0]) * D2R, dn = (b[1] - a[1]) * D2R;
    const h = Math.sin(dl / 2) ** 2 + Math.cos(a[0] * D2R) * Math.cos(b[0] * D2R) * Math.sin(dn / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }

  // Richtung von a nach b in Grad, 0 = Norden, im Uhrzeigersinn
  function bearing(a, b) {
    const k = Math.cos(a[0] * D2R);
    const dx = (b[1] - a[1]) * M * k, dy = (b[0] - a[0]) * M;
    return (Math.atan2(dx, dy) / D2R + 360) % 360;
  }

  // Punkt p um "meters" in Richtung bearingDeg verschieben
  function offset(p, bearingDeg, meters) {
    const b = bearingDeg * D2R;
    return [p[0] + Math.cos(b) * meters / M, p[1] + Math.sin(b) * meters / (M * Math.cos(p[0] * D2R))];
  }

  return { dist, bearing, offset, M, D2R };
})();
