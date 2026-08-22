// HomeCam Smartphone Camera Node Script

let socket = null;
let mediaStream = null;
let peerConnections = {}; // viewer_id -> { pc, pendingCandidates }
let wakeLock = null;
let cocoModel = null;
let isTorchOn = false;
let currentBatteryLevel = 100;
let isCharging = true;
let isRecordingEnabled = true; // Master toggle for motion event recording

let cameraId = localStorage.getItem('homecam_id') || `cam_${Math.random().toString(36).substr(2, 6)}`;
let cameraName = localStorage.getItem('homecam_name') || 'Phone Camera 1';
let facingMode = localStorage.getItem('homecam_facing') || 'environment';
let resolution = localStorage.getItem('homecam_res') || '720p';

let enabledTargets = ['cat', 'person', 'motion']; // default targets
let confidenceThreshold = 0.60;

// MediaRecorder Ring Buffer state
let mediaRecorder = null;
let recordedChunks = [];
let preRollBuffer = []; // stores last 5 seconds of chunks
let isRecordingEvent = false;
let lastEventUploadTime = 0;
let activeMimeType = '';

// Canvas Frame Differencing for Motion Detection
let lastFrameData = null;
const motionCanvas = document.getElementById('motionCanvas');
const motionCtx = motionCanvas.getContext('2d', { willReadFrequently: true });

// DOM Elements
const videoEl = document.getElementById('cameraVideo');
const setupModal = document.getElementById('setupModal');
const inputCamId = document.getElementById('inputCamId');
const selectFacing = document.getElementById('selectFacing');
const selectRes = document.getElementById('selectRes');
const btnSaveSetup = document.getElementById('btnSaveSetup');
const btnStealth = document.getElementById('btnStealth');
const stealthOverlay = document.getElementById('stealthOverlay');
const btnFlipCam = document.getElementById('btnFlipCam');
const btnTorchLocal = document.getElementById('btnTorchLocal');
const btnPauseRecord = document.getElementById('btnPauseRecord');
const btnSettings = document.getElementById('btnSettings');
const statusDot = document.getElementById('statusDot');
const camNameLabel = document.getElementById('camNameLabel');
const batteryBadge = document.getElementById('batteryBadge');
const activeTargetsList = document.getElementById('activeTargetsList');

// 1. Screen Wake Lock API (Keeps Screen & CPU Awake)
async function requestWakeLock() {
  try {
    if ('wakeLock' in navigator) {
      wakeLock = await navigator.wakeLock.request('screen');
      console.log('💡 Screen Wake Lock active (prevents sleep)');
      wakeLock.addEventListener('release', () => {
        console.log('⚠️ Screen Wake Lock released');
      });
    }
  } catch (err) {
    console.warn('Screen Wake Lock error:', err.message);
  }
}

document.addEventListener('visibilitychange', async () => {
  if (wakeLock !== null && document.visibilityState === 'visible') {
    await requestWakeLock();
  }
});

// 2. Stealth Dimmer / Blackout Screen Controller
btnStealth.addEventListener('click', () => {
  stealthOverlay.classList.add('active');
});

stealthOverlay.addEventListener('click', () => {
  stealthOverlay.classList.remove('active');
});

// 3. Camera Setup & Controls
inputCamId.value = cameraName;
selectFacing.value = facingMode;
selectRes.value = resolution;

if (localStorage.getItem('homecam_configured')) {
  setupModal.style.display = 'none';
  startCameraNode();
}

btnSettings.addEventListener('click', () => {
  setupModal.style.display = 'flex';
});

btnSaveSetup.addEventListener('click', () => {
  cameraName = inputCamId.value.trim() || 'Camera Node';
  facingMode = selectFacing.value;
  resolution = selectRes.value;

  localStorage.setItem('homecam_name', cameraName);
  localStorage.setItem('homecam_facing', facingMode);
  localStorage.setItem('homecam_res', resolution);
  localStorage.setItem('homecam_configured', 'true');

  setupModal.style.display = 'none';
  startCameraNode();
});

btnFlipCam.addEventListener('click', async () => {
  facingMode = facingMode === 'environment' ? 'user' : 'environment';
  localStorage.setItem('homecam_facing', facingMode);
  selectFacing.value = facingMode;
  await initCameraStream();
});

if (btnTorchLocal) {
  btnTorchLocal.addEventListener('click', async () => {
    await toggleTorch();
  });
}

if (btnPauseRecord) {
  btnPauseRecord.addEventListener('click', () => {
    isRecordingEnabled = !isRecordingEnabled;
    updateRecordingUI();
  });
}

