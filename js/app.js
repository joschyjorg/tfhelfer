'use strict';
// Tf-Helfer: Hauptlogik. Alles hängt an EINER Funktion: onFix(wert, quelle).
// Die Simulation (Testmodus) und das GPS (js/gps.js) rufen sie auf; immer ist nur eine Quelle aktiv.

// Das Netz (OSM-Daten) liegt bei der App. Persönliche Daten gibt es NUR auf dem Gerät (IndexedDB, siehe storage.js)
// und kommen per "Laden" dorthin: nie vom Server.
const DATA = { network: 'network.json' };
const OFF_ROUTE_M = 300;

const $ = id => document.getElementById(id);
const store = {
  get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* ohne Speicher weiterarbeiten */ } }
};
const state = {
  passed: 0, net: null, personal: {}, route: null, sel: null, pos: null, proj: null, heading: 0, lastS: 0,
  source: 'none',        // aktive Positionsquelle: 'none' | 'gps' | 'sim' (nie mehr als eine)
  fix: null,             // letzter Wert der Quelle { lat, lon, acc, speed, heading, at }
  hasLock: false,        // gibt es schon eine auf die Strecke bezogene Position?
  lastApplyAt: 0,        // Zeitpunkt des letzten benutzten Wertes
  cand: null,            // Kandidat für "Position liegt woanders auf der Strecke"
  headingSet: false, speed: 0, q: 'off', gpsError: null
};

// Einstellungen der Positionsverarbeitung (fest im Code, nicht in den Einstellungen)
const GPS_MAX_ACC_M = 100;      // Genauigkeit schlechter als 100 m: Wert wird nicht benutzt ("GPS ungenau")
const STALE_MS = 10000;         // länger als 10 s kein neuer Wert: "Kein GPS-Signal"
const WINDOW_M = 3000;          // Suchfenster ± 3 km entlang der Strecke um die letzte bekannte Stelle
const REACQ_MS = 120000;        // nach mehr als 2 Minuten ohne Wert wird wieder auf der ganzen Strecke gesucht
const REACQ_CONFIRM_MS = 15000; // so lange muss eine ganz andere Stelle durchgehend passen, bevor die Position dorthin springt
const MIN_HEAD_SPEED = 2;       // m/s: darunter bleibt der Pfeil in der letzten Richtung
const clock = { now: () => Date.now() };   // austauschbar für Tests

// ---------- Anzeige-Hilfen ----------
// Entfernungen überall in km mit einer Nachkommastelle (auch unter 1 km: 0,9 km ... 0,0 km). Keine Meter.
function fmtDist(m) {
  return (Math.max(0, m) / 1000).toFixed(1).replace('.', ',') + ' km';
}
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

// ---------- Thema ----------
const themeBtns = document.querySelectorAll('[data-set-theme]');
function getColors() {
  const cs = getComputedStyle(document.documentElement);
  const g = n => cs.getPropertyValue(n).trim();
  return { mapbg: g('--mapbg'), route: g('--route'), done: g('--done'), tx: g('--tx'), panel: g('--panel'), mut: g('--mut') };
}
function applyTheme(t) {
  const root = document.documentElement;
  if (t === 'hell' || t === 'dunkel') root.dataset.theme = t; else { delete root.dataset.theme; t = 'auto'; }
  themeBtns.forEach(b => b.setAttribute('aria-pressed', String(b.dataset.setTheme === t)));
  store.set('tf.theme', t);
  map.redraw();
}
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => map.redraw());

// ---------- Karte und Positionsquellen ----------
// Zwei Quellen mit demselben Ausgang: Simulation (Testmodus, nur PC) und GPS. Beide rufen onFix(wert, quelle) auf.
// Ein Wert hat die Form { lat, lon, acc (m), speed (m/s oder null), heading (Grad oder null) }.
const map = createMap($('map'), getColors);
const sim = createSim(
  () => state.route,
  (lat, lon, ex) => onFix({ lat, lon, acc: 5, speed: ex ? ex.speed : 0, heading: ex ? ex.heading : null }, 'sim'),
  () => { $('simPlay').textContent = 'Start'; }
);
const gps = createGps({
  onFix: f => onFix(f, 'gps'),
  onError: e => { state.gpsError = e; updateQuality(); updateGpsUi(); }
});

