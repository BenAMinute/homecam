// HomeCam Viewer Dashboard Client Script

let socket = null;
let cameras = [];
let events = [];
let protectedEvents = [];
let activeFilter = 'all';
let currentPlayingEvent = null;
let peerConnections = {}; // camera_id -> { pc, pendingCandidates }

// DOM Elements
const tabBtns = document.querySelectorAll('.tab-btn');
const tabContents = document.querySelectorAll('.tab-content');
const cameraGrid = document.getElementById('cameraGrid');
const eventsGrid = document.getElementById('eventsGrid');
const protectedGrid = document.getElementById('protectedGrid');
const camCountChip = document.getElementById('camCountChip');
const storageChip = document.getElementById('storageChip');

// Modal Elements
const playerModal = document.getElementById('playerModal');
const modalVideoPlayer = document.getElementById('modalVideoPlayer');
const modalEventTitle = document.getElementById('modalEventTitle');
const modalEventTime = document.getElementById('modalEventTime');
const modalLockBtn = document.getElementById('modalLockBtn');
const modalDownloadBtn = document.getElementById('modalDownloadBtn');
const modalDeleteBtn = document.getElementById('modalDeleteBtn');
const modalCloseBtn = document.getElementById('modalCloseBtn');

// Initialize Dashboard
document.addEventListener('DOMContentLoaded', () => {
  initTabs();
  initFilters();
  initSocketConnection();
  fetchCameras();
  fetchEvents();
  fetchDailySummary();
  fetchStorageStats();
  initSettings();
});

// 1. Navigation Tabs
function initTabs() {
  tabBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const targetTab = btn.dataset.tab;
      tabBtns.forEach(b => b.classList.remove('active'));
      tabContents.forEach(c => c.classList.remove('active'));

      btn.classList.add('active');
      document.getElementById(`tab-${targetTab}`).classList.add('active');

      if (targetTab === 'events') {
        // Reset active filter to "all" when entering Detection Events tab
        activeFilter = 'all';
        const filterBtns = document.querySelectorAll('.filters-bar .filter-btn');
        filterBtns.forEach(f => f.classList.remove('active'));
        const allBtn = document.querySelector('.filters-bar .filter-btn[data-filter="all"]');
        if (allBtn) allBtn.classList.add('active');
        renderEvents();
        fetchDailySummary();
      } else if (targetTab === 'protected') {
        renderProtectedEvents();
      }
    });
  });
}

// 2. Event Filters (Scoped specifically to .filters-bar)
function initFilters() {
  const filterBtns = document.querySelectorAll('.filters-bar .filter-btn');
  filterBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      filterBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      activeFilter = btn.dataset.filter || 'all';
      renderEvents();
    });
  });
}

// 3. Socket.IO Real-time Connection
function initSocketConnection() {
  socket = io();

  socket.on('connect', () => {
    console.log('✅ Dashboard connected to HomeCam Server');
  });

  socket.on('camera_status_change', (camera) => {
    fetchCameras();
  });

  socket.on('camera_deleted', (data) => {
    fetchCameras();
  });

  socket.on('new_event', (eventObj) => {
    console.log('🔔 New detection event received:', eventObj);
    events.unshift(eventObj);
    renderEvents();
    renderProtectedEvents();
    fetchDailySummary();
    fetchStorageStats();
  });

  socket.on('event_updated', (updatedEvt) => {
    const idx = events.findIndex(e => e.id === updatedEvt.id);
    if (idx !== -1) {
      events[idx] = updatedEvt;
      renderEvents();
      renderProtectedEvents();
      fetchDailySummary();
    }
  });

  socket.on('event_deleted', (data) => {
    events = events.filter(e => e.id !== data.id);
    renderEvents();
    renderProtectedEvents();
    fetchDailySummary();
    fetchStorageStats();
  });

  // WebRTC Signaling Receivers from Camera
  socket.on('webrtc_offer', async (data) => {
    const { camera_id, offer } = data;
    console.log(`📥 Received WebRTC Offer from camera ${camera_id}`);

    const conn = peerConnections[camera_id];
    if (conn && conn.pc) {
      await conn.pc.setRemoteDescription(new RTCSessionDescription(offer));

      // Flush any queued candidates
      while (conn.pendingCandidates.length > 0) {
        const cand = conn.pendingCandidates.shift();
        await conn.pc.addIceCandidate(new RTCIceCandidate(cand));
      }

      const answer = await conn.pc.createAnswer();
      await conn.pc.setLocalDescription(answer);

      socket.emit('webrtc_answer', {
        camera_id,
        answer
      });
    }
  });

  socket.on('webrtc_ice_candidate', async (data) => {
    const { from_id, candidate } = data;
    const camera = cameras.find(c => `camera_${c.id}` === from_id || c.id === from_id);
    const cameraId = camera ? camera.id : Object.keys(peerConnections)[0];

    const conn = peerConnections[cameraId];
    if (conn && conn.pc && candidate) {
      if (conn.pc.remoteDescription) {
        await conn.pc.addIceCandidate(new RTCIceCandidate(candidate));
      } else {
        conn.pendingCandidates.push(candidate);
      }
    }
  });
}

