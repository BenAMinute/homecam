// HomeCam Viewer Dashboard Client Script

let socket = null;
let cameras = [];
let events = [];
let protectedEvents = [];
let activeFilter = 'all';
let currentPlayingEvent = null;
let peerConnections = {}; // camera_id -> RTCPeerConnection

// DOM Elements
const tabBtns = document.querySelectorAll('.tab-btn');
const tabContents = document.querySelectorAll('.tab-content');
const cameraGrid = document.getElementById('cameraGrid');
const eventsGrid = document.getElementById('eventsGrid');
const protectedGrid = document.getElementById('protectedGrid');
const filterBtns = document.querySelectorAll('.filter-btn');
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

      if (targetTab === 'protected') {
        renderProtectedEvents();
      }
    });
  });
}

// 2. Event Filters
function initFilters() {
  filterBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      filterBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      activeFilter = btn.dataset.filter;
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

  socket.on('new_event', (eventObj) => {
    console.log('🔔 New detection event received:', eventObj);
    events.unshift(eventObj);
    renderEvents();
    renderProtectedEvents();
    fetchStorageStats();
  });

  socket.on('event_updated', (updatedEvt) => {
    const idx = events.findIndex(e => e.id === updatedEvt.id);
    if (idx !== -1) {
      events[idx] = updatedEvt;
      renderEvents();
      renderProtectedEvents();
    }
  });

  socket.on('event_deleted', (data) => {
    events = events.filter(e => e.id !== data.id);
    renderEvents();
    renderProtectedEvents();
    fetchStorageStats();
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

  cameraGrid.innerHTML = cameras.map(cam => `
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
        <span style="font-size: 0.85rem; color: var(--text-muted);">${cam.battery_level >= 0 ? '🔋 ' + cam.battery_level + '%' : ''}</span>
        ${cam.status === 'online' ? `
          <div style="display: flex; gap: 6px;">
            <button class="filter-btn" onclick="sendControl('${cam.id}', 'toggle_torch')">💡 Torch</button>
            <button class="filter-btn" onclick="sendControl('${cam.id}', 'switch_lens')">🔄 Flip</button>
          </div>
        ` : ''}
      </div>
    </div>
  `).join('');

  // Setup WebRTC stream connections for online cameras
  cameras.forEach(cam => {
    if (cam.status === 'online') {
      subscribeToWebRTCStream(cam.id);
    }
  });
}

function subscribeToWebRTCStream(cameraId) {
  if (peerConnections[cameraId]) {
    peerConnections[cameraId].close();
  }

  const pc = new RTCPeerConnection({
    iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
  });
  peerConnections[cameraId] = pc;

  pc.ontrack = (event) => {
    const videoEl = document.getElementById(`video-feed-${cameraId}`);
    if (videoEl && event.streams[0]) {
      videoEl.srcObject = event.streams[0];
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

  // Signal camera node to start WebRTC offer
  socket.emit('request_stream', { camera_id: cameraId });
}

window.sendControl = function(cameraId, command) {
  if (socket) {
    socket.emit('send_camera_control', { camera_id: cameraId, command });
  }
};

// 5. Events Timeline & Gallery
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
        <video src="${videoUrl}#t=0.5" preload="metadata" muted></video>
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

// 6. Video Player Modal
window.openPlayerModal = function(eventId) {
  const evt = events.find(e => e.id === eventId);
  if (!evt) return;

  currentPlayingEvent = evt;
  const videoUrl = evt.video_url || `/media/clips/${evt.video_path.split('/').pop()}`;

  modalVideoPlayer.src = videoUrl;
  modalEventTitle.textContent = `${evt.type.toUpperCase()} Event - ${evt.camera_name}`;
  modalEventTime.textContent = new Date(evt.timestamp).toLocaleString();
  modalDownloadBtn.href = videoUrl;

  updateModalLockUI();
  playerModal.classList.add('active');
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
        fetchStorageStats();
      }
    } catch (err) {
      console.error('Error deleting clip:', err);
    }
  }
});

// 7. System Storage & Settings
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
  document.getElementById('btnSaveTargetSettings').addEventListener('click', async () => {
    const targets = [];
    if (document.getElementById('targetCat').checked) targets.push('cat');
    if (document.getElementById('targetPerson').checked) targets.push('person');
    if (document.getElementById('targetDog').checked) targets.push('dog');
    if (document.getElementById('targetVehicle').checked) targets.push('vehicle');
    if (document.getElementById('targetMotion').checked) targets.push('motion');

    // Update setting globally for all connected cameras
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
      fetchStorageStats();
    }
  });
}
