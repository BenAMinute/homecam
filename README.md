# 📹 HomeCam - Smart Self-Hosted Home Security System

**HomeCam** is a self-hosted, privacy-focused home security camera system designed to repurpose old smartphones (Android & iOS) into smart security camera nodes with WebRTC live streaming, TensorFlow.js AI object detection, stealth screen dimming, and protected cloud/local video recording.

---

## 🌟 Key Features

- 📱 **Multi-Camera WebRTC Live Streaming**: Ultra-low latency P2P video feeds directly from your smartphones to your dashboard.
- 🧠 **On-Device AI Target Detection**: Uses TensorFlow.js (`cocoSsd`) directly on the smartphone to classify **Cats 🐱**, **Humans 👤**, **Dogs 🐶**, **Vehicles 🚗**, and **General Motion 🏃** without relying on third-party cloud services.
- 🎞️ **Continuous Pre-Roll Ring Buffer**: Stores a rolling 5-second video buffer on the phone so recorded clips capture the 5 seconds *before* motion was detected.
- 📊 **Daily Activity Summary & 24h Timeline**: Dashboard analytics widget showing total detections today, peak activity hours, target distribution, and an interactive 24-hour activity bar chart.
- 🔒 **Protected Video Clips**: Pinned clips (`is_protected = 1`) are immune to automatic disk storage retention cleanups.
- 🌙 **Stealth Blackout Screen Dimmer**: Pitch-black screen overlay (`#000000`) for OLED power saving and room dimming while maintaining CPU Screen Wake Lock and continuous camera monitoring.
- 🔋 **Battery Level Monitoring & Heartbeat**: Real-time battery percentage and charging status synced to the dashboard.
- 💡 **Remote Torch & Physical Multi-Lens Switch**: Remote flashlight control and lens cycling across all physical lenses on modern smartphones (Ultra-Wide 0.5x, Main 1x, Telephoto 3x, Front Selfie).
- ⏸️ **Live View Only Mode**: Master recording toggle allowing HomeCam to be used strictly as a live view monitor without recording video clips.
- 🗑️ **Camera Feed Management**: Easily remove offline or unused camera nodes from the database directly from the dashboard.
- 🐳 **One-Command Docker Deployment**: Packages Node.js HTTPS server, Socket.IO WebRTC signaling engine, SQLite database, and SSL certificate generator into a single Docker container.

---

## 🏗️ Architecture & Technology Stack

- **Backend**: Node.js (v20+), Express.js, Socket.IO (WebRTC Signaling)
- **Database**: SQLite with dual-driver fallback (`better-sqlite3` native / standard `sqlite3`)
- **Frontend**: Vanilla JavaScript (ES6+), Modern Dark Glassmorphism CSS Design System
- **Machine Learning**: TensorFlow.js (`@tensorflow/tfjs` & `@tensorflow-models/coco-ssd`)
- **Security & Networking**: Native HTTPS with automatic self-signed TLS certificate generation (`selfsigned`)

---

## 🚀 Quick Start Guide

### Option 1: Run with Docker Compose (Recommended)

1. Clone the repository to your home server:
   ```bash
   git clone https://github.com/BenAMinute/homecam.git
   cd homecam
   ```

2. Start the containerized service:
   ```bash
   docker compose up -d --build
   ```

3. Open the web interface in your browser:
   - **Viewer Dashboard**: `https://<YOUR-HOME-SERVER-IP>:8443`
   - **Camera Setup Page**: `https://<YOUR-HOME-SERVER-IP>:8443/camera.html`

---

### Option 2: Run Standalone with Node.js

1. Install dependencies:
   ```bash
   npm install
   ```

2. Start the server:
   ```bash
   npm start
   ```

3. The server will generate self-signed TLS certificates on first boot and listen on port `8443` (HTTPS) and `8080` (HTTP auto-redirect).

---

## 📲 Setting Up a Camera Phone (Android / iOS)

1. Open **Safari** (iOS) or **Chrome** (Android) on your spare phone.
2. Navigate to `https://<YOUR-HOME-SERVER-IP>:8443/camera.html`.
3. **Bypass Self-Signed SSL Warning**:
   - **iOS Safari**: Tap *Show Details* -> *visit this website* -> *Visit Website*.
   - **Android Chrome**: Tap *Advanced* -> *Proceed to IP (unsafe)*.
4. Allow Camera & Microphone permissions when prompted.
5. In the setup modal:
   - Enter a descriptive name (e.g. `Living Room Phone`).
   - Select your preferred physical camera lens (`Main Rear`, `Ultra-Wide 0.5x`, `Telephoto Zoom 3x`, or `Front Selfie`).
   - Select stream resolution (`720p HD`, `1080p Full HD`, or `480p SD`).
6. Tap **🚀 Start Security Camera Node**.
7. Tap **🌙 Dim Screen** to enter OLED blackout power-saving mode.

---

## ⚙️ Configuration & Storage Rules

HomeCam includes built-in automated disk storage retention rules configured via the **System & Detection Configuration** tab on the dashboard:

- **Auto-Delete Retention Limit**: Automatically purges unprotected video clips older than a configurable number of days (Default: `14 days`).
- **Maximum Storage Cap**: Enforces a total disk usage ceiling in GB (Default: `50 GB`). When exceeded, old unprotected clips are purged oldest-first.
- **Protected Clips**: Clicking the 🔓 icon on any clip locks it (`🔒 Protected`), ensuring it will **never be deleted** by auto-cleanup rules.

---

## 📁 Directory Structure

```
homecam/
├── Dockerfile              # Alpine Node.js production image definition
├── docker-compose.yml      # Service config mapping media, data, and cert volumes
├── package.json            # Node.js dependencies & scripts
├── scripts/
│   └── generate-cert.js    # Self-signed TLS certificate generator
├── server/
│   ├── server.js           # Express HTTPS API & Socket.IO WebRTC engine
│   ├── db.js               # SQLite schema & dual-driver query helper
│   └── storage.js          # Clip file manager & auto-retention cleanup worker
├── public/
│   ├── index.html          # Viewer Dashboard HTML template
│   ├── camera.html         # Camera Node HTML template
│   ├── camera.js           # Camera Node engine (TensorFlow AI, MediaRecorder, WebRTC)
│   ├── css/
│   │   └── styles.css      # Dark glassmorphism design system
│   └── js/
│       └── viewer.js       # Dashboard client logic & WebRTC subscriber
├── data/                   # SQLite database persistent storage volume
├── media/                  # Recorded video clips persistent storage volume
└── certs/                  # TLS SSL certificate persistent storage volume
```

---

## 🔒 License

MIT License - Free for personal and commercial use.