// 4. Cameras & WebRTC Live Feeds
async function fetchCameras() {
  try {
    const res = await fetch('/api/cameras');
    const data = await res.json();
    if (data.success) {
      cameras = data.cameras;
      renderCameraGrid();
      const onlineCount = cameras.filter(c => c.status === 'online').length;
      camCountChip.textContent = `📱 ${onlineCount} Camera(s) Online`;
    }
  } catch (err) {
    console.error('Error fetching cameras:', err);
  }
}

function renderCameraGrid() {
  if (cameras.length === 0) {
    cameraGrid.innerHTML = `
      <div style="grid-column: 1/-1; padding: 40px; text-align: center; color: var(--text-muted);">
        <h3>No Camera Nodes Registered Yet</h3>
        <p style="margin-top: 8px;">Open <code style="color: var(--accent-primary);">https://&lt;server-ip&gt;:8443/camera.html</code> on an old phone to connect your first camera.</p>
      </div>
    `;
    return;
  }

  cameraGrid.innerHTML = cameras.map(cam => {
    const batText = cam.battery_level >= 0 ? `🔋 ${cam.battery_level}%` : '⚡ Plugged In';
    return `
      <div class="camera-card" id="cam-card-${cam.id}">
        <div class="camera-header">
          <div class="camera-title">
            <span style="width: 10px; height: 10px; border-radius: 50%; background: ${cam.status === 'online' ? '#22c55e' : '#ef4444'}; display: inline-block;"></span>
            ${cam.name}
          </div>
          <span class="meta-chip">${cam.resolution}</span>
        </div>
        <div class="video-wrapper">
          ${cam.status === 'online'
            ? `<video id="video-feed-${cam.id}" autoplay playsinline muted></video>`
            : `<div class="camera-offline-msg">📱 Camera Offline</div>`
          }
        </div>
        <div class="camera-footer">
          <span style="font-size: 0.85rem; color: var(--text-muted);">${cam.status === 'online' ? batText : 'Offline'}</span>
          <div style="display: flex; gap: 6px; align-items: center;">
            ${cam.status === 'online' ? `
              <button class="filter-btn" style="padding: 6px 10px; font-size: 0.8rem;" onclick="sendControl('${cam.id}', 'toggle_torch')">💡 Torch</button>
              <button class="filter-btn" style="padding: 6px 10px; font-size: 0.8rem;" onclick="sendControl('${cam.id}', 'switch_lens')">🔄 Flip</button>
            ` : ''}
            <button class="filter-btn" style="padding: 6px 10px; font-size: 0.8rem; border-color: rgba(244, 63, 94, 0.4); color: #fda4af;" onclick="removeCamera('${cam.id}', '${cam.name}')">🗑️ Remove</button>
          </div>
        </div>
      </div>
    `;
  }).join('');

  // Setup WebRTC stream connections for online cameras
  cameras.forEach(cam => {
    if (cam.status === 'online') {
      subscribeToWebRTCStream(cam.id);
    }
  });
}