// Eingang für jeden Positionswert. Nur die aktive Quelle zählt.
function onFix(fix, src) {
  if (src !== state.source) return;
  const now = clock.now();
  const prev = state.fix;
  state.fix = { lat: fix.lat, lon: fix.lon, acc: Number.isFinite(fix.acc) ? fix.acc : 0, speed: fix.speed, heading: fix.heading, at: now };
  state.gpsError = null;
  // Zu ungenaue Werte werden nicht benutzt: die Anzeige bleibt stehen und wird als "GPS ungenau" markiert
  if (state.fix.acc <= GPS_MAX_ACC_M) applyFix(state.fix, prev, now);
  updateQuality();
}

function fixSpeed(fix, prev) {
  if (Number.isFinite(fix.speed) && fix.speed >= 0) return fix.speed;
  if (prev && fix.at > prev.at) return Geo.dist([prev.lat, prev.lon], [fix.lat, fix.lon]) / ((fix.at - prev.at) / 1000);
  return 0;
}

// Wert auf die Strecke legen (Projektion), Richtung bestimmen, Anzeige aktualisieren
function applyFix(fix, prev, now) {
  const route = state.route;
  state.pos = { lat: fix.lat, lon: fix.lon };
  if (!route) return;
  // Ganze Strecke durchsuchen: beim ersten Wert und nach mehr als 2 Minuten Signalverlust. Sonst nur ein Fenster um die letzte Stelle.
  const whole = !state.hasLock || now - state.lastApplyAt > REACQ_MS;
  let pr;
  if (whole) {
    pr = Route.project(route, fix.lat, fix.lon, state.lastS);
    state.cand = null;
  } else {
    pr = Route.project(route, fix.lat, fix.lon, state.lastS, { from: state.lastS - WINDOW_M, to: state.lastS + WINDOW_M });
    if (!pr) pr = Route.project(route, fix.lat, fix.lon, state.lastS);
    if (pr.off > OFF_ROUTE_M) {
      // Im Fenster liegt die Strecke weit weg. Passt der Wert anderswo auf die Strecke, wird das nur dann
      // übernommen, wenn es durchgehend (REACQ_CONFIRM_MS) dieselbe Stelle ist. Ein einzelner Ausreißer ändert nichts.
      const g = Route.project(route, fix.lat, fix.lon, state.lastS);
      if (g.off <= OFF_ROUTE_M && Math.abs(g.s - state.lastS) > WINDOW_M) {
        if (state.cand && Math.abs(g.s - state.cand.s) < 500) {
          if (now - state.cand.since >= REACQ_CONFIRM_MS) { pr = g; state.cand = null; }
        } else state.cand = { s: g.s, since: now };
      } else state.cand = null;
      if (pr !== g) pr = Object.assign({}, pr, { s: state.lastS }); // Entfernungen bleiben bei der letzten bekannten Stelle
    } else state.cand = null;
  }
  state.proj = pr;
  state.lastS = pr.s;
  state.hasLock = true;
  state.lastApplyAt = now;
  // Richtung: nur bei Geschwindigkeit über MIN_HEAD_SPEED, sonst bleibt die letzte Richtung
  const spd = fixSpeed(fix, prev);
  state.speed = spd;
  if (spd > MIN_HEAD_SPEED) {
    if (Number.isFinite(fix.heading)) state.heading = fix.heading;
    else if (prev && Geo.dist([prev.lat, prev.lon], [fix.lat, fix.lon]) > 3) state.heading = Geo.bearing([prev.lat, prev.lon], [fix.lat, fix.lon]);
    state.headingSet = true;
  } else if (!state.headingSet) state.heading = pr.bearing; // Anfang: Richtung der Strecke
  map.setPosition(state.pos, state.heading, pr.s);
  render();
}

