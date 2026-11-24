'use strict';
// Teil B1: Fenster "Details" (nur Ansicht) und Menü "Betriebsstellen" mit Suche.
// Wird nach app.js geladen und benutzt dessen Hilfen ($, el, state, store).

// ---------- Zurück-Taste (Android) schließt das oberste Fenster ----------
// Jedes showModal() legt einen Verlaufseintrag an. "Zurück" nimmt ihn wieder weg und schließt das oberste Fenster.
const modalStack = [];
let skipPops = 0;
(function () {
  const origShow = HTMLDialogElement.prototype.showModal;
  HTMLDialogElement.prototype.showModal = function () {
    if (this.open) return;
    origShow.call(this);
    modalStack.push(this);
    try { history.pushState({ tfModal: this.id }, ''); } catch (e) { /* ohne Verlauf weiterarbeiten */ }
  };
  // Aufräumen, wenn ein Fenster auf anderem Weg geschlossen wurde (Kreuz, Schließen, Esc, Formular)
  const cleanup = d => {
    const i = modalStack.indexOf(d);
    if (i < 0) return;            // schon durch "Zurück" geschlossen oder schon aufgeräumt
    modalStack.splice(i, 1);
    skipPops++;
    try { history.back(); } catch (e) { skipPops--; }
  };
  const origClose = HTMLDialogElement.prototype.close;
  HTMLDialogElement.prototype.close = function (rv) {
    const was = this.open;
    origClose.call(this, rv);
    if (was) cleanup(this);
  };
  // Esc und Formular-Schließen gehen am close() vorbei: dafür das close-Ereignis
  document.querySelectorAll('dialog').forEach(d => d.addEventListener('close', () => cleanup(d)));
  window.addEventListener('popstate', () => {
    if (skipPops > 0) { skipPops--; return; }
    const d = modalStack.pop();
    if (d && d.open) d.close();
  });
})();

// ---------- Hilfen ----------
const KATEGORIEN = [
  ['geschwindigkeit', 'Geschwindigkeit'], ['neigung', 'Neigung'], ['meldung', 'Meldung'],
  ['bahnuebergang', 'Bahnübergang'], ['signal', 'Signal'], ['rangieren', 'Rangieren'], ['sonstiges', 'Sonstiges']
];

// Kombinierende Akzentzeichen (U+0300 bis U+036F) entfernen
const ACCENTS = new RegExp('[' + String.fromCharCode(0x300) + '-' + String.fromCharCode(0x36f) + ']', 'g');
// ä = ae, ö = oe, ü = ue, ß = ss; Groß/Klein egal
function normSearch(s) {
  return String(s || '').toLowerCase()
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .normalize('NFD').replace(ACCENTS, '');
}
// Zweite, mildere Schreibweise: Umlaute einfach ohne Punkte (Brücke = Brucke), damit beides gefunden wird
function stripSearch(s) {
  return String(s || '').toLowerCase().replace(/ß/g, 'ss').normalize('NFD').replace(ACCENTS, '');
}
function matchSearch(text, q) {
  return normSearch(text).includes(normSearch(q)) || stripSearch(text).includes(stripSearch(q));
}
function fmtDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || '');
  return m ? m[3] + '.' + m[2] + '.' + m[1] : '';
}
function stationData(ril) {
  const net = (state.net.stations || []).find(s => s.ril100 === ril);
  const p = (state.personal.stations && state.personal.stations[ril]) || null;
  return { net, p };
}
function personalName(net, p) {
  return (p && p.ident && p.ident.name && p.ident.name.value) || (net && net.name) || '';
}
function stationTyp(net, p) {
  const t = p && p.typ && p.typ.value;
  if (t) return t + (p.typ.typ_roh && p.typ.typ_roh !== t ? ' (' + p.typ.typ_roh + ')' : '');
  return net && net.typ ? net.typ + ' (OSM)' : '';
}

// ---------- Fenster Details ----------
function infoRow(label, value) {
  const r = el('div', 'irow');
  r.append(el('span', 'lab', label), el('span', 'ival', value));
  return r;
}
function section(title) {
  const s = el('section', 'dsec');
  s.append(el('h3', '', title));
  return s;
}
function angabeBlock(a) {
  const b = el('div', 'abox');
  if (a.titel) b.append(el('b', 'atitle', a.titel));
  if (a.text) b.append(el('div', 'atext', a.text));
  if (a.tabelle && a.tabelle.length) {
    const wrap = el('div', 'twrap');
    const tb = el('table', 'atab');
    const hd = el('tr');
    ['Gleisangabe', '‰', 'Richtung'].forEach(h => hd.append(el('th', '', h)));
    tb.append(hd);
    a.tabelle.forEach(row => {
      const tr = el('tr');
      if (row.text != null && row.gleisangabe == null) {
        const td = el('td', '', row.text);
        td.colSpan = 3;
        tr.append(td);
      } else {
        tr.append(el('td', '', row.gleisangabe || ''), el('td', 'num', Number(row.promille).toFixed(1).replace('.', ',')), el('td', '', row.richtung || ''));
      }
      tb.append(tr);
    });
    wrap.append(tb);
    b.append(wrap);
  }
  if (a.ril) b.append(el('div', 'ril', 'Ril ' + a.ril));
  const hk = herkunftText(a);
  if (hk) b.append(el('div', 'herk', hk));
  return b;
}

