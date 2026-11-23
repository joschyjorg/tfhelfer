'use strict';
// Speicher für die persönlichen Daten: IndexedDB im Browser des Tablets.
// Die persönlichen Daten (Format wie personal.json) liegen NIE auf dem Server. Sie kommen nur per "Laden" auf das Gerät.
// Ohne persönliche Daten läuft die App trotzdem (nur Karte und Netz aus network.json).

const SICHERUNG_FORMAT = 'tf-helfer-sicherung';
const SICHERUNG_VERSION = 1;

const Store = (function () {
  const DB_NAME = 'tf-helfer', STORE = 'kv';
  let db = null;
  let memory = {};            // Notlösung, falls IndexedDB nicht verfügbar ist (z. B. privates Fenster)
  let usable = false;

  function open() {
    return new Promise(resolve => {
      if (!window.indexedDB) { resolve(false); return; }
      let req;
      try { req = indexedDB.open(DB_NAME, 1); } catch (e) { resolve(false); return; }
      req.onupgradeneeded = () => { req.result.createObjectStore(STORE); };
      req.onsuccess = () => { db = req.result; usable = true; resolve(true); };
      req.onerror = () => resolve(false);
      req.onblocked = () => resolve(false);
    });
  }
  function get(key) {
    if (!usable) return Promise.resolve(memory[key] === undefined ? null : memory[key]);
    return new Promise(resolve => {
      try {
        const r = db.transaction(STORE, 'readonly').objectStore(STORE).get(key);
        r.onsuccess = () => resolve(r.result === undefined ? null : r.result);
        r.onerror = () => resolve(null);
      } catch (e) { resolve(null); }
    });
  }
  function set(key, value) {
    if (!usable) { memory[key] = value; return Promise.resolve(true); }
    return new Promise(resolve => {
      try {
        const tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).put(value, key);
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => resolve(false);
        tx.onabort = () => resolve(false);
      } catch (e) { resolve(false); }
    });
  }

  const ready = open();
  const defaultMeta = () => ({ lastBackup: null, dirty: false });

  return {
    ready,
    isPersistentDb: () => usable,
    // --- persönliche Daten (Format wie personal.json)
    async loadPersonal() { await ready; const r = await get('personal'); return r && r.data ? r.data : null; },
    async savePersonal(data) { await ready; return set('personal', { data, savedAt: new Date().toISOString() }); },
    async loadBeforeLoad() { await ready; return get('personal-vor-laden'); },
    async saveBeforeLoad(data) { await ready; return set('personal-vor-laden', { data, savedAt: new Date().toISOString() }); },
    // --- Merkpunkte (später): schon jetzt Teil der Sicherung
    async loadMerkpunkte() { await ready; const r = await get('merkpunkte'); return r || { format_version: 1, punkte: [] }; },
    async saveMerkpunkte(data) { await ready; return set('merkpunkte', data); },
    // --- Meta: letzte Sicherung, ungesicherte Änderungen
    async loadMeta() { await ready; const r = await get('meta'); return Object.assign(defaultMeta(), r || {}); },
    async saveMeta(meta) { await ready; return set('meta', meta); },
    async markDirty() { const m = await this.loadMeta(); m.dirty = true; return this.saveMeta(m); }
  };
})();

// ---------- Sicherungsdatei ----------
// Aufbau:
// { format: "tf-helfer-sicherung", format_version: 1, erstellt: "<ISO-Datum>",
//   personal:   { ... genau der Inhalt von personal.json ... },
//   merkpunkte: { format_version: 1, punkte: [] } }
function buildSicherung(personal, merkpunkte) {
  return {
    format: SICHERUNG_FORMAT,
    format_version: SICHERUNG_VERSION,
    erstellt: new Date().toISOString(),
    personal: personal || { format_version: 1, stations: {} },
    merkpunkte: merkpunkte || { format_version: 1, punkte: [] }
  };
}
function localDateStamp(d) {
  const p = n => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}
function sicherungFileName(d) { return 'tf-helfer-sicherung-' + localDateStamp(d || new Date()) + '.json'; }

// Datei prüfen: entweder eine Sicherung oder eine nackte personal.json.
// Ergebnis: { ok, personal, merkpunkte, art, anzahl } oder { ok:false, fehler }
function parseDatei(text) {
  let obj;
  try { obj = JSON.parse(text); } catch (e) { return { ok: false, fehler: 'Die Datei ist kein gültiges JSON.' }; }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { ok: false, fehler: 'Unbekanntes Dateiformat.' };
  let personal, merkpunkte = null, art;
  if (obj.format === SICHERUNG_FORMAT) {
    if (typeof obj.format_version !== 'number' || obj.format_version > SICHERUNG_VERSION) {
      return { ok: false, fehler: 'Diese Sicherung stammt aus einer neueren Version der App.' };
    }
    personal = obj.personal;
    merkpunkte = obj.merkpunkte || null;
    art = 'Sicherung';
  } else if (obj.stations) {
    personal = obj;
    art = 'personal.json';
  } else {
    return { ok: false, fehler: 'Unbekanntes Dateiformat (weder Sicherung noch personal.json).' };
  }
  if (!personal || typeof personal !== 'object' || !personal.stations || typeof personal.stations !== 'object' || Array.isArray(personal.stations)) {
    return { ok: false, fehler: 'In der Datei fehlt der Abschnitt „stations“.' };
  }
  for (const [k, v] of Object.entries(personal.stations)) {
    if (!v || typeof v !== 'object') return { ok: false, fehler: 'Eintrag „' + k + '“ ist ungültig.' };
  }
  return { ok: true, personal, merkpunkte, art, anzahl: Object.keys(personal.stations).length };
}