// Ohne Quelle (oder vor dem ersten Wert): Anzeige ab Streckenanfang, grau
function showStart() {
  const r = state.route;
  if (!r) return;
  const p = r.pts[0];
  state.pos = { lat: p[0], lon: p[1] };
  state.proj = Route.project(r, p[0], p[1], 0);
  state.lastS = state.proj.s;
  state.heading = state.proj.bearing;
  state.headingSet = false;
  map.setPosition(state.pos, state.heading, state.proj.s);
  render();
}

// Zustand des Signals: ok | bad (zu ungenau) | lost (kein neuer Wert) | wait (noch nichts) | off (keine Quelle)
function updateQuality() {
  const now = clock.now();
  let q = 'ok', text = '';
  if (state.source === 'none') { q = 'off'; text = 'GPS aus – Anzeige ab Streckenanfang'; }
  else if (state.gpsError && !state.fix) { q = 'wait'; text = 'GPS: ' + gpsErrorShort(state.gpsError.code); }
  else if (!state.fix) { q = 'wait'; text = 'Warte auf GPS-Signal …'; }
  else if (now - state.fix.at > STALE_MS) { q = 'lost'; text = 'Kein GPS-Signal seit ' + Math.round((now - state.fix.at) / 1000) + ' s'; }
  else if (state.fix.acc > GPS_MAX_ACC_M) { q = 'bad'; text = 'GPS ungenau'; }
  state.q = q;
  const sb = $('gpsStatus');
  sb.classList.toggle('hide', q === 'ok');
  sb.classList.toggle('quiet', q === 'off');
  if (sb.textContent !== text) sb.textContent = text;
  document.querySelector('.side').classList.toggle('stale', q !== 'ok');
  map.setStale(q !== 'ok');
  // "Nicht auf der Strecke" nur bei brauchbarem Signal
  const pr = state.proj;
  const off = q === 'ok' && !!pr && pr.off > OFF_ROUTE_M;
  $('offwarn').classList.toggle('hide', !off);
  if (off) $('offdist').textContent = 'Abstand zur Strecke: ' + fmtDist(pr.off);
}

function isMoving() {
  return state.source !== 'none' && !!state.fix && clock.now() - state.fix.at < STALE_MS && state.speed > MIN_HEAD_SPEED;
}

function setSource(kind) {
  if (kind === state.source) return;
  if (state.source === 'gps') gps.stop();
  if (state.source === 'sim') { sim.playing = false; $('simPlay').textContent = 'Start'; }
  state.source = kind;
  state.fix = null; state.hasLock = false; state.cand = null; state.gpsError = null; state.speed = 0;
  $('testMode').checked = kind === 'sim';
  $('simPanel').classList.toggle('hide', kind !== 'sim');
  store.set('tf.gps', kind === 'gps' ? 'on' : 'off');
  updateQuality();
  if (kind === 'gps') gps.start();
  if (kind === 'sim') sim.emit();
  updateQuality();
  updateGpsUi();
}