function updateRecordingUI() {
  if (btnPauseRecord) {
    btnPauseRecord.textContent = isRecordingEnabled ? '🔴 Recording ON' : '⏸️ Recording OFF';
    btnPauseRecord.style.background = isRecordingEnabled ? '' : 'rgba(245, 158, 11, 0.35)';
    btnPauseRecord.style.borderColor = isRecordingEnabled ? '' : 'rgba(245, 158, 11, 0.6)';
  }
  renderActiveTargetBadges();
}

// 4. Initialize Camera Stream & TensorFlow AI
async function startCameraNode() {
  camNameLabel.textContent = cameraName;
  await requestWakeLock();
  await initCameraStream();
  initSocketConnection();
  loadAIModel();
  startBatteryMonitoring();
}

async function initCameraStream() {
  if (mediaStream) {
    mediaStream.getTracks().forEach(track => track.stop());
  }

  const resMap = {
    '1080p': { width: 1920, height: 1080 },
    '720p': { width: 1280, height: 720 },
    '480p': { width: 640, height: 480 }
  };
  const targetRes = resMap[resolution] || resMap['720p'];

  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { ideal: facingMode },
        width: { ideal: targetRes.width },
        height: { ideal: targetRes.height }
      },
      audio: true
    });

    videoEl.srcObject = mediaStream;
    await videoEl.play();
    console.log(`🎥 Camera stream active (${resolution}, ${facingMode})`);

    isTorchOn = false;
    initPreRollRecorder();
    startMotionDetectionLoop();
  } catch (err) {
    console.error('Camera access error:', err);
    alert('Unable to access camera hardware. Please ensure camera permissions are allowed and HTTPS is active.');
  }
}

// Flashlight / Torch Controller
async function toggleTorch(forceState) {
  if (!mediaStream) return false;
  const track = mediaStream.getVideoTracks()[0];
  if (!track) return false;

  try {
    const capabilities = track.getCapabilities ? track.getCapabilities() : {};
    if ('torch' in capabilities || capabilities.torch) {
      isTorchOn = forceState !== undefined ? forceState : !isTorchOn;
      await track.applyConstraints({
        advanced: [{ torch: isTorchOn }]
      });
      console.log('💡 Flashlight / Torch toggled:', isTorchOn);
      if (btnTorchLocal) {
        btnTorchLocal.style.background = isTorchOn ? 'var(--accent-amber, #f59e0b)' : '';
      }
      return isTorchOn;
    } else {
      console.warn('Torch control is not supported by this camera lens or browser.');
      alert('Torch/Flashlight is not supported on this camera lens (usually only rear camera supports flash).');
      return false;
    }
  } catch (err) {
    console.error('Error toggling torch:', err);
    return false;
  }
}

// 5. Real Battery Monitoring & Heartbeat
async function startBatteryMonitoring() {
  const updateBatteryUI = (pct, charging) => {
    currentBatteryLevel = pct;
    isCharging = charging;
    batteryBadge.textContent = `${charging ? '⚡' : '🔋'} ${pct}%`;
  };

  if ('getBattery' in navigator) {
    try {
      const battery = await navigator.getBattery();
      const onBatteryChange = () => {
        const pct = Math.round(battery.level * 100);
        updateBatteryUI(pct, battery.charging);
        sendHeartbeat();
      };
      onBatteryChange();
      battery.addEventListener('levelchange', onBatteryChange);
      battery.addEventListener('chargingchange', onBatteryChange);
    } catch (e) {
      console.warn('Battery API error:', e);
      updateBatteryUI(100, true);
    }
  } else {
    // iOS Safari fallback
    updateBatteryUI(100, true);
    batteryBadge.textContent = '⚡ Connected';
  }

  setInterval(sendHeartbeat, 10000);
}

function sendHeartbeat() {
  if (socket && socket.connected) {
    socket.emit('camera_heartbeat', {
      camera_id: cameraId,
      battery_level: currentBatteryLevel,
      status: 'online'
    });
  }
}

