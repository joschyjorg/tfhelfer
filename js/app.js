'use strict';
// Tf-Helfer, Teil A: Hauptlogik. Alles hängt an EINER Funktion: setPosition(lat, lon).
// Heute ruft die Simulation sie auf, später das GPS.

// Das Netz (OSM-Daten) liegt bei der App. Persönliche Daten gibt es NUR auf dem Gerät (IndexedDB, siehe storage.js)
// und kommen per "Laden" dorthin: nie vom Server.
const DATA = { network: 'network.json' };
const OFF_ROUTE_M = 300;

const $ = id => document.getElementById(id);
const store = {
  get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* ohne Speicher weiterarbeiten */ } }
};
const state = { passed: 0, net: null, personal: {}, route: null, sel: null, pos: null, proj: null, heading: 0, lastS: 0, prevPos: null };

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
  return { mapbg: g('--mapbg'), route: g('--route'), done: g('--done'), tx: g('--tx'), panel: g('--panel') };
}
function applyTheme(t) {
  const root = document.documentElement;
  if (t === 'hell' || t === 'dunkel') root.dataset.theme = t; else { delete root.dataset.theme; t = 'auto'; }
  themeBtns.forEach(b => b.setAttribute('aria-pressed', String(b.dataset.setTheme === t)));
  store.set('tf.theme', t);
  map.redraw();
}
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => map.redraw());

// ---------- Karte, Simulation ----------
const map = createMap($('map'), getColors);
const sim = createSim(() => state.route, (lat, lon) => setPosition(lat, lon), () => { $('simPlay').textContent = 'Start'; });

// ---------- Position (einziger Eingang für Simulation und später GPS) ----------
function setPosition(lat, lon) {
  const prev = state.pos;
  state.pos = { lat, lon };
  if (state.route) {
    const pr = Route.project(state.route, lat, lon, state.lastS);
    state.proj = pr;
    state.lastS = pr.s;
    if (pr.off <= OFF_ROUTE_M) state.heading = pr.bearing;
    else if (prev && Geo.dist([prev.lat, prev.lon], [lat, lon]) > 5) state.heading = Geo.bearing([prev.lat, prev.lon], [lat, lon]);
    map.setPosition(state.pos, state.heading, pr.s);
  }
  render();
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

  const off = pr.off > OFF_ROUTE_M;
  $('offwarn').classList.toggle('hide', !off);
  if (off) $('offdist').textContent = 'Abstand zur Strecke: ' + fmtDist(pr.off);

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
  state.proj = null; state.lastS = 0; state.pos = null; state.passed = 0;
  store.set('tf.route', JSON.stringify(state.sel));
  const nm = id => state.net.stations.find(s => s.ril100 === id).name;
  $('routeName').textContent = nm(res.startId) + ' → ' + nm(res.zielId) + (res.via.length ? '  (+' + res.via.length + ')' : '');
  $('simPos').max = Math.round(res.total);
  sim.reset();
  $('simPlay').textContent = 'Start';
  map.setRoute(res);
  map.setOverview(false);
  $('zall').textContent = 'Gesamte Strecke';
  sim.emit();
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
$('zin').onclick = () => { map.zoomIn(); $('zall').textContent = 'Gesamte Strecke'; };
$('zout').onclick = () => { map.zoomOut(); $('zall').textContent = 'Gesamte Strecke'; };
$('zall').onclick = () => { $('zall').textContent = map.toggleOverview() ? 'Folgen' : 'Gesamte Strecke'; };
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

// Testmodus: Simulationsleiste nur auf Wunsch, standardmäßig aus (wird nicht gespeichert)
$('testMode').onchange = e => {
  $('simPanel').classList.toggle('hide', !e.target.checked);
  if (!e.target.checked) { sim.playing = false; $('simPlay').textContent = 'Start'; }
};
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
  if (typeof datenInit === 'function') datenInit();
}
window.tf = { state, sim, map, setPosition, applyRoute, fmtDist }; // zum Testen in der Konsole
init();