// ---------- GPS in Info ----------
function gpsErrorShort(code) {
  return code === 'denied' ? 'Zugriff verweigert' : code === 'timeout' ? 'Zeitüberschreitung' : code === 'unsupported' ? 'nicht unterstützt' : 'nicht verfügbar';
}
const GPS_HELP = {
  denied: 'Der Zugriff auf den Standort wurde verweigert. So erlauben Sie ihn: In Chrome auf das Symbol links neben der Adresse tippen, Berechtigungen, Standort, Zulassen. Bei der installierten App: Android-Einstellungen, Apps, Chrome, Berechtigungen, Standort, Zulassen. Danach hier „Erneut versuchen“ drücken.',
  unavailable: 'Der Standort ist nicht verfügbar. Standort (GPS) des Tablets in den Schnelleinstellungen einschalten und freie Sicht zum Himmel suchen (nicht im Gebäude). Es wird weiter versucht.',
  timeout: 'Noch kein Wert vom GPS erhalten. Freie Sicht zum Himmel? Das erste Signal kann einige Minuten dauern. Es wird weiter versucht.',
  unsupported: 'Dieses Gerät oder diese Seite erlaubt keine Standortabfrage. Die App muss über HTTPS (oder localhost) geöffnet sein.'
};
function updateGpsUi() {
  const on = state.source === 'gps';
  const stopped = on && !gps.running;   // z. B. Zugriff verweigert
  $('gpsBtn').textContent = stopped ? 'Erneut versuchen' : on ? 'GPS ausschalten' : 'GPS einschalten';
  $('gpsBtn').classList.toggle('primary', !on || stopped);
  const line = $('gpsInfo'), help = $('gpsHelp');
  let text = 'GPS ist aus.', bad = false, hint = '';
  if (state.source === 'sim') text = 'GPS ist aus. Testmodus (Simulation) ist aktiv.';
  else if (on) {
    const f = state.fix, now = clock.now();
    if (state.gpsError && !f) { text = 'GPS: ' + gpsErrorShort(state.gpsError.code) + '.'; bad = true; hint = GPS_HELP[state.gpsError.code]; }
    else if (!f) text = 'GPS eingeschaltet. Warte auf das erste Signal …';
    else {
      const age = Math.round((now - f.at) / 1000);
      const acc = Math.round(f.acc) + ' m';
      if (state.q === 'lost') { text = 'Kein GPS-Signal seit ' + age + ' s. Letzte Genauigkeit ' + acc + '.'; bad = true; }
      else if (state.q === 'bad') { text = 'GPS ungenau: Genauigkeit ' + acc + ' (schlechter als 100 m). Letzter Wert vor ' + age + ' s.'; bad = true; }
      else text = 'GPS aktiv · Genauigkeit ' + acc + ' · letzter Wert vor ' + age + ' s';
      if (state.gpsError) { hint = GPS_HELP[state.gpsError.code]; }
    }
  }
  line.textContent = text;
  line.classList.toggle('bad', bad);
  help.textContent = hint || '';
  help.classList.toggle('hide', !hint);
}
$('gpsBtn').onclick = () => {
  if (state.source === 'gps' && !gps.running) { state.gpsError = null; gps.start(); updateQuality(); updateGpsUi(); return; } // nach Verweigerung: erneut versuchen
  setSource(state.source === 'gps' ? 'none' : 'gps');
};
$('gpsStatus').onclick = () => $('infoBtn').click();

// War GPS beim letzten Mal an und ist die Erlaubnis schon erteilt, startet es von selbst. Sonst nur auf Knopfdruck.
async function gpsAutostart() {
  if (store.get('tf.gps') !== 'on') return;
  try {
    const p = await navigator.permissions.query({ name: 'geolocation' });
    if (p.state === 'granted' && state.source === 'none') setSource('gps');
  } catch (e) { /* ohne Permissions-API nur per Knopf */ }
}

