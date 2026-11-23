'use strict';
// Info-Bereich "Daten auf dem Tablet": Sichern, Laden, Erinnerung, dauerhafter Speicher, Bildschirm an, Service Worker.
// Wird nach app.js und details.js geladen.

const ERINNERUNG_TAGE = 14;
let meta = { lastBackup: null, dirty: false };

function hasPersonalData() {
  return !!(state.personal && state.personal.stations && Object.keys(state.personal.stations).length);
}
function daysSince(iso) {
  if (!iso) return null;
  const ms = Date.now() - new Date(iso).getTime();
  return Math.max(0, Math.floor(ms / 86400000));
}
function fmtLocalDate(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return '';
  const p = n => String(n).padStart(2, '0');
  return p(d.getDate()) + '.' + p(d.getMonth() + 1) + '.' + d.getFullYear();
}
function msg(text, isError) {
  const m = $('dataMsg');
  m.textContent = text || '';
  m.classList.toggle('bad', !!isError);
}

// ---------- Anzeige: Info und Erinnerung auf dem Hauptbildschirm ----------
async function updateDataUi() {
  const has = hasPersonalData();
  const d = daysSince(meta.lastBackup);
  let line;
  if (!has) line = 'Keine persönlichen Daten auf dem Tablet. Mit „Laden“ eine Datei (personal.json oder Sicherung) einlesen.';
  else if (meta.lastBackup) line = 'Letzte Sicherung: ' + fmtLocalDate(meta.lastBackup) + (d === 0 ? ' (heute)' : ' (vor ' + d + ' Tagen)') + (meta.dirty ? '. Es gibt ungesicherte Änderungen.' : '.');
  else line = 'Noch keine Sicherung gemacht.' + (meta.dirty ? ' Es gibt ungesicherte Änderungen.' : '');
  $('dataInfo').textContent = line;
  $('btnSichern').disabled = !has;
  const prev = await Store.loadBeforeLoad();
  $('btnRestore').classList.toggle('hide', !(prev && prev.data));

  // Erinnerung (kleine Leiste, kein Fenster)
  let why = '';
  if (has) {
    if (meta.dirty) why = 'Ungesicherte Änderungen.';
    else if (!meta.lastBackup) why = 'Noch keine Sicherung.';
    else if (d > ERINNERUNG_TAGE) why = 'Letzte Sicherung vor ' + d + ' Tagen.';
  }
  $('remind').classList.toggle('hide', !why);
  if (why) $('remindText').textContent = why + ' Bitte sichern.';
}

async function updateSysInfo() {
  const parts = [];
  parts.push('Speicher: ' + (Store.isPersistentDb() ? 'IndexedDB' : 'nur vorübergehend (IndexedDB nicht verfügbar)'));
  try {
    if (navigator.storage && navigator.storage.persisted) {
      parts.push('dauerhaft geschützt: ' + ((await navigator.storage.persisted()) ? 'ja' : 'nein'));
    }
  } catch (e) { /* ignorieren */ }
  parts.push('Bildschirm bleibt an: ' + (wakeLock ? 'ja' : (('wakeLock' in navigator) ? 'nein' : 'nicht unterstützt')));
  $('sysInfo').textContent = parts.join(' · ');
}

// ---------- Bestätigung ----------
function confirmAsk(title, text, yes) {
  return new Promise(resolve => {
    $('confirmTitle').textContent = title;
    $('confirmText').textContent = text;
    $('confirmYes').textContent = yes;
    const dlg = $('confirmDlg');
    let done = false;
    const fin = v => { if (done) return; done = true; resolve(v); if (dlg.open) dlg.close(); };
    $('confirmYes').onclick = () => fin(true);
    $('confirmNo').onclick = () => fin(false);
    dlg.onclose = () => fin(false);
    dlg.showModal();
  });
}