function openDetails(ril) {
  const { net, p } = stationData(ril);
  if (!net) return;
  const name = personalName(net, p);
  $('detailTitle').textContent = name;
  const body = $('detailBody');
  body.replaceChildren();

  // Kopf
  const head = el('div', 'dhead2');
  head.append(infoRow('Ril 100', ril));
  const typ = stationTyp(net, p);
  if (typ) head.append(infoRow('Typ', typ));
  const strecke = ((p && p.strecke) || []).filter(x => x.nummer)
    .map(x => x.nummer + (x.regionen && x.regionen.length ? ' (BZ ' + x.regionen.join(', BZ ') + ')' : ''));
  if (strecke.length) head.append(infoRow('Strecke', strecke.join(', ')));
  const phones = ((p && p.phones) || []).filter(x => x.kurzwahl || x.langwahl || x.nummer);
  const main = phones.find(x => x.haupt);
  if (main && main.bezeichnung) head.append(infoRow('Zuständig', main.bezeichnung));
  body.append(head);
  // Verweise "Siehe Strecke N": Daten dieser Betriebsstelle stehen in einer anderen Strecke, die noch nicht geladen ist
  verweisTexte(p).forEach(t => body.append(el('p', 'verweis', t)));

  const zs =((p && p.zs2) || []).filter(z => z.buchstabe || z.richtung);
  const angaben = (p && p.angaben) || [];
  let any = false;

  // Rufnummern
  if (phones.length) {
    any = true;
    const s = section('Rufnummern');
    phones.forEach(ph => {
      const d = el('div', 'prow');
      d.append(el('b', '', (ph.bezeichnung || 'Rufnummer') + (ph.haupt ? ' ★' : '')));
      [['Kurzwahl', ph.kurzwahl], ['Langwahl', ph.langwahl], ['Nummer', ph.nummer], ['Zuständigkeit', ph.zustaendigkeit]]
        .forEach(([l, v]) => { if (v) { const r = el('div', 'pline'); r.append(el('span', 'mut', l), el('span', '', v)); d.append(r); } });
      const hk = herkunftText(ph);
      if (hk) d.append(el('div', 'herk', hk));
      s.append(d);
    });
    body.append(s);
  }

  // Zs 2
  if (zs.length) {
    any = true;
    const s = section('Mögliche Zs 2');
    zs.forEach(z => {
      const d = el('div', 'dval');
      if (z.buchstabe) d.append(el('span', 'chip', z.buchstabe));
      d.append(el('span', '', [z.richtung, z.standort ? '(' + z.standort + ')' : ''].filter(Boolean).join(' ')));
      const hk = herkunftText(z);
      if (hk) d.append(el('span', 'herk', hk));
      s.append(d);
    });
    body.append(s);
  }

  // Angaben nach Kategorie (alle, auch die auf der Hauptkarte versteckten)
  for (const [key, label] of KATEGORIEN) {
    const items = angaben.filter(a => (KATEGORIEN.some(k => k[0] === a.kategorie) ? a.kategorie : 'sonstiges') === key);
    if (!items.length) continue;
    any = true;
    const s = section(label);
    items.forEach(a => s.append(angabeBlock(a)));
    body.append(s);
  }

  if (!any) body.append(el('p', 'mut keine', 'Keine Angaben'));

  // Fuß: Hinweis und Importdatum
  const dates = [];
  if (p) {
    if (p.typ && p.typ.importiert) dates.push(p.typ.importiert);
    (p.phones || []).forEach(x => x.importiert && dates.push(x.importiert));
    angaben.forEach(x => x.importiert && dates.push(x.importiert));
  }
  const foot = el('p', 'dfoot', 'Auszug, nicht verbindlich. Maßgebend sind Streckenbuch und La.');
  if (dates.length) foot.append(el('br'), 'Importiert am ' + fmtDate(dates.sort().pop()));
  body.append(foot);

  $('detailDlg').showModal();
  body.scrollTop = 0;
}

// ---------- Menü Betriebsstellen ----------
function routeRils() {
  return new Set(state.route ? state.route.stations.map(s => s.ril100) : []);
}
function renderBsList() {
  const q = $('bsSearch').value.trim();
  const onRoute = routeRils();
  const list = $('bsList');
  list.replaceChildren();
  const rows = (state.net.stations || []).map(net => {
    const p = state.personal.stations && state.personal.stations[net.ril100];
    return { net, name: personalName(net, p), typ: stationTyp(net, p) };
  }).filter(r => !q || matchSearch(r.name, q) || matchSearch(r.net.ril100, q));
  rows.sort((a, b) => normSearch(a.name).localeCompare(normSearch(b.name), 'de'));
  rows.forEach(r => {
    const b = el('button', 'bsrow' + (onRoute.has(r.net.ril100) ? ' onroute' : ''));
    b.type = 'button';
    b.append(el('span', 'bsname', r.name), el('span', 'bsril', r.net.ril100));
    if (r.typ) b.append(el('span', 'bstyp', r.typ));
    if (onRoute.has(r.net.ril100)) b.append(el('span', 'chip', 'Route'));
    b.onclick = () => openDetails(r.net.ril100);
    list.append(b);
  });
  if (!rows.length) list.append(el('p', 'mut keine', 'Keine Betriebsstelle gefunden'));
}

$('bsBtn').onclick = () => {
  $('bsSearch').value = '';
  renderBsList();
  $('bsDlg').showModal();
};
$('bsSearch').oninput = renderBsList;
$('bsClose').onclick = () => $('bsDlg').close();
$('detailClose').onclick = () => $('detailDlg').close();