// ---------- Anzeige rechts ----------
// Anzeige des Hauptnummer: "<Langwahl oder Nummer> (<Bezeichnung>)"
function phoneMain(ph) {
  const n = ph.langwahl || ph.nummer || ph.kurzwahl || '';
  return ph.bezeichnung ? n + ' (' + ph.bezeichnung + ')' : n;
}
function phoneList(ril) {
  const p = state.personal.stations && state.personal.stations[ril];
  return ((p && p.phones) || []).filter(x => x.kurzwahl || x.langwahl || x.nummer);
}
function detailRows(ril) {
  const p = state.personal.stations && state.personal.stations[ril];
  const rows = [];
  if (!p) return rows;
  const strecke = (p.strecke || []).map(x => x.nummer).filter(Boolean);
  if (strecke.length) rows.push({ label: 'Strecke', items: [{ text: strecke.join(', ') }] });
  const list = phoneList(ril);
  const ph = list.find(x => x.haupt);
  if (ph) rows.push({ label: 'Rufnummer', phone: list.length > 1 || !!(ph.kurzwahl || ph.zustaendigkeit), items: [{ text: phoneMain(ph) }] });
  const zs = (p.zs2 || []).filter(z => z.buchstabe || z.richtung);
  if (zs.length) rows.push({
    label: 'Mögliche Zs 2',
    items: zs.map(z => ({ chip: z.buchstabe, text: [z.richtung, z.standort ? '(' + z.standort + ')' : ''].filter(Boolean).join(' ') }))
  });
  // Hauptkarte: nur Angaben mit sichtbar = "haupt" (Standard: Geschwindigkeit). Der Rest kommt später in "Details".
  const hw = (p.angaben || []).filter(a => a.sichtbar === 'haupt' && (a.titel || a.text));
  // Jede Zeile des Textes wird eine eigene Listenzeile
  if (hw.length) rows.push({ label: 'Hinweise', items: hw.map(a => ({ title: a.titel, lines: String(a.text || '').split(/\r?\n/).map(x => x.trim()).filter(Boolean) })) });
  return rows;
}

function showPhones(ril, name) {
  $('phoneTitle').textContent = 'Rufnummern – ' + name;
  const box = $('phoneList');
  box.replaceChildren();
  const list = phoneList(ril);
  list.forEach(ph => {
    const d = el('div', 'prow');
    d.append(el('b', '', (ph.bezeichnung || 'Rufnummer') + (ph.haupt ? ' ★' : '')));
    [['Kurzwahl', ph.kurzwahl], ['Langwahl', ph.langwahl], ['Nummer', ph.nummer], ['Zuständigkeit', ph.zustaendigkeit]]
      .forEach(([l, v]) => { if (v) { const r = el('div', 'pline'); r.append(el('span', 'mut', l), el('span', '', v)); d.append(r); } });
    box.append(d);
  });
  if (!list.length) box.append(el('div', 'mut', 'Keine Rufnummern hinterlegt.'));
  $('phoneDlg').showModal();
}

// Wie viele Betriebsstellen sind passiert? Gerechnet wird aus der Lage entlang der Strecke,
// nicht aus Ereignissen: bei Rückwärtsfahrt stellt sich alles von selbst zurück.
// Kleine Hysterese (HYST_M), damit die Anzeige an der Grenze nicht flackert.
const HYST_M = 50;
function updatePassed(s) {
  const st = state.route.stations, n = st.length;
  let p = Math.min(state.passed, n);
  const fwd = i => (i === n - 1 ? st[i].s : st[i].s + HYST_M); // Endstation: Ende der Strecke genügt
  while (p < n && s >= fwd(p)) p++;
  while (p > 0 && s < st[p - 1].s - HYST_M) p--;
  state.passed = p;
}
// Kompakte Blöcke "Zuletzt" und "Danach": Name, (Entfernung), Hauptnummer
function setMini(prefix, stn, dist) {
  const nm = $(prefix + 'Name');
  nm.textContent = stn ? stn.name : '—';
  nm.disabled = !stn;
  nm.onclick = stn ? () => openDetails(stn.ril100) : null;
  const d = $(prefix + 'Dist');
  if (d) d.textContent = stn && dist != null ? fmtDist(dist) : '';
  const btn = $(prefix + 'Phone');
  const list = stn ? phoneList(stn.ril100) : [];
  const ph = list.find(x => x.haupt);
  btn.classList.toggle('hide', !ph);
  if (ph) {
    btn.textContent = '☎ ' + phoneMain(ph);
    btn.onclick = () => showPhones(stn.ril100, stn.name);
  }
}