function subscribeToWebRTCStream(cameraId) {
  if (peerConnections[cameraId] && peerConnections[cameraId].pc) {
    peerConnections[cameraId].pc.close();
  }

  const pc = new RTCPeerConnection({
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' }
    ]
  });

  peerConnections[cameraId] = { pc, pendingCandidates: [] };

  pc.ontrack = (event) => {
    console.log(`📺 WebRTC Track received for camera ${cameraId}`);
    const videoEl = document.getElementById(`video-feed-${cameraId}`);
    if (videoEl && event.streams[0]) {
      videoEl.srcObject = event.streams[0];
      videoEl.play().catch(e => console.warn('Autoplay error:', e));
    }
  };

  pc.onicecandidate = (event) => {
    if (event.candidate) {
      socket.emit('webrtc_ice_candidate', {
        target_id: `camera_${cameraId}`,
        candidate: event.candidate
      });
    }
  };

  socket.emit('request_stream', { camera_id: cameraId });
}

window.sendControl = function(cameraId, command) {
  if (socket) {
    console.log(`Sending remote command to ${cameraId}:`, command);
    socket.emit('send_camera_control', { camera_id: cameraId, command });
  }
};

window.removeCamera = async function(cameraId, cameraName) {
  if (confirm(`Are you sure you want to remove camera "${cameraName}" from your home server?`)) {
    try {
      const res = await fetch(`/api/cameras/${cameraId}`, { method: 'DELETE' });
      const data = await res.json();
      if (data.success) {
        if (peerConnections[cameraId] && peerConnections[cameraId].pc) {
          peerConnections[cameraId].pc.close();
          delete peerConnections[cameraId];
        }
        fetchCameras();
      }
    } catch (err) {
      console.error('Error removing camera:', err);
    }
  }
};

// 5. Daily Summary & Analytics
async function fetchDailySummary() {
  try {
    const res = await fetch('/api/events/summary');
    const data = await res.json();
    if (data.success && data.summary) {
      renderDailySummary(data.summary);
    }
  } catch (err) {
    console.error('Error fetching summary:', err);
  }
}

function renderDailySummary(summary) {
  const kpiTotal = document.getElementById('kpiTotalToday');
  const kpiCats = document.getElementById('kpiCatsToday');
  const kpiHumans = document.getElementById('kpiHumansToday');
  const kpiMotion = document.getElementById('kpiMotionToday');
  const peakChip = document.getElementById('peakHourChip');
  const hourlyBarsContainer = document.getElementById('hourlyBars');

  if (kpiTotal) kpiTotal.textContent = summary.total_today || 0;
  if (kpiCats) kpiCats.textContent = summary.by_type ? (summary.by_type.cat || 0) : 0;
  if (kpiHumans) kpiHumans.textContent = summary.by_type ? (summary.by_type.person || 0) : 0;
  if (kpiMotion) kpiMotion.textContent = summary.by_type ? (summary.by_type.motion || 0) : 0;
  if (peakChip) peakChip.textContent = `🕒 Peak Hour: ${summary.peak_hour || 'N/A'}`;

  if (hourlyBarsContainer && summary.hourly_distribution) {
    const maxVal = Math.max(...summary.hourly_distribution, 1);
    hourlyBarsContainer.innerHTML = summary.hourly_distribution.map((count, hour) => {
      const heightPct = Math.max((count / maxVal) * 100, 8);
      const isPeak = count === maxVal && count > 0;
      const ampm = hour >= 12 ? 'PM' : 'AM';
      const formattedHour = (hour % 12 || 12) + ampm;
      return `<div class="bar-col ${isPeak ? 'active-peak' : ''}" style="height: ${heightPct}%;" title="${formattedHour}: ${count} event(s)"></div>`;
    }).join('');
  }
}

