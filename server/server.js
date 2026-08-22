const path = require('path');
const fs = require('fs');
const https = require('https');
const http = require('http');
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const { Server } = require('socket.io');

require('dotenv').config();

const { ensureCertificates } = require('../scripts/generate-cert');
const db = require('./db');
const storage = require('./storage');

const PORT = process.env.PORT || 8443;
const HTTP_PORT = process.env.HTTP_PORT || 8080;
const CERTS_PATH = process.env.CERTS_PATH || path.join(__dirname, '../certs');

// Ensure SSL Certificates exist or generate self-signed pems
const credentials = ensureCertificates(CERTS_PATH);

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve static frontend files
app.use(express.static(path.join(__dirname, '../public')));
// Serve recorded media clips and thumbnails
app.use('/media', express.static(storage.storageDir));

// Multer storage config for uploaded video clips
const multerStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, storage.clipsDir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || '.webm';
    const filename = `clip_${Date.now()}_${Math.random().toString(36).substr(2, 6)}${ext}`;
    cb(null, filename);
  }
});
const upload = multer({ storage: multerStorage });

// --- REST API ENDPOINTS ---

// Cameras API
app.get('/api/cameras', async (req, res) => {
  try {
    const cameras = await db.getAllCameras();
    res.json({ success: true, cameras });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.delete('/api/cameras/:id', async (req, res) => {
  try {
    const camId = req.params.id;
    await db.deleteCamera(camId);
    io.emit('camera_deleted', { id: camId });
    console.log(`🗑️ Removed camera node "${camId}" from server database`);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.put('/api/cameras/:id/rotate', async (req, res) => {
  try {
    const camId = req.params.id;
    const camera = await db.getCamera(camId);
    if (!camera) return res.status(404).json({error: 'Camera not found'});
    
    const newRotation = ((camera.rotation || 0) + 90) % 360;
    await db.updateCameraRotation(camId, newRotation);
    
    const updatedCam = await db.getCamera(camId);
    io.emit('camera_status_change', updatedCam);
    res.json({ success: true, rotation: newRotation });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.put('/api/cameras/:id/targets', async (req, res) => {
  try {
    const { targets } = req.body;
    await db.updateCameraTargets(req.params.id, targets);
    const camera = await db.getCamera(req.params.id);
    // Notify camera node of target config update
    io.to(`camera_${req.params.id}`).emit('update_targets', { targets });
    res.json({ success: true, camera });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.put('/api/targets/global', async (req, res) => {
  try {
    const { targets } = req.body;
    await db.updateSetting('global_targets', JSON.stringify(targets));

    const cameras = await db.getAllCameras();
    for (const cam of cameras) {
      await db.updateCameraTargets(cam.id, targets);
    }

    // Broadcast target update to all connected camera nodes
    io.emit('update_targets', { targets });
    console.log('🎯 Global Target Settings updated for all camera nodes:', targets);
    res.json({ success: true, targets });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Events API
app.get('/api/events', async (req, res) => {
  try {
    const { type, camera_id, protected_only, limit, offset } = req.query;
    const events = await db.getEvents({
      type,
      camera_id,
      protected_only: protected_only === 'true',
      limit: parseInt(limit || '100', 10),
      offset: parseInt(offset || '0', 10)
    });
    res.json({ success: true, events });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/events/summary', async (req, res) => {
  try {
    const summary = await db.getDailySummary();
    res.json({ success: true, summary });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/events/upload', upload.single('video'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, error: 'No video file provided' });
    }

    const { camera_id, camera_name, type, confidence, duration } = req.body;
    const clipFilename = req.file.filename;
    const relativeVideoPath = `/media/clips/${clipFilename}`;
    const absoluteVideoPath = req.file.path;

    const eventObj = {
      id: `evt_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
      camera_id: camera_id || 'unknown',
      camera_name: camera_name || 'Camera',
      timestamp: new Date().toISOString(),
      duration: parseInt(duration || '10', 10),
      type: type || 'motion',
      confidence: parseFloat(confidence || '0.8'),
      video_path: absoluteVideoPath,
      thumbnail_path: null,
      is_protected: 0
    };

    await db.addEvent(eventObj);

    // Format event response with web accessible URL
    const publicEvent = {
      ...eventObj,
      video_url: relativeVideoPath
    };

    // Broadcast new detection event to all viewer dashboard clients
    io.emit('new_event', publicEvent);

    console.log(`📹 New video event recorded: [${eventObj.type.toUpperCase()}] from camera "${eventObj.camera_name}" (${eventObj.id})`);
    res.json({ success: true, event: publicEvent });
  } catch (err) {
    console.error('Error saving uploaded clip:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/events/:id/toggle-protect', async (req, res) => {
  try {
    const updatedEvent = await db.toggleProtectEvent(req.params.id);
    if (!updatedEvent) {
      return res.status(404).json({ success: false, error: 'Event not found' });
    }
    // Broadcast update to dashboards
    io.emit('event_updated', updatedEvent);
    res.json({ success: true, event: updatedEvent });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.delete('/api/events/:id', async (req, res) => {
  try {
    const event = await db.getEvent(req.params.id);
    if (!event) {
      return res.status(404).json({ success: false, error: 'Event not found' });
    }
    storage.deleteClipFiles(event);
    await db.deleteEvent(req.params.id);
    io.emit('event_deleted', { id: req.params.id });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Settings API
app.get('/api/settings', async (req, res) => {
  try {
    const settings = await db.getAllSettings();
    res.json({ success: true, settings });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.put('/api/settings', async (req, res) => {
  try {
    const { settings } = req.body;
    for (const [key, value] of Object.entries(settings)) {
      await db.updateSetting(key, typeof value === 'object' ? JSON.stringify(value) : value);
    }
    const updated = await db.getAllSettings();
    io.emit('settings_updated', updated);
    res.json({ success: true, settings: updated });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Storage Stats API
app.get('/api/storage/stats', async (req, res) => {
  try {
    const stats = await storage.getStorageStats();
    res.json({ success: true, stats });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/retention/trigger', async (req, res) => {
  try {
    await storage.runRetentionCleanup();
    const stats = await storage.getStorageStats();
    res.json({ success: true, stats });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Create HTTPS Server
const httpsServer = https.createServer(credentials, app);
const io = new Server(httpsServer, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

// Socket.IO Real-Time WebRTC & Camera Signaling
io.on('connection', (socket) => {
  console.log(`🔌 Client connected: ${socket.id}`);

  // Camera Registration
  socket.on('register_camera', async (data) => {
    const { camera_id, name, resolution, battery_level } = data;
    socket.join(`camera_${camera_id}`);
    socket.data.camera_id = camera_id;
    socket.data.is_camera = true;

    await db.upsertCamera(camera_id, name || `Camera ${camera_id}`, resolution, battery_level);
    const camera = await db.getCamera(camera_id);

    // Immediately send target configuration to newly connected camera node
    if (camera && camera.enabled_targets) {
      socket.emit('update_targets', { targets: camera.enabled_targets });
    }

    console.log(`📱 Camera Node registered: "${camera.name}" (${camera_id}) with targets:`, camera.enabled_targets);
    io.emit('camera_status_change', camera);
  });

  // Camera Heartbeat
  socket.on('camera_heartbeat', async (data) => {
    const { camera_id, battery_level, status } = data;
    if (camera_id) {
      await db.updateCameraHeartbeat(camera_id, battery_level, status || 'online');
      const camera = await db.getCamera(camera_id);
      io.emit('camera_status_change', camera);
    }
  });

  // WebRTC Peer Signaling
  socket.on('request_stream', (data) => {
    const { camera_id } = data;
    console.log(`🎥 Viewer ${socket.id} requesting stream from camera ${camera_id}`);
    io.to(`camera_${camera_id}`).emit('start_peer_connection', { viewer_id: socket.id });
  });

  socket.on('webrtc_offer', (data) => {
    const { viewer_id, offer } = data;
    io.to(viewer_id).emit('webrtc_offer', {
      camera_id: socket.data.camera_id,
      offer
    });
  });

  socket.on('webrtc_answer', (data) => {
    const { camera_id, answer } = data;
    io.to(`camera_${camera_id}`).emit('webrtc_answer', {
      viewer_id: socket.id,
      answer
    });
  });

  socket.on('webrtc_ice_candidate', (data) => {
    const { target_id, candidate } = data;
    io.to(target_id).emit('webrtc_ice_candidate', {
      from_id: socket.id,
      candidate
    });
  });

  // Remote Camera Controls (Viewer -> Camera)
  socket.on('send_camera_control', (data) => {
    const { camera_id, command, payload } = data;
    console.log(`⚙️ Remote control sent to camera ${camera_id}: ${command}`);
    io.to(`camera_${camera_id}`).emit('camera_control', { command, payload });
  });

  socket.on('disconnect', async () => {
    if (socket.data.is_camera && socket.data.camera_id) {
      console.log(`📵 Camera Node disconnected: ${socket.data.camera_id}`);
      await db.updateCameraHeartbeat(socket.data.camera_id, -1, 'offline');
      const camera = await db.getCamera(socket.data.camera_id);
      io.emit('camera_status_change', camera);
    }
  });
});

// Start HTTPS Server
httpsServer.listen(PORT, '0.0.0.0', () => {
  console.log(`
=====================================================
🚀 HomeCam Server is RUNNING securely!
-----------------------------------------------------
🔒 HTTPS URL:  https://localhost:${PORT}
🔒 LAN Access: https://<YOUR-HOME-SERVER-IP>:${PORT}
📱 Camera Page: https://<YOUR-HOME-SERVER-IP>:${PORT}/camera.html
💻 Viewer Page: https://<YOUR-HOME-SERVER-IP>:${PORT}/index.html
=====================================================
  `);
});

// Optional HTTP -> HTTPS redirect server
if (HTTP_PORT && HTTP_PORT !== PORT) {
  const httpApp = express();
  httpApp.use((req, res) => {
    const host = req.headers.host ? req.headers.host.split(':')[0] : 'localhost';
    res.redirect(`https://${host}:${PORT}${req.url}`);
  });
  http.createServer(httpApp).listen(HTTP_PORT, '0.0.0.0', () => {
    console.log(`↪️ HTTP redirect server listening on port ${HTTP_PORT}`);
  });
}