function render() {
  const r = state.route, pr = state.proj;
  const det = $('details');
  det.replaceChildren();
  if (!r || !pr) return;
  const s = pr.s;
  const sts = r.stations;
  updatePassed(s);
  const last = state.passed > 0 ? sts[state.passed - 1] : null;      // Zuletzt: zuletzt passierte Betriebsstelle
  const nx = state.passed < sts.length ? sts[state.passed] : null;   // Hauptanzeige: nächste voraus
  const after = state.passed + 1 < sts.length ? sts[state.passed + 1] : null; // Danach
  setMini('last', last, null);
  setMini('after', after, after ? after.s - s : null);
  $('distNext').textContent = nx ? fmtDist(nx.s - s) : fmtDist(0);
  const nn = $('nextName');
  nn.replaceChildren();
  if (nx) {
    const nb = el('button', 'namelink', nx.name + ' – ' + nx.ril100);
    nb.type = 'button';
    nb.onclick = () => openDetails(nx.ril100);
    nn.append(nb);
  } else nn.textContent = 'Ziel erreicht';
  if (nx) {
    for (const row of detailRows(nx.ril100)) {
      const d = el('div', 'drow');
      const head = el('div', 'dhead');
      head.append(el('span', 'lab', row.label));
      if (row.phone) {
        const b = el('button', 'phonebtn', '☎');
        b.type = 'button'; b.setAttribute('aria-label', 'Alle Rufnummern');
        b.onclick = () => showPhones(nx.ril100, nx.name);
        head.append(b);
      }
      d.append(head);
      for (const it of row.items) {
        if (it.lines) {
          const hb = el('div', 'hblock');
          if (it.title) hb.append(el('b', 'htitle', it.title));
          if (it.lines.length) {
            const ul = el('ul', 'hl');
            it.lines.forEach(l => ul.append(el('li', '', l)));
            hb.append(ul);
          }
          d.append(hb);
          continue;
        }
        const v = el('div', 'dval');
        if (it.chip) v.append(el('span', 'chip', it.chip));
        if (it.title) v.append(el('b', 'htitle', it.title));
        if (it.text) v.append(el('span', '', it.text));
        d.append(v);
      }
      det.append(d);
    }
  }
  const zielSt = r.stations[r.stations.length - 1];
  // Entfernung bis Ziel nur zeigen, wenn die nächste Betriebsstelle nicht schon das Ziel ist
  $('goalBox').classList.toggle('hide', !nx || nx === zielSt);
  $('distGoal').textContent = fmtDist(r.total - s);
  $('goalName').textContent = zielSt.name + ' – ' + zielSt.ril100;

  updateQuality(); // "Nicht auf der Strecke" und grau/aktuell je nach Signal

  if (!dragging) $('simPos').value = Math.round(sim.s);
  $('simPosVal').textContent = (sim.s / 1000).toFixed(1).replace('.', ',') + ' km';
}

// ---------- Route wählen ----------
function showError(msg) {
  $('errbox').textContent = msg || '';
  $('errbox').classList.toggle('hide', !msg);
}

function applyRoute(sel) {
  const res = Route.build(state.net, sel.start, sel.ziel, sel.via);
  if (res.error) return res.error;
  state.sel = { start: sel.start, ziel: sel.ziel, via: res.via };
  state.route = res;
  state.proj = null; state.lastS = 0; state.pos = null; state.passed = 0; state.hasLock = false; state.cand = null;
  store.set('tf.route', JSON.stringify(state.sel));
  const nm = id => state.net.stations.find(s => s.ril100 === id).name;
  $('routeName').textContent = nm(res.startId) + ' → ' + nm(res.zielId) + (res.via.length ? '  (+' + res.via.length + ')' : '');
  $('simPos').max = Math.round(res.total);
  sim.reset();
  $('simPlay').textContent = 'Start';
  map.setRoute(res);
  map.setFollow();
  // Gibt es schon einen brauchbaren Wert der aktiven Quelle, gilt er sofort für die neue Route
  const f = state.fix;
  if (state.source === 'sim') sim.emit();
  else if (state.source === 'gps' && f && f.acc <= GPS_MAX_ACC_M) applyFix(f, null, clock.now());
  else showStart();
  return null;
}