// 6. Events Timeline & Gallery
async function fetchEvents() {
  try {
    const res = await fetch('/api/events');
    const data = await res.json();
    if (data.success) {
      events = data.events;
      renderEvents();
      renderProtectedEvents();
    }
  } catch (err) {
    console.error('Error fetching events:', err);
  }
}

function renderEvents() {
  const filtered = events.filter(evt => {
    if (activeFilter === 'all') return true;
    return evt.type === activeFilter;
  });

  if (filtered.length === 0) {
    eventsGrid.innerHTML = `
      <div style="grid-column: 1/-1; padding: 40px; text-align: center; color: var(--text-muted);">
        <p>No detection events recorded matching "${activeFilter}".</p>
      </div>
    `;
    return;
  }

  eventsGrid.innerHTML = filtered.map(evt => createEventCardHTML(evt)).join('');
}

function renderProtectedEvents() {
  protectedEvents = events.filter(evt => evt.is_protected === 1);

  if (protectedEvents.length === 0) {
    protectedGrid.innerHTML = `
      <div style="grid-column: 1/-1; padding: 40px; text-align: center; color: var(--text-muted);">
        <p>🔒 No protected videos yet. Click the lock icon on any video to protect it from auto-cleanup.</p>
      </div>
    `;
    return;
  }

  protectedGrid.innerHTML = protectedEvents.map(evt => createEventCardHTML(evt)).join('');
}

function createEventCardHTML(evt) {
  const videoUrl = evt.video_url || `/media/clips/${evt.video_path.split('/').pop()}`;
  const iconMap = { cat: '🐱 Cat', dog: '🐶 Dog', person: '👤 Human', vehicle: '🚗 Vehicle', motion: '🏃 Motion' };
  const formattedTime = new Date(evt.timestamp).toLocaleString();

  return `
    <div class="event-card" onclick="openPlayerModal('${evt.id}')">
      <div class="event-thumb">
        <video src="${videoUrl}#t=0.5" preload="metadata" muted playsinline></video>
        <div class="play-overlay">▶</div>
      </div>
      <div class="event-info">
        <div class="event-meta-row">
          <span class="event-type-badge ${evt.type}">${iconMap[evt.type] || evt.type}</span>
          <button class="lock-btn ${evt.is_protected ? 'protected' : ''}" onclick="event.stopPropagation(); toggleLock('${evt.id}')" title="Protect Video from Deletion">
            ${evt.is_protected ? '🔒' : '🔓'}
          </button>
        </div>
        <div style="font-weight: 600; font-size: 0.95rem; color: #fff;">${evt.camera_name}</div>
        <div style="font-size: 0.8rem; color: var(--text-muted);">${formattedTime}</div>
      </div>
    </div>
  `;
}

// 7. Video Player Modal
window.openPlayerModal = function(eventId) {
  const evt = events.find(e => e.id === eventId);
  if (!evt) return;

  currentPlayingEvent = evt;
  const videoUrl = evt.video_url || `/media/clips/${evt.video_path.split('/').pop()}`;

  modalVideoPlayer.src = videoUrl;
  modalVideoPlayer.load();
  modalEventTitle.textContent = `${evt.type.toUpperCase()} Event - ${evt.camera_name}`;
  modalEventTime.textContent = new Date(evt.timestamp).toLocaleString();
  modalDownloadBtn.href = videoUrl;

  updateModalLockUI();
  playerModal.classList.add('active');
  modalVideoPlayer.play().catch(e => console.log('Autoplay deferred:', e));
};

function updateModalLockUI() {
  if (currentPlayingEvent) {
    modalLockBtn.innerHTML = currentPlayingEvent.is_protected ? '🔒 Protected' : '🔓 Unlocked';
    modalLockBtn.style.color = currentPlayingEvent.is_protected ? 'var(--accent-amber)' : 'var(--text-muted)';
  }
}

modalCloseBtn.addEventListener('click', () => {
  playerModal.classList.remove('active');
  modalVideoPlayer.pause();
  modalVideoPlayer.src = '';
});