// 6. Socket.IO & WebRTC Streaming Hub
function initSocketConnection() {
  socket = io();

  socket.on('connect', () => {
    console.log('✅ Connected to HomeCam Server via Socket.IO');
    statusDot.classList.add('online');

    socket.emit('register_camera', {
      camera_id: cameraId,
      name: cameraName,
      resolution: resolution,
      battery_level: currentBatteryLevel
    });
  });

  socket.on('disconnect', () => {
    console.warn('❌ Disconnected from server');
    statusDot.classList.remove('online');
  });

  // Remote Target Config Update
  socket.on('update_targets', (data) => {
    if (data.targets) {
      enabledTargets = data.targets;
      renderActiveTargetBadges();
    }
  });

  socket.on('update_recording_mode', (data) => {
    if (data.enabled !== undefined) {
      isRecordingEnabled = data.enabled;
      updateRecordingUI();
    }
  });

  // Remote Commands from Viewer Dashboard
  socket.on('camera_control', async (data) => {
    console.log('Received remote command:', data);
    if (data.command === 'toggle_torch') {
      await toggleTorch();
    } else if (data.command === 'switch_lens') {
      facingMode = facingMode === 'environment' ? 'user' : 'environment';
      await initCameraStream();
    } else if (data.command === 'toggle_recording') {
      isRecordingEnabled = !isRecordingEnabled;
      updateRecordingUI();
    }
  });

  // WebRTC Live Video Streaming to Viewers
  socket.on('start_peer_connection', async (data) => {
    const { viewer_id } = data;
    console.log(`📡 Creating WebRTC connection for viewer ${viewer_id}`);

    if (peerConnections[viewer_id] && peerConnections[viewer_id].pc) {
      peerConnections[viewer_id].pc.close();
    }

    const pc = new RTCPeerConnection({
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' }
      ]
    });

    peerConnections[viewer_id] = { pc, pendingCandidates: [] };

    if (mediaStream) {
      mediaStream.getTracks().forEach(track => {
        pc.addTrack(track, mediaStream);
      });
    }

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        socket.emit('webrtc_ice_candidate', {
          target_id: viewer_id,
          candidate: event.candidate
        });
      }
    };

    const offer = await pc.createOffer({
      offerToReceiveVideo: false,
      offerToReceiveAudio: false
    });
    await pc.setLocalDescription(offer);

    socket.emit('webrtc_offer', {
      viewer_id,
      offer
    });
  });

  socket.on('webrtc_answer', async (data) => {
    const { viewer_id, answer } = data;
    const conn = peerConnections[viewer_id];
    if (conn && conn.pc) {
      await conn.pc.setRemoteDescription(new RTCSessionDescription(answer));
      while (conn.pendingCandidates.length > 0) {
        const cand = conn.pendingCandidates.shift();
        await conn.pc.addIceCandidate(new RTCIceCandidate(cand));
      }
    }
  });

  socket.on('webrtc_ice_candidate', async (data) => {
    const { from_id, candidate } = data;
    const conn = peerConnections[from_id];
    if (conn && conn.pc && candidate) {
      if (conn.pc.remoteDescription) {
        await conn.pc.addIceCandidate(new RTCIceCandidate(candidate));
      } else {
        conn.pendingCandidates.push(candidate);
      }
    }
  });
}

// Render active target badges in UI
function renderActiveTargetBadges() {
  if (!isRecordingEnabled) {
    activeTargetsList.innerHTML = `<span class="target-tag" style="background: rgba(245, 158, 11, 0.25); color: #fcd34d; border-color: rgba(245, 158, 11, 0.5);">⏸️ Live View Only (Recording OFF)</span>`;
    return;
  }

  const iconMap = {
    cat: '🐱 Cat',
    dog: '🐶 Dog',
    person: '👤 Human',
    vehicle: '🚗 Vehicle',
    motion: '🏃 Motion'
  };

  activeTargetsList.innerHTML = enabledTargets.map(t =>
    `<span class="target-tag">${iconMap[t] || t}</span>`
  ).join('');
}
renderActiveTargetBadges();

// 7. TensorFlow.js COCO-SSD Model Setup
async function loadAIModel() {
  try {
    console.log('🧠 Loading TensorFlow.js COCO-SSD object detection model...');
    if (typeof cocoSsd !== 'undefined') {
      cocoModel = await cocoSsd.load({ base: 'lite_mobilenet_v2' });
      console.log('✅ TensorFlow.js COCO-SSD Model loaded successfully!');
    } else {
      console.warn('cocoSsd global not found');
    }
  } catch (err) {
    console.error('Failed to load COCO-SSD model:', err);
  }
}

// Helper to determine the best cross-browser MIME type
function getBestSupportedMimeType() {
  const candidates = [
    'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
    'video/mp4',
    'video/webm;codecs=h264,opus',
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm'
  ];
  for (const type of candidates) {
    if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(type)) {
      return type;
    }
  }
  return '';
}