function fillRouteDialog() {
  const st = state.net.stations;
  for (const id of ['selStart', 'selZiel']) {
    const sel = $(id);
    sel.replaceChildren();
    st.forEach(s => { const o = el('option', '', s.name + ' – ' + s.ril100); o.value = s.ril100; sel.append(o); });
  }
  $('selStart').value = state.sel.start;
  $('selZiel').value = state.sel.ziel;
  renderVia(state.sel.via);
  $('routeErr').textContent = '';
}
function renderVia(checked) {
  const box = $('viaList');
  box.replaceChildren();
  const a = $('selStart').value, b = $('selZiel').value;
  state.net.stations.forEach(s => {
    if (s.ril100 === a || s.ril100 === b) return;
    const lab = el('label');
    const cb = document.createElement('input');
    cb.type = 'checkbox'; cb.value = s.ril100; cb.checked = checked.includes(s.ril100);
    lab.append(cb, el('span', '', s.name + ' – ' + s.ril100));
    box.append(lab);
  });
}
function checkedVia() { return [...document.querySelectorAll('#viaList input:checked')].map(c => c.value); }

$('routeBtn').onclick = () => { fillRouteDialog(); $('routeDlg').showModal(); };
$('selStart').onchange = $('selZiel').onchange = () => renderVia(checkedVia());
$('swapBtn').onclick = () => {
  const a = $('selStart').value; $('selStart').value = $('selZiel').value; $('selZiel').value = a;
  renderVia(checkedVia());
};
$('routeCancel').onclick = () => $('routeDlg').close();
$('routeForm').onsubmit = e => {
  e.preventDefault();
  const err = applyRoute({ start: $('selStart').value, ziel: $('selZiel').value, via: checkedVia() });
  if (err) {
    $('routeErr').textContent = err === 'same' ? 'Start und Ziel dürfen nicht gleich sein.' :
      err === 'nopath' ? 'Zwischen diesen Betriebsstellen gibt es keine Verbindung in den Daten.' : 'Bitte Start und Ziel wählen.';
    return;
  }
  $('routeDlg').close();
};

// ---------- Bedienelemente ----------
$('zin').onclick = () => map.zoomIn();
$('zout').onclick = () => map.zoomOut();
$('zall').onclick = () => map.showAll();
$('zfollow').onclick = () => map.setFollow();
// "Folgen" zeigt an, ob die Karte der Position folgt (nach einer Geste oder "Gesamte Strecke" ist es aus)
map.onViewChange = () => $('zfollow').setAttribute('aria-pressed', String(map.isFollowing()));
themeBtns.forEach(b => { b.onclick = () => applyTheme(b.dataset.setTheme); });

// Schriftgröße (Klein / Mittel / Groß) über die CSS-Variable --fs
const fsBtns = document.querySelectorAll('[data-set-fs]');
function applyFs(v) {
  if (!['klein', 'mittel', 'gross'].includes(v)) v = 'mittel';
  if (v === 'mittel') delete document.documentElement.dataset.fs; else document.documentElement.dataset.fs = v;
  fsBtns.forEach(b => b.setAttribute('aria-pressed', String(b.dataset.setFs === v)));
  store.set('tf.fs', v);
}
fsBtns.forEach(b => { b.onclick = () => applyFs(b.dataset.setFs); });

// Hintergrundkarte (Natural Earth) an/aus, Standard an, Auswahl wird gemerkt
const bgBtns = document.querySelectorAll('[data-set-bg]');
function applyBg(v) {
  if (v !== 'aus') v = 'an';
  map.setBackgroundVisible(v === 'an');
  bgBtns.forEach(b => b.setAttribute('aria-pressed', String(b.dataset.setBg === v)));
  store.set('tf.bg', v);
}
bgBtns.forEach(b => { b.onclick = () => applyBg(b.dataset.setBg); });

