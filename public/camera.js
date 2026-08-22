// HomeCam Smartphone Camera Node Script

let socket = null;
let mediaStream = null;
let peerConnections = {}; // viewer_id -> RTCPeerConnection
let wakeLock = null;
let cocoModel = null;

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

    initPreRollRecorder();
    startMotionDetectionLoop();
  } catch (err) {
    console.error('Camera access error:', err);
    alert('Unable to access camera hardware. Please ensure camera permissions are allowed and HTTPS is active.');
  }
}

// 5. Battery Monitoring
async function startBatteryMonitoring() {
  if ('getBattery' in navigator) {
    try {
      const battery = await navigator.getBattery();
      const updateBattery = () => {
        const pct = Math.round(battery.level * 100);
        batteryBadge.textContent = `${battery.charging ? '⚡' : '🔋'} ${pct}%`;
        if (socket && socket.connected) {
          socket.emit('camera_heartbeat', {
            camera_id: cameraId,
            battery_level: pct,
            status: 'online'
          });
        }
      };
      updateBattery();
      battery.addEventListener('levelchange', updateBattery);
      battery.addEventListener('chargingchange', updateBattery);
    } catch (e) {
      console.warn('Battery API not available');
    }
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
      battery_level: 100
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

  // Remote Commands from Viewer
  socket.on('camera_control', async (data) => {
    console.log('Received remote command:', data);
    if (data.command === 'toggle_torch') {
      const track = mediaStream ? mediaStream.getVideoTracks()[0] : null;
      if (track && 'applyConstraints' in track) {
        const capabilities = track.getCapabilities ? track.getCapabilities() : {};
        if (capabilities.torch) {
          const currentSetting = track.getConstraints().torch || false;
          await track.applyConstraints({ advanced: [{ torch: !currentSetting }] });
        }
      }
    } else if (data.command === 'switch_lens') {
      facingMode = facingMode === 'environment' ? 'user' : 'environment';
      await initCameraStream();
    }
  });

  // WebRTC Live Video Streaming to Viewers
  socket.on('start_peer_connection', async (data) => {
    const { viewer_id } = data;
    console.log(`📡 Creating WebRTC connection for viewer ${viewer_id}`);

    const pc = new RTCPeerConnection({
      iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
    });
    peerConnections[viewer_id] = pc;

    mediaStream.getTracks().forEach(track => {
      pc.addTrack(track, mediaStream);
    });

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        socket.emit('webrtc_ice_candidate', {
          target_id: viewer_id,
          candidate: event.candidate
        });
      }
    };

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    socket.emit('webrtc_offer', {
      viewer_id,
      offer
    });
  });

  socket.on('webrtc_answer', async (data) => {
    const { viewer_id, answer } = data;
    const pc = peerConnections[viewer_id];
    if (pc) {
      await pc.setRemoteDescription(new RTCSessionDescription(answer));
    }
  });

  socket.on('webrtc_ice_candidate', async (data) => {
    const { from_id, candidate } = data;
    const pc = peerConnections[from_id];
    if (pc && candidate) {
      await pc.addIceCandidate(new RTCIceCandidate(candidate));
    }
  });
}

// Render active target badges in UI
function renderActiveTargetBadges() {
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
    cocoModel = await coco-ssd.load({ base: 'lite_mobilenet_v2' });
    console.log('✅ TensorFlow.js Model loaded successfully!');
  } catch (err) {
    console.error('Failed to load COCO-SSD model:', err);
  }
}

// 8. Motion Detection & Pre-Roll Video Recorder
function initPreRollRecorder() {
  if (!mediaStream) return;

  const mimeType = MediaRecorder.isTypeSupported('video/webm;codecs=vp8,opus')
    ? 'video/webm;codecs=vp8,opus'
    : 'video/webm';

  try {
    mediaRecorder = new MediaRecorder(mediaStream, { mimeType });
    recordedChunks = [];
    preRollBuffer = [];

    mediaRecorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) {
        if (isRecordingEvent) {
          recordedChunks.push(e.data);
        } else {
          // Circular buffer: keep last 5 chunks (5 seconds)
          preRollBuffer.push(e.data);
          if (preRollBuffer.length > 5) {
            preRollBuffer.shift();
          }
        }
      }
    };

    mediaRecorder.start(1000); // 1 sec timeslices
    console.log('🎞️ Continuous pre-roll video recorder started');
  } catch (err) {
    console.error('MediaRecorder error:', err);
  }
}

// Motion Loop (Canvas Pixel Differencing)
function startMotionDetectionLoop() {
  setInterval(async () => {
    if (!videoEl.videoWidth || isRecordingEvent) return;

    motionCtx.drawImage(videoEl, 0, 0, 64, 64);
    const frame = motionCtx.getImageData(0, 0, 64, 64);
    const data = frame.data;

    let totalDiff = 0;
    if (lastFrameData) {
      for (let i = 0; i < data.length; i += 4) {
        const diff = Math.abs(data[i] - lastFrameData[i]); // Red channel diff
        totalDiff += diff;
      }
    }
    lastFrameData = data;

    const avgDiff = totalDiff / (64 * 64);

    // If canvas difference exceeds motion threshold (~8.0 pixel average delta)
    if (avgDiff > 8.0) {
      console.log(`🏃 Canvas Motion Detected (delta: ${avgDiff.toFixed(1)})`);

      if (enabledTargets.includes('motion')) {
        await triggerEventRecording('motion', 0.85);
        return;
      }

      // If AI object classification is enabled & model is ready, run COCO-SSD inference!
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
  }, 600); // check 1.6 times per sec
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
  const now = Date.now();
  if (now - lastEventUploadTime < 15000) return; // 15 sec cooldown per event
  lastEventUploadTime = now;

  console.log(`🔴 Triggering Clip Recording for [${eventType.toUpperCase()}]`);
  isRecordingEvent = true;

  // Combine pre-roll buffer with current recording
  recordedChunks = [...preRollBuffer];

  // Highlight active badge
  const iconMap = { cat: '🐱 Cat', dog: '🐶 Dog', person: '👤 Human', vehicle: '🚗 Vehicle', motion: '🏃 Motion' };
  const badgeHTML = `<span class="target-tag recording">🔴 RECORDING: ${iconMap[eventType] || eventType}</span>`;
  activeTargetsList.innerHTML = badgeHTML;

  // Record for 8 seconds after trigger
  setTimeout(async () => {
    isRecordingEvent = false;
    renderActiveTargetBadges();

    const videoBlob = new Blob(recordedChunks, { type: 'video/webm' });
    recordedChunks = [];
    preRollBuffer = [];

    // Upload clip to server
    const formData = new FormData();
    formData.append('video', videoBlob, `event_${eventType}_${now}.webm`);
    formData.append('camera_id', cameraId);
    formData.append('camera_name', cameraName);
    formData.append('type', eventType);
    formData.append('confidence', confidence);
    formData.append('duration', '12');

    try {
      console.log('📤 Uploading recorded clip to Home Server...');
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
