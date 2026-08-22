const path = require('path');
const fs = require('fs');
const db = require('./db');

const storageDir = process.env.STORAGE_PATH || path.join(__dirname, '../media');
const clipsDir = path.join(storageDir, 'clips');
const thumbsDir = path.join(storageDir, 'thumbnails');

// Ensure storage paths exist
[storageDir, clipsDir, thumbsDir].forEach(dir => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
});

function getFolderSize(dirPath) {
  let size = 0;
  if (!fs.existsSync(dirPath)) return 0;
  const files = fs.readdirSync(dirPath);
  for (const file of files) {
    const filePath = path.join(dirPath, file);
    const stat = fs.statSync(filePath);
    if (stat.isDirectory()) {
      size += getFolderSize(filePath);
    } else {
      size += stat.size;
    }
  }
  return size;
}

function removeFileSafely(filePath) {
  try {
    if (filePath && fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } catch (err) {
    console.error(`⚠️ Error removing file ${filePath}:`, err.message);
  }
}

async function runRetentionCleanup() {
  const settings = await db.getAllSettings();
  const retentionDays = parseInt(settings.retention_days || '14', 10);
  const maxStorageGB = parseFloat(settings.max_storage_gb || '50');
  const maxStorageBytes = maxStorageGB * 1024 * 1024 * 1024;

  let cleanedCount = 0;

  // 1. Purge unprotected clips older than retentionDays
  if (retentionDays > 0) {
    const expiredEvents = await db.getUnprotectedEventsOlderThanDays(retentionDays);
    for (const evt of expiredEvents) {
      console.log(`🧹 Auto-retention: Purging expired clip ${evt.id} (${evt.timestamp})`);
      removeFileSafely(evt.video_path);
      if (evt.thumbnail_path) removeFileSafely(evt.thumbnail_path);
      await db.deleteEvent(evt.id);
      cleanedCount++;
    }
  }

  // 2. Check total disk usage and purge oldest unprotected clips if over max storage cap
  let currentUsage = getFolderSize(clipsDir);
  if (maxStorageBytes > 0 && currentUsage > maxStorageBytes) {
    console.log(`⚠️ Disk usage (${(currentUsage / (1024 ** 3)).toFixed(2)} GB) exceeds quota (${maxStorageGB} GB). Pruning oldest unprotected clips...`);
    const unprotectedEvents = await db.getUnprotectedEventsForDiskCleanup();

    for (const evt of unprotectedEvents) {
      if (currentUsage <= maxStorageBytes * 0.9) break; // Clean down to 90% quota
      console.log(`🧹 Quota retention: Purging clip ${evt.id}`);
      removeFileSafely(evt.video_path);
      if (evt.thumbnail_path) removeFileSafely(evt.thumbnail_path);
      await db.deleteEvent(evt.id);
      cleanedCount++;
      currentUsage = getFolderSize(clipsDir);
    }
  }

  if (cleanedCount > 0) {
    console.log(`✅ Retention worker complete: Pruned ${cleanedCount} unprotected clip(s).`);
  }
}

// Run cleanup check every 1 hour
setInterval(async () => {
  try {
    await runRetentionCleanup();
  } catch (e) {
    console.error('Error during scheduled retention cleanup:', e);
  }
}, 60 * 60 * 1000);

module.exports = {
  storageDir,
  clipsDir,
  thumbsDir,
  runRetentionCleanup,

  async getStorageStats() {
    const totalBytes = getFolderSize(clipsDir);
    const events = await db.getEvents({ limit: 10000 });
    const protectedCount = (events || []).filter(e => e.is_protected === 1).length;

    return {
      total_bytes: totalBytes,
      total_mb: (totalBytes / (1024 * 1024)).toFixed(2),
      total_gb: (totalBytes / (1024 * 1024 * 1024)).toFixed(2),
      total_clips: (events || []).length,
      protected_clips: protectedCount
    };
  },

  deleteClipFiles(event) {
    if (event) {
      removeFileSafely(event.video_path);
      if (event.thumbnail_path) removeFileSafely(event.thumbnail_path);
    }
  }
};