// 8. Motion Detection & Pre-Roll Video Recorder
function initPreRollRecorder() {
  if (!mediaStream) return;

  activeMimeType = getBestSupportedMimeType();
  const options = activeMimeType ? { mimeType: activeMimeType } : {};

  try {
    mediaRecorder = new MediaRecorder(mediaStream, options);
    recordedChunks = [];
    preRollBuffer = [];

    mediaRecorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0 && isRecordingEnabled) {
        if (isRecordingEvent) {
          recordedChunks.push(e.data);
        } else {
          preRollBuffer.push(e.data);
          if (preRollBuffer.length > 5) {
            preRollBuffer.shift();
          }
        }
      }
    };

    mediaRecorder.start(1000);
    console.log(`🎞️ Continuous pre-roll recorder started with MIME: "${mediaRecorder.mimeType || activeMimeType}"`);
  } catch (err) {
    console.error('MediaRecorder error:', err);
  }
}

// Motion Loop (Canvas Pixel Differencing)
function startMotionDetectionLoop() {
  setInterval(async () => {
    if (!videoEl.videoWidth || isRecordingEvent || !isRecordingEnabled) return;

    motionCtx.drawImage(videoEl, 0, 0, 64, 64);
    const frame = motionCtx.getImageData(0, 0, 64, 64);
    const data = frame.data;

    let totalDiff = 0;
    if (lastFrameData) {
      for (let i = 0; i < data.length; i += 4) {
        const diff = Math.abs(data[i] - lastFrameData[i]);
        totalDiff += diff;
      }
    }
    lastFrameData = data;

    const avgDiff = totalDiff / (64 * 64);

    if (avgDiff > 8.0) {
      console.log(`🏃 Canvas Motion Detected (delta: ${avgDiff.toFixed(1)})`);

      if (enabledTargets.includes('motion')) {
        await triggerEventRecording('motion', 0.85);
        return;
      }

      if (cocoModel) {
        const predictions = await cocoModel.detect(videoEl);
        for (const pred of predictions) {
          const detectedClass = mapCocoClassToTarget(pred.class);
          if (detectedClass && enabledTargets.includes(detectedClass) && pred.score >= confidenceThreshold) {
            console.log(`🎯 AI Detection Matched: ${pred.class.toUpperCase()} (${(pred.score * 100).toFixed(0)}%)`);
            await triggerEventRecording(detectedClass, pred.score);
            break;
          }
        }
      }
    }
  }, 600);
}

function mapCocoClassToTarget(cocoClass) {
  if (cocoClass === 'cat') return 'cat';
  if (cocoClass === 'dog') return 'dog';
  if (cocoClass === 'person') return 'person';
  if (['car', 'truck', 'bus', 'motorcycle'].includes(cocoClass)) return 'vehicle';
  return null;
}

// Trigger Event Recording & Server Upload
async function triggerEventRecording(eventType, confidence) {
  if (!isRecordingEnabled) return;

  const now = Date.now();
  if (now - lastEventUploadTime < 15000) return;
  lastEventUploadTime = now;

  console.log(`🔴 Triggering Clip Recording for [${eventType.toUpperCase()}]`);
  isRecordingEvent = true;

  recordedChunks = [...preRollBuffer];

  const iconMap = { cat: '🐱 Cat', dog: '🐶 Dog', person: '👤 Human', vehicle: '🚗 Vehicle', motion: '🏃 Motion' };
  const badgeHTML = `<span class="target-tag recording">🔴 RECORDING: ${iconMap[eventType] || eventType}</span>`;
  activeTargetsList.innerHTML = badgeHTML;

  setTimeout(async () => {
    isRecordingEvent = false;
    renderActiveTargetBadges();

    const usedMime = (mediaRecorder && mediaRecorder.mimeType) ? mediaRecorder.mimeType : (activeMimeType || 'video/webm');
    const ext = usedMime.toLowerCase().includes('mp4') ? '.mp4' : '.webm';
    const videoBlob = new Blob(recordedChunks, { type: usedMime });

    recordedChunks = [];
    preRollBuffer = [];

    const formData = new FormData();
    formData.append('video', videoBlob, `event_${eventType}_${now}${ext}`);
    formData.append('camera_id', cameraId);
    formData.append('camera_name', cameraName);
    formData.append('type', eventType);
    formData.append('confidence', confidence);
    formData.append('duration', '12');

    try {
      console.log(`📤 Uploading recorded clip (${ext}, ${usedMime}) to Home Server...`);
      const response = await fetch('/api/events/upload', {
        method: 'POST',
        body: formData
      });
      const result = await response.json();
      if (result.success) {
        console.log('✅ Video clip uploaded successfully:', result.event.id);
      }
    } catch (err) {
      console.error('Error uploading clip:', err);
    }
  }, 8000);
}
