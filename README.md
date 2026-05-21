# WarpDrop 🚀

WarpDrop is a modern, ultra-fast, secure **peer-to-peer (P2P) file transfer application** designed to share files of any size (even 50 GB+) directly between devices. 

It uses **WebRTC Data Channels** to send data directly from browser to browser, meaning your files never touch any third-party servers. When P2P isn't possible, it seamlessly falls back to **WebSocket Relay** or **HTTP Relay** modes to guarantee delivery across any network.

---

## ✨ Features

- **Direct-to-Disk Streaming (Zero-Copy):** Stream files directly to the receiver's hard drive using Chrome's File System Access API — no RAM limits, no crash warnings.
- **WebRTC Peer-to-Peer:** Highly secure, direct browser-to-browser transfers with zero intermediary servers.
- **Triple Transfer Modes:**
  - **P2P (WebRTC):** Fastest — direct device-to-device, works on same WiFi (50-100+ MB/s).
  - **WS Relay (WebSocket):** Automatic fallback when P2P fails — data routes through the server via WebSocket with a 16-chunk sliding window pipeline.
  - **HTTP Relay:** Final fallback for restrictive networks — chunk-by-chunk upload/download via HTTP POST/GET.
- **Automatic Resume & Reconnect:** If the connection drops mid-transfer, a popup lets you reconnect and resume from the exact byte where it stopped — no data is re-sent.
- **Resume from Partial File:** If you refreshed the page or lost the room code, you can select the partially downloaded file from your hard drive and the transfer will resume by appending the remaining data (Desktop Chrome/Edge only).
- **Smart Stall Detection:** Monitors transfer progress every second. After 15 seconds of no movement, it intelligently kicks the pipeline (sender) or re-sends ACKs (receiver) to recover from deadlocks — but only if the socket buffer is truly empty, avoiding false positives on slow connections.
- **Sliding Window Pipeline:** Keeps up to 16 × 2 MB chunks in-flight simultaneously, maximizing network throughput without overwhelming RAM.
- **Visual Analytics Dashboard:** Dark-mode glassmorphic UI with real-time speed indicators, ETA countdown, progress bar, and a smooth canvas-drawn 60-second speed history chart.
- **Wake Lock Protection:** Prevents system sleep or tab suspension during ongoing transfers.
- **Relay Keepalive:** Periodic pings to prevent free-tier hosting platforms (like Render) from sleeping.
- **Stale Transfer Cleanup:** Server-side background task automatically cleans up abandoned HTTP relay transfers after 5 minutes of inactivity.

---

## 🛠️ Tech Stack

- **Frontend:** Vanilla HTML5, CSS3 (Glassmorphism + Neon theme), Modern Javascript (ES6+, WebRTC, File System Access API, Canvas API)
- **Backend:** Python, FastAPI, Uvicorn, WebSockets
- **Protocols:** WebRTC (SCTP Data Channels), WebSockets (Signaling + Relay), HTTP (Relay Fallback)

---

## 🚀 How to Run Locally

### Prerequisites
Make sure you have **Python 3.8+** installed on your system.

### Steps
1. **Clone or download** this repository.
2. Open your terminal in the project directory:
   ```bash
   cd "file transfer"
   ```
3. Create and activate a Python virtual environment:
   ```bash
   python -m venv env
   # On Windows:
   .\env\Scripts\activate
   # On macOS/Linux:
   source env/bin/activate
   ```
4. Install the required dependencies:
   ```bash
   pip install -r requirements.txt
   ```
5. Start the server:
   ```bash
   python server.py
   ```
6. Open your browser and go to:
   👉 **http://localhost:8000**

---

## 📡 Transfer Modes

| Mode | Speed | When Used | How It Works |
|------|-------|-----------|--------------|
| **P2P (WebRTC)** | 50-100+ MB/s | Same WiFi / compatible NAT | Direct browser-to-browser, no server relay |
| **WS Relay** | Limited by upload speed | P2P fails or "Force WS Relay" checked | Data flows: Sender → Server WebSocket → Receiver |
| **HTTP Relay** | Slowest | "Force HTTP Relay" checked | Chunk-by-chunk POST/GET through server |

---

## 🔄 Resume & Reconnect

WarpDrop supports two types of resume:

### 1. Same-Tab Reconnect (No Refresh)
If the connection drops (WiFi glitch, server restart, etc.):
1. A popup appears: *"Transfer was at X%. Reconnect to resume?"*
2. Click **OK** — the browser reconnects to the same room.
3. The transfer resumes from the exact byte where it stopped.
4. Speed graph, ETA, and all UI stats restart automatically.

> ⚠️ **Do NOT refresh the page.** Chrome deletes all in-progress file data when you refresh.

### 2. Resume from Partial File (After Refresh)
If you accidentally refreshed the page or lost the room code:
1. On the sender: select the same file again, get a new room code.
2. On the receiver: enter the new code and connect.
3. Click **"Resume from Partial File"** instead of "Save & Receive".
4. Select the partially downloaded file from your hard drive.
5. The app calculates how much data you already have and tells the sender to skip ahead.

> ℹ️ This feature requires the File System Access API (Desktop Chrome/Edge only). It does not work on phones.

---

## ☁️ How to Deploy Online (Free)

Deploying WarpDrop online allows you to share files across different networks and internet connections.

### Deploy to Render.com
1. Push this repository to your **GitHub** account.
2. Sign up on **[Render.com](https://render.com/)** and link your GitHub.
3. Click **New +** -> **Web Service**.
4. Choose your `warpdrop` repository and configure:
   - **Runtime:** `Python`
   - **Build Command:** `pip install -r requirements.txt`
   - **Start Command:** `python server.py`
   - **Instance Type:** `Free`
5. Click **Deploy Web Service**.
6. Render will generate a public URL (e.g., `https://warpdrop.onrender.com`) for you to start sharing globally!

---

## 🔒 Security & Privacy

Since WarpDrop uses WebRTC for file sharing:
- All data transferred is **end-to-end encrypted** using DTLS/SRTP protocols built directly into the browsers.
- The signaling server is only used to connect the two browsers together. Once connected, the WebSocket sits idle, and data is sent directly between the peers.
- Your files are never stored, cached, or seen by any server.
- In relay modes (WS/HTTP), data passes through the server but is never saved to disk — it is forwarded in real-time and immediately discarded.
