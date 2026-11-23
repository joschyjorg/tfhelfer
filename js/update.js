'use strict';
// Info: Versionsstand und "Nach Update suchen".
//
// So kommt eine neue Version aufs Tablet:
//  1. Beim Veröffentlichen bekommt jede Version einen neuen Stand (Datum und Uhrzeit) in js/version.js und sw.js.
//  2. Öffnen Sie die App mit Internet, holt sie ihre Dateien zuerst frisch aus dem Netz; ohne Internet nimmt sie die gespeicherten.
//  3. Der Browser prüft dabei auch sw.js. Hat sich der Stand geändert, lädt er die neue Version im Hintergrund vor und lässt sie WARTEN.
//  4. Sie wird aktiv, wenn die App ganz geschlossen und neu geöffnet wird, oder wenn Sie hier "Jetzt neu laden" wählen.
//  5. Strecke, persönliche Daten und Einstellungen liegen in IndexedDB/localStorage und werden dabei nicht angefasst.
// Nie automatisch mitten in der Fahrt: "Jetzt neu laden" geht nur im Stand und nach Bestätigung.

let updatePending = null;   // Versionsstand, der auf dem Server neuer ist, sonst null

function fmtVersion(v) {
  const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})/.exec(v || '');
  return m ? m[3] + '.' + m[2] + '.' + m[1] + ', ' + m[4] + ':' + m[5] + ' Uhr' : null;
}
function updMsg(text, bad) {
  const m = $('updMsg');
  m.textContent = text || '';
  m.classList.toggle('bad', !!bad);
}
function showVersion() {
  const f = fmtVersion(APP_VERSION);
  $('verInfo').textContent = f ? 'Stand: ' + f + ' (' + APP_VERSION + ')' : 'Entwicklungsstand (nicht veröffentlicht)';
}

async function checkUpdate() {
  const btn = $('btnUpdate');
  btn.disabled = true;
  updMsg('Prüfe …');
  try {
    let remote = null;
    try {
      // "check" im Namen: der Service Worker lässt diese Anfrage immer zum Server durch (nie aus dem Cache)
      const r = await fetch('js/version.js?check=' + Date.now(), { cache: 'no-store' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const m = /APP_VERSION\s*=\s*'([^']*)'/.exec(await r.text());
      remote = m && m[1];
    } catch (e) {
      updMsg('Keine Verbindung zum Server. Für die Prüfung wird Internet gebraucht.', true);
      return;
    }
    if (!remote) { updMsg('Die Antwort des Servers ist unerwartet. Bitte später noch einmal versuchen.', true); return; }
    // Dem Service Worker Bescheid geben, damit er die neue Version schon vorlädt
    try { if ('serviceWorker' in navigator) { const reg = await navigator.serviceWorker.getRegistration(); if (reg) await reg.update(); } } catch (e) { /* ignorieren */ }
    if (remote === APP_VERSION) {
      updatePending = null;
      $('btnReload').classList.add('hide');
      updMsg('Sie haben die neueste Version.');
    } else {
      updatePending = remote;
      $('btnReload').classList.remove('hide');
      const f = fmtVersion(remote);
      updMsg('Neue Version verfügbar' + (f ? ' (' + f + ')' : '') + '. Im Stand mit „Jetzt neu laden“ übernehmen.');
    }
  } finally {
    btn.disabled = false;
  }
}

async function applyUpdate() {
  if (isMoving()) { updMsg('Während der Fahrt nicht möglich. Bitte im Stand neu laden.', true); return; }
  const ok = await confirmAsk('Neue Version laden',
    'Die App lädt sich neu und startet mit der neuen Version. Strecke, persönliche Daten und Einstellungen bleiben erhalten. Bitte nicht während der Fahrt.',
    'Jetzt neu laden');
  if (!ok) return;
  if (isMoving()) { updMsg('Während der Fahrt nicht möglich. Bitte im Stand neu laden.', true); return; }
  try {
    const reg = 'serviceWorker' in navigator ? await navigator.serviceWorker.getRegistration() : null;
    if (reg && reg.waiting) {
      await new Promise(resolve => {
        navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true });
        reg.waiting.postMessage({ type: 'SKIP_WAITING' });
        setTimeout(resolve, 3000);
      });
    }
  } catch (e) { /* trotzdem neu laden */ }
  location.reload();
}

$('btnUpdate').onclick = checkUpdate;
$('btnReload').onclick = applyUpdate;
showVersion();
window.tfUpdate = { checkUpdate, applyUpdate, fmtVersion };
