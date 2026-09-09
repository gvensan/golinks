'use strict';

// File-backed store for links, rules, templates and settings.
// Atomic writes (tmp + rename), .bak of previous version, daily backups,
// and hot reload when the files change on disk (for example after git pull).

const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');

const ROOT = path.resolve(__dirname, '..');
// LINKS_HOME lets personal data live outside the code folder (default: the code folder).
const HOME_DIR = process.env.LINKS_HOME ? path.resolve(process.env.LINKS_HOME) : ROOT;
const DATA_DIR = path.join(HOME_DIR, 'data');
const DEFAULTS_DIR = path.join(ROOT, 'data', 'defaults');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const BACKUP_KEEP = 14;

const FILES = {
  links: 'links.json',
  rules: 'rules.json',
  templates: 'templates.json',
  settings: 'settings.json',
};

const DEFAULTS = {
  links: () => [],
  rules: () => [],
  templates: () => ({}),
  settings: () => ({
    port: 7777,
    staleDays: 90,
    snapshotOnRevisit: false,
    headlessSnapshots: true,
    goMinScore: 0.6,
    topCrop: 116,
    setup: {},
  }),
};

const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

class Store extends EventEmitter {
  constructor(dataDir = DATA_DIR) {
    super();
    this.dataDir = dataDir;
    this.backupDir = path.join(dataDir, 'backups');
    this.data = {};
    this.lastWritten = {};
    this.watcher = null;
    this.reloadTimer = null;
  }

  filePath(name) {
    return path.join(this.dataDir, FILES[name]);
  }

  loadAll() {
    fs.mkdirSync(this.dataDir, { recursive: true });
    for (const name of Object.keys(FILES)) this.load(name);
    return this.data;
  }

  load(name) {
    const file = this.filePath(name);
    let value;
    if (fs.existsSync(file)) {
      const text = fs.readFileSync(file, 'utf8');
      try {
        value = JSON.parse(text);
        this.lastWritten[name] = text;
      } catch (err) {
        // Corrupt file: keep the in-memory copy if we have one, otherwise the default.
        console.error(`[store] ${FILES[name]} is not valid JSON, keeping previous state: ${err.message}`);
        value = this.data[name] !== undefined ? this.data[name] : DEFAULTS[name]();
      }
    } else {
      // First run: copy the shipped default (rules, templates) if there is one.
      const shipped = path.join(DEFAULTS_DIR, FILES[name]);
      value = DEFAULTS[name]();
      if (fs.existsSync(shipped)) {
        try { value = JSON.parse(fs.readFileSync(shipped, 'utf8')); } catch { /* keep default */ }
      }
      this.write(name, value);
    }
    if (name === 'settings') value = Object.assign(DEFAULTS.settings(), value);
    if (name === 'links' && !Array.isArray(value)) value = [];
    this.data[name] = value;
    return value;
  }

  write(name, value) {
    const file = this.filePath(name);
    const text = JSON.stringify(value, null, 2) + '\n';
    fs.mkdirSync(this.dataDir, { recursive: true });
    if (fs.existsSync(file)) {
      try { fs.copyFileSync(file, file + '.bak'); } catch { /* ignore */ }
    }
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, file);
    this.lastWritten[name] = text;
    if (name === 'links') this.dailyBackup(text);
  }

  save(name) {
    this.write(name, this.data[name]);
    this.emit('saved', name);
  }

  dailyBackup(text) {
    try {
      fs.mkdirSync(this.backupDir, { recursive: true });
      const day = new Date().toISOString().slice(0, 10);
      const file = path.join(this.backupDir, `links-${day}.json`);
      if (!fs.existsSync(file)) fs.writeFileSync(file, text);
      const all = fs.readdirSync(this.backupDir).filter((f) => /^links-\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
      while (all.length > BACKUP_KEEP) fs.unlinkSync(path.join(this.backupDir, all.shift()));
    } catch (err) {
      console.error('[store] backup failed:', err.message);
    }
  }

  // Watch the data directory. Reload files that changed on disk and were not written by us.
  watch() {
    if (this.watcher) return;
    try {
      this.watcher = fs.watch(this.dataDir, { persistent: false }, (event, filename) => {
        if (!filename) return;
        const name = Object.keys(FILES).find((n) => FILES[n] === filename);
        if (!name) return;
        clearTimeout(this.reloadTimer);
        this.reloadTimer = setTimeout(() => this.reloadIfChanged(name), 300);
      });
    } catch (err) {
      console.error('[store] watch failed:', err.message);
    }
  }

  reloadIfChanged(name) {
    const file = this.filePath(name);
    if (!fs.existsSync(file)) return;
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch { return; }
    if (text === this.lastWritten[name]) return;
    try {
      JSON.parse(text);
    } catch {
      return; // half-written file, wait for the next event
    }
    this.load(name);
    console.log(`[store] reloaded ${FILES[name]} from disk`);
    this.emit('reloaded', name);
  }

  close() {
    if (this.watcher) this.watcher.close();
    this.watcher = null;
  }

  // ---- link helpers ----

  get links() { return this.data.links; }
  get rules() { return this.data.rules; }
  get templates() { return this.data.templates; }
  get settings() { return this.data.settings; }

  newId() {
    const ids = new Set(this.links.map((l) => l.id));
    for (;;) {
      let id = '';
      for (let i = 0; i < 6; i++) id += ID_ALPHABET[Math.floor(Math.random() * ID_ALPHABET.length)];
      if (!ids.has(id)) return id;
    }
  }

  findById(id) {
    return this.links.find((l) => l.id === id) || null;
  }

  findByKeyword(keyword) {
    if (!keyword) return null;
    const k = String(keyword).toLowerCase();
    return this.links.find((l) => l.keyword && l.keyword.toLowerCase() === k) || null;
  }
}

module.exports = { Store, ROOT, HOME_DIR, DATA_DIR, DEFAULTS_DIR, BACKUP_DIR, FILES, DEFAULTS };
