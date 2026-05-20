# WarpDrop 🚀

WarpDrop is a modern, ultra-fast, secure **peer-to-peer (P2P) file transfer application** designed to share files of any size (even 50 GB+) directly between devices. 

It uses **WebRTC Data Channels** to send data directly from browser to browser, meaning your files never touch any third-party servers. It also leverages Chrome's **File System Access API** to write incoming files straight to your hard drive, allowing unlimited file size transfers without running out of memory.

---

## ✨ Features

- **Direct-to-Disk Streaming (Zero-Copy):** Stream files directly to the receiver's hard drive without using RAM. No crash warnings on large files.
- **WebRTC Peer-to-Peer:** Highly secure, direct browser-to-browser transfers. Zero intermediary servers.
- **Visual Analytics Dashboard:** High-performance dark-mode glassmorphic design featuring neon speed indicators and a smooth canvas-drawn speed history chart.
- **Flow Control (Backpressure Management):** Intelligent buffer throttling preventing packet loss and maximizing throughput.
- **Wake Lock Protection:** Prevents system sleep or tab suspension during ongoing background transfers.
- **Self-Contained Signaling:** Lightweight FastAPI & WebSocket backend handles peer room matching and SDP handshakes.

---

## 🛠️ Tech Stack

- **Frontend:** Vanilla HTML5, CSS3 (Glassmorphism + Neon theme), Modern Javascript (ES6+, WebRTC, File System Access API, Canvas API)
- **Backend:** Python, FastAPI, Uvicorn, WebSockets
- **Protocols:** WebRTC (SCTP Data Channels), WebSockets (Signaling)

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
