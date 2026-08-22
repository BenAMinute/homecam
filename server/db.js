const path = require('path');
const fs = require('fs');

const dbPath = process.env.DB_PATH || path.join(__dirname, '../data/homecam.db');

// Ensure parent directory exists
const dbDir = path.dirname(dbPath);
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

let dbInstance = null;
let isBetterSqlite = false;

try {
  const Database = require('better-sqlite3');
  dbInstance = new Database(dbPath);
  dbInstance.pragma('journal_mode = WAL');
  isBetterSqlite = true;
} catch (e) {
  console.log('ℹ️ Using standard sqlite3 driver...');
  const sqlite3 = require('sqlite3').verbose();
  const rawDb = new sqlite3.Database(dbPath);
  
  // Wrap sqlite3 methods for synchronous interface compatibility
  dbInstance = {
    exec: (sql) => new Promise((resolve, reject) => rawDb.exec(sql, err => err ? reject(err) : resolve())),
    prepare: (sql) => {
      return {
        run: (...args) => new Promise((resolve, reject) => {
          const params = args.length === 1 && typeof args[0] === 'object' && !Array.isArray(args[0]) ? args[0] : args;
          rawDb.run(sql, params, function(err) { err ? reject(err) : resolve({ changes: this.changes, lastInsertRowid: this.lastID }); });
        }),
        all: (...args) => new Promise((resolve, reject) => {
          const params = args.length === 1 && typeof args[0] === 'object' && !Array.isArray(args[0]) ? args[0] : args;
          rawDb.all(sql, params, (err, rows) => err ? reject(err) : resolve(rows));
        }),
        get: (...args) => new Promise((resolve, reject) => {
          const params = args.length === 1 && typeof args[0] === 'object' && !Array.isArray(args[0]) ? args[0] : args;
          rawDb.get(sql, params, (err, row) => err ? reject(err) : resolve(row));
        })
      };
    }
  };
}

// Initialize Schema
const schemaSQL = `
  CREATE TABLE IF NOT EXISTS cameras (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    status TEXT DEFAULT 'offline',
    last_seen DATETIME DEFAULT CURRENT_TIMESTAMP,
    battery_level INTEGER DEFAULT -1,
    resolution TEXT DEFAULT '720p',
    enabled_targets TEXT DEFAULT '["cat","person","motion"]',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS events (
    id TEXT PRIMARY KEY,
    camera_id TEXT NOT NULL,
    camera_name TEXT NOT NULL,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    duration INTEGER DEFAULT 0,
    type TEXT NOT NULL,
    confidence REAL DEFAULT 0,
    video_path TEXT NOT NULL,
    thumbnail_path TEXT,
    is_protected INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(camera_id) REFERENCES cameras(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`;

if (isBetterSqlite) {
  dbInstance.exec(schemaSQL);
} else {
  dbInstance.exec(schemaSQL).catch(err => console.error('DB schema error:', err));
}

// Default settings seed
const defaultSettings = {
  recording_enabled: '1',
  retention_days: process.env.RETENTION_DAYS || '14',
  max_storage_gb: process.env.MAX_STORAGE_GB || '50',
  confidence_threshold: process.env.CONFIDENCE_THRESHOLD || '0.65',
  global_targets: JSON.stringify(['cat', 'dog', 'person', 'vehicle', 'motion'])
};

if (isBetterSqlite) {
  const insertSetting = dbInstance.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
  for (const [k, v] of Object.entries(defaultSettings)) {
    insertSetting.run(k, v);
  }
} else {
  for (const [k, v] of Object.entries(defaultSettings)) {
    dbInstance.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)').run(k, v);
  }
}