// ---------- Daten ersetzen (Laden / Wiederherstellen) ----------
async function replaceData(personal, merkpunkte, opts) {
  const prev = await Store.loadPersonal();
  if (prev && prev.stations && Object.keys(prev.stations).length) await Store.saveBeforeLoad(prev); // „letzte Version vor Laden“
  await Store.savePersonal(personal);
  if (merkpunkte) await Store.saveMerkpunkte(merkpunkte);
  state.personal = personal;
  // Eine geladene Datei ist selbst eine Kopie (liegt auf dem PC oder im Download-Ordner)
  meta = opts && opts.fromRestore ? Object.assign({}, meta, { dirty: true }) : { lastBackup: new Date().toISOString(), dirty: false };
  await Store.saveMeta(meta);
  if (state.route) render();
  await updateDataUi();
}

async function doLaden(file) {
  msg('');
  let text;
  try { text = await file.text(); } catch (e) { msg('Die Datei konnte nicht gelesen werden.', true); return; }
  const r = parseDatei(text);
  if (!r.ok) { msg(r.fehler, true); return; }
  if (hasPersonalData()) {
    const ok = await confirmAsk('Daten ersetzen',
      'Alle Daten auf dem Tablet werden ersetzt. Datei: ' + file.name + ' (' + r.art + ', ' + r.anzahl + ' Betriebsstellen). ' +
      'Die bisherigen Daten werden vorher als „letzte Version vor Laden“ aufbewahrt.', 'Ersetzen');
    if (!ok) { msg('Abgebrochen. Nichts wurde geändert.'); return; }
  }
  await replaceData(r.personal, r.merkpunkte);
  msg('Geladen: ' + r.anzahl + ' Betriebsstellen aus ' + file.name + '.');
}

async function doRestore() {
  const prev = await Store.loadBeforeLoad();
  if (!prev || !prev.data) return;
  const ok = await confirmAsk('Vorherige Version wiederherstellen',
    'Alle Daten auf dem Tablet werden ersetzt durch die Version vom ' + fmtLocalDate(prev.savedAt) + ' („letzte Version vor Laden“). Die jetzigen Daten werden dafür aufbewahrt.', 'Wiederherstellen');
  if (!ok) return;
  await replaceData(prev.data, null, { fromRestore: true });
  msg('Vorherige Version wiederhergestellt.');
}

// ---------- Sichern ----------
async function doSichern() {
  if (!hasPersonalData()) { msg('Keine Daten zum Sichern.', true); return; }
  const data = buildSicherung(state.personal, await Store.loadMerkpunkte());
  const name = sicherungFileName(new Date());
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  meta = { lastBackup: new Date().toISOString(), dirty: false };
  await Store.saveMeta(meta);
  await updateDataUi();
  msg('Gesichert als ' + name + ' (Ordner Downloads).');
}

// ---------- Bildschirm an (Wake Lock) ----------
let wakeLock = null;
async function holdAwake() {
  if (!('wakeLock' in navigator) || document.visibilityState !== 'visible') return;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', () => { wakeLock = null; updateSysInfo(); });
  } catch (e) { wakeLock = null; }
  updateSysInfo();
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') holdAwake(); });

// ---------- Start ----------
let datenStarted = false;
async function datenInit() {
  if (datenStarted) { meta = await Store.loadMeta(); await updateDataUi(); return; }
  datenStarted = true;
  meta = await Store.loadMeta();
  await updateDataUi();
  try { if (navigator.storage && navigator.storage.persist) await navigator.storage.persist(); } catch (e) { /* ignorieren */ }
  holdAwake();
  updateSysInfo();
}

$('btnSichern').onclick = doSichern;
$('remindBtn').onclick = doSichern;
$('btnLaden').onclick = () => $('fileIn').click();
$('fileIn').onchange = e => { const f = e.target.files && e.target.files[0]; e.target.value = ''; if (f) doLaden(f); };
$('btnRestore').onclick = doRestore;
$('infoBtn').addEventListener('click', () => { updateDataUi(); updateSysInfo(); });

// ---------- Offline: Service Worker ----------
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => { navigator.serviceWorker.register('sw.js').catch(() => { /* ohne Offline-Cache weiterarbeiten */ }); });
}

window.tfData = { replaceData, doLaden, doSichern, parseDatei, getMeta: () => meta };