// Testmodus: nur auf Wunsch (PC), standardmäßig aus, wird nicht gespeichert. Er schaltet das GPS aus (nur eine Quelle).
$('testMode').onchange = e => setSource(e.target.checked ? 'sim' : 'none');
$('infoBtn').onclick = () => $('infoDlg').showModal();
$('infoClose').onclick = () => $('infoDlg').close();
$('phoneClose').onclick = () => $('phoneDlg').close();

$('simPlay').onclick = () => {
  if (!state.route) return;
  if (!sim.playing && sim.s >= state.route.total) sim.s = 0;
  sim.playing = !sim.playing;
  sim.last = null;
  $('simPlay').textContent = sim.playing ? 'Pause' : 'Start';
};
let dragging = false;
const posEl = $('simPos');
['pointerdown', 'touchstart'].forEach(ev => posEl.addEventListener(ev, () => { dragging = true; }, { passive: true }));
['pointerup', 'pointercancel', 'touchend', 'change', 'blur'].forEach(ev => posEl.addEventListener(ev, () => { dragging = false; }));
posEl.oninput = () => { sim.s = +posEl.value; sim.emit(); };
$('simSpeed').onchange = e => { sim.speedKmh = +e.target.value; };
$('simFactor').onchange = e => { sim.factor = +e.target.value; };
$('simOff').oninput = e => {
  sim.offset = +e.target.value;
  $('simOffVal').textContent = fmtDist(Math.abs(sim.offset));
  sim.emit();
};

// ---------- Start ----------
async function loadJson(url, required) {
  try {
    const r = await fetch(url, { cache: 'no-cache' });
    if (!r.ok) throw new Error(url + ' ' + r.status);
    return await r.json();
  } catch (e) {
    if (required) throw e;
    return null;
  }
}

async function init() {
  applyTheme(store.get('tf.theme') || 'auto');
  applyFs(store.get('tf.fs') || 'mittel');
  applyBg(store.get('tf.bg') || 'an');
  // Hintergrundkarte: optional, die App läuft auch ohne sie
  loadJson('hintergrund.json', false).then(d => { if (d && d.format_version === 1) map.setBackground(d); });
  state.personal = (await Store.loadPersonal()) || {};   // ohne persönliche Daten läuft die App trotzdem
  try {
    state.net = await loadJson(DATA.network, true);
  } catch (e) {
    showError('Streckendaten (network.json) konnten nicht geladen werden. Bitte die App einmal mit Internet öffnen oder über App-starten.bat starten.');
    if (typeof datenInit === 'function') datenInit();
    return;
  }
  const ids = state.net.stations.map(s => s.ril100);
  let sel = null;
  try { sel = JSON.parse(store.get('tf.route')); } catch (e) { sel = null; }
  if (!sel || !ids.includes(sel.start) || !ids.includes(sel.ziel) || sel.start === sel.ziel) {
    sel = { start: ids[0], ziel: ids[ids.length - 1], via: [] };
  }
  sel.via = (sel.via || []).filter(v => ids.includes(v));
  if (applyRoute(sel)) applyRoute({ start: ids[0], ziel: ids[ids.length - 1], via: [] });
  setInterval(() => { sim.tick(performance.now()); }, 50);
  // Jede Sekunde: Signalzustand und Anzeige in Info prüfen. Die Simulation im Stand meldet sich weiter (wie ein GPS im Stand).
  setInterval(() => {
    if (state.source === 'sim' && !sim.playing) sim.emit();
    updateQuality();
    updateGpsUi();
  }, 1000);
  updateGpsUi();
  if (typeof datenInit === 'function') datenInit();
  gpsAutostart();
}
window.tf = { state, sim, gps, map, clock, onFix, setSource, applyRoute, fmtDist, updateQuality }; // zum Testen in der Konsole
init();