// Export DB Helper Functions
module.exports = {
  db: dbInstance,
  isBetterSqlite,

  async upsertCamera(id, name, resolution = '720p', batteryLevel = -1) {
    const stmt = dbInstance.prepare(`
      INSERT INTO cameras (id, name, status, last_seen, battery_level, resolution)
      VALUES (?, ?, 'online', CURRENT_TIMESTAMP, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        status = 'online',
        last_seen = CURRENT_TIMESTAMP,
        battery_level = CASE WHEN excluded.battery_level >= 0 THEN excluded.battery_level ELSE battery_level END,
        resolution = excluded.resolution
    `);
    return await stmt.run(id, name, batteryLevel, resolution);
  },

  async updateCameraHeartbeat(id, batteryLevel, status = 'online') {
    const stmt = dbInstance.prepare(`
      UPDATE cameras SET status = ?, battery_level = ?, last_seen = CURRENT_TIMESTAMP WHERE id = ?
    `);
    return await stmt.run(status, batteryLevel, id);
  },

  async updateCameraTargets(id, enabledTargets) {
    const stmt = dbInstance.prepare('UPDATE cameras SET enabled_targets = ? WHERE id = ?');
    return await stmt.run(JSON.stringify(enabledTargets), id);
  },

  async deleteCamera(id) {
    const stmt = dbInstance.prepare('DELETE FROM cameras WHERE id = ?');
    return await stmt.run(id);
  },

  async getAllCameras() {
    const stmt = dbInstance.prepare('SELECT * FROM cameras ORDER BY name ASC');
    const rows = await stmt.all();
    return (rows || []).map(r => ({
      ...r,
      enabled_targets: JSON.parse(r.enabled_targets || '[]')
    }));
  },

  async getCamera(id) {
    const stmt = dbInstance.prepare('SELECT * FROM cameras WHERE id = ?');
    const row = await stmt.get(id);
    if (row) {
      row.enabled_targets = JSON.parse(row.enabled_targets || '[]');
    }
    return row;
  },

  async addEvent(event) {
    const stmt = dbInstance.prepare(`
      INSERT INTO events (id, camera_id, camera_name, timestamp, duration, type, confidence, video_path, thumbnail_path, is_protected)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    return await stmt.run(
      event.id,
      event.camera_id,
      event.camera_name || 'Camera ' + event.camera_id,
      event.timestamp || new Date().toISOString(),
      event.duration || 0,
      event.type || 'motion',
      event.confidence || 0,
      event.video_path,
      event.thumbnail_path || null,
      event.is_protected ? 1 : 0
    );
  },

  async getEvents(filter = {}) {
    let sql = 'SELECT * FROM events WHERE 1=1';
    const params = [];

    if (filter.type && filter.type !== 'all') {
      sql += ' AND type = ?';
      params.push(filter.type);
    }
    if (filter.camera_id) {
      sql += ' AND camera_id = ?';
      params.push(filter.camera_id);
    }
    if (filter.protected_only) {
      sql += ' AND is_protected = 1';
    }

    sql += ' ORDER BY timestamp DESC LIMIT ? OFFSET ?';
    params.push(filter.limit || 100, filter.offset || 0);

    const stmt = dbInstance.prepare(sql);
    return await stmt.all(...params);
  },

  async getEvent(id) {
    const stmt = dbInstance.prepare('SELECT * FROM events WHERE id = ?');
    return await stmt.get(id);
  },

  async toggleProtectEvent(id) {
    const event = await this.getEvent(id);
    if (!event) return null;
    const newStatus = event.is_protected === 1 ? 0 : 1;
    const stmt = dbInstance.prepare('UPDATE events SET is_protected = ? WHERE id = ?');
    await stmt.run(newStatus, id);
    return { ...event, is_protected: newStatus };
  },

  async deleteEvent(id) {
    const event = await this.getEvent(id);
    if (!event) return null;
    const stmt = dbInstance.prepare('DELETE FROM events WHERE id = ?');
    await stmt.run(id);
    return event;
  },

  async getUnprotectedEventsOlderThanDays(days) {
    const cutoffDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    const stmt = dbInstance.prepare('SELECT * FROM events WHERE is_protected = 0 AND timestamp < ? ORDER BY timestamp ASC');
    return await stmt.all(cutoffDate);
  },

  async getUnprotectedEventsForDiskCleanup() {
    const stmt = dbInstance.prepare('SELECT * FROM events WHERE is_protected = 0 ORDER BY timestamp ASC');
    return await stmt.all();
  },

  async getDailySummary() {
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const stmt = dbInstance.prepare('SELECT * FROM events WHERE timestamp >= ? ORDER BY timestamp DESC');
    const events = (await stmt.all(oneDayAgo)) || [];

    const summary = {
      total_today: events.length,
      by_type: { cat: 0, person: 0, dog: 0, vehicle: 0, motion: 0 },
      by_camera: {},
      hourly_distribution: new Array(24).fill(0),
      peak_hour: 'N/A'
    };

    let maxHourlyCount = 0;
    let peakHourIndex = -1;

    for (const evt of events) {
      if (summary.by_type[evt.type] !== undefined) {
        summary.by_type[evt.type]++;
      } else {
        summary.by_type[evt.type] = 1;
      }

      const camName = evt.camera_name || 'Camera ' + evt.camera_id;
      summary.by_camera[camName] = (summary.by_camera[camName] || 0) + 1;

      const hour = new Date(evt.timestamp).getHours();
      summary.hourly_distribution[hour]++;

      if (summary.hourly_distribution[hour] > maxHourlyCount) {
        maxHourlyCount = summary.hourly_distribution[hour];
        peakHourIndex = hour;
      }
    }

    if (peakHourIndex >= 0) {
      const ampm = peakHourIndex >= 12 ? 'PM' : 'AM';
      const formattedHour = (peakHourIndex % 12 || 12).toString().padStart(2, '0');
      summary.peak_hour = `${formattedHour}:00 ${ampm}`;
    }

    return summary;
  },

  async getAllSettings() {
    const stmt = dbInstance.prepare('SELECT * FROM settings');
    const rows = await stmt.all();
    const settings = {};
    for (const r of rows || []) {
      settings[r.key] = r.value;
    }
    return settings;
  },

  async updateSetting(key, value) {
    const stmt = dbInstance.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
    return await stmt.run(key, String(value));
  }
};