window.toggleLock = async function(eventId) {
  try {
    const res = await fetch(`/api/events/${eventId}/toggle-protect`, { method: 'POST' });
    const data = await res.json();
    if (data.success) {
      const idx = events.findIndex(e => e.id === eventId);
      if (idx !== -1) {
        events[idx] = data.event;
        if (currentPlayingEvent && currentPlayingEvent.id === eventId) {
          currentPlayingEvent = data.event;
          updateModalLockUI();
        }
        renderEvents();
        renderProtectedEvents();
        fetchDailySummary();
      }
    }
  } catch (err) {
    console.error('Error toggling lock:', err);
  }
};

modalLockBtn.addEventListener('click', () => {
  if (currentPlayingEvent) {
    toggleLock(currentPlayingEvent.id);
  }
});

modalDeleteBtn.addEventListener('click', async () => {
  if (!currentPlayingEvent) return;
  if (confirm('Are you sure you want to permanently delete this clip?')) {
    try {
      const res = await fetch(`/api/events/${currentPlayingEvent.id}`, { method: 'DELETE' });
      const data = await res.json();
      if (data.success) {
        events = events.filter(e => e.id !== currentPlayingEvent.id);
        playerModal.classList.remove('active');
        modalVideoPlayer.pause();
        renderEvents();
        renderProtectedEvents();
        fetchDailySummary();
        fetchStorageStats();
      }
    } catch (err) {
      console.error('Error deleting clip:', err);
    }
  }
});

// 8. System Storage & Settings
async function fetchStorageStats() {
  try {
    const res = await fetch('/api/storage/stats');
    const data = await res.json();
    if (data.success) {
      const stats = data.stats;
      storageChip.textContent = `💾 ${stats.total_mb} MB / ${stats.total_clips} Clips (${stats.protected_clips} 🔒)`;
    }
  } catch (err) {
    console.error('Error fetching storage stats:', err);
  }
}

async function initSettings() {
  try {
    const res = await fetch('/api/settings');
    const data = await res.json();
    if (data.success && data.settings) {
      const recEnabled = data.settings.recording_enabled !== '0';
      const toggleEl = document.getElementById('masterRecordingToggle');
      if (toggleEl) toggleEl.checked = recEnabled;
    }
  } catch (e) {
    console.warn('Error loading settings:', e);
  }

  const masterToggle = document.getElementById('masterRecordingToggle');
  if (masterToggle) {
    masterToggle.addEventListener('change', async () => {
      const enabled = masterToggle.checked;
      await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ settings: { recording_enabled: enabled ? '1' : '0' } })
      });
      cameras.forEach(cam => {
        if (socket) {
          socket.emit('send_camera_control', { camera_id: cam.id, command: 'toggle_recording' });
        }
      });
    });
  }

  document.getElementById('btnSaveTargetSettings').addEventListener('click', async () => {
    const targets = [];
    if (document.getElementById('targetCat').checked) targets.push('cat');
    if (document.getElementById('targetPerson').checked) targets.push('person');
    if (document.getElementById('targetDog').checked) targets.push('dog');
    if (document.getElementById('targetVehicle').checked) targets.push('vehicle');
    if (document.getElementById('targetMotion').checked) targets.push('motion');

    for (const cam of cameras) {
      await fetch(`/api/cameras/${cam.id}/targets`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targets })
      });
    }
    alert('✅ AI Target Detection Settings updated for all camera nodes!');
  });

  document.getElementById('btnSaveStorageSettings').addEventListener('click', async () => {
    const retention_days = document.getElementById('inputRetentionDays').value;
    const max_storage_gb = document.getElementById('inputMaxStorageGB').value;

    await fetch('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ settings: { retention_days, max_storage_gb } })
    });
    alert('✅ Storage retention settings updated successfully!');
  });

  document.getElementById('btnTriggerCleanup').addEventListener('click', async () => {
    const res = await fetch('/api/retention/trigger', { method: 'POST' });
    const data = await res.json();
    if (data.success) {
      alert('🧹 Manual auto-cleanup completed successfully!');
      fetchEvents();
      fetchDailySummary();
      fetchStorageStats();
    }
  });
}
