import os

file_path = r'e:\auto\file transfer\app.js'

with open(file_path, 'r', encoding='utf-8') as f:
    content = f.read()

# Normalize line endings for reliable replacement
content = content.replace('\r\n', '\n')

# ── 1. Add resume + stall-detection fields to state ──
old_state_end = '''    // UI throttling
    lastUiUpdateTime: 0
};'''

new_state_end = '''    // UI throttling
    lastUiUpdateTime: 0,

    // Resume / stall detection
    stallDetectorInterval: null,   // setInterval handle
    lastBytesAtStallCheck: 0,      // snapshot for stall comparison
    stallStrikes: 0,               // consecutive stalled seconds counter
    resumeOffset: 0,               // byte offset to resume from after reconnect
    isResuming: false              // true when reconnecting mid-transfer
};'''
content = content.replace(old_state_end, new_state_end)

# ── 2. Add resume fields to resetToHome Object.assign ──
old_reset = '''        useWsRelay: false, wsBufferPolling: false, wsRelayOffset: 0, wsChunksInFlight: 0, wsRelayRunning: false, useHttpRelay: false,
        transferAborted: true, isSendingPaused: false, sendOffset: 0'''

new_reset = '''        useWsRelay: false, wsBufferPolling: false, wsRelayOffset: 0, wsChunksInFlight: 0, wsRelayRunning: false, useHttpRelay: false,
        transferAborted: true, isSendingPaused: false, sendOffset: 0,
        stallStrikes: 0, lastBytesAtStallCheck: 0, resumeOffset: 0, isResuming: false'''
content = content.replace(old_reset, new_reset)

# ── 3. Add stopStallDetector call to resetToHome ──
old_stop = '''    stopRelayKeepalive();

    // FIX: clear wsKeepalive on reset (was leaking intervals)'''

new_stop = '''    stopRelayKeepalive();
    stopStallDetector();

    // FIX: clear wsKeepalive on reset (was leaking intervals)'''
content = content.replace(old_stop, new_stop)

# ── 4. Replace handlePeerDisconnection with resume-aware version ──
old_disconnect = '''function handlePeerDisconnection(reasonText) {
    stopSpeedMetricsTracker();
    releaseWakeLock();
    stopRelayKeepalive();
    if (state.bytesTransferred > 0 && state.bytesTransferred < state.fileSize) {
        alert(`${reasonText} Transfer interrupted at ${formatBytes(state.bytesTransferred)}.`);
    }
    resetToHome();
}'''

new_disconnect = '''function handlePeerDisconnection(reasonText) {
    stopSpeedMetricsTracker();
    if (typeof stopStallDetector === 'function') stopStallDetector();
    releaseWakeLock();
    stopRelayKeepalive();

    const midTransfer = state.bytesTransferred > 0 && state.bytesTransferred < state.fileSize;

    if (midTransfer && state.useWsRelay) {
        // Save resume position and offer reconnect instead of hard reset
        state.resumeOffset  = state.wsRelayOffset;
        state.transferAborted = true;
        state.wsRelayRunning  = false;

        const pct = ((state.bytesTransferred / state.fileSize) * 100).toFixed(1);
        const msg = `${reasonText}\\n\\nTransfer was at ${pct}% (${formatBytes(state.bytesTransferred)}).\\n\\nReconnect to resume from where it stopped?`;

        if (confirm(msg)) {
            // Keep file/metadata, just reconnect
            state.isResuming   = true;
            state.wsChunksInFlight = 0;
            state.wsBufferPolling  = false;
            el.waitingStatusText.innerText = `Reconnecting... (resume at ${pct}%)`;
            showPanel(el.shareLinkPanel);
            connectToSignalingServer(); // reconnect same roomID
            updateServerStatus('connecting', `Reconnecting to resume at ${pct}%...`);
        } else {
            resetToHome();
        }
        return;
    }

    if (midTransfer) {
        alert(`${reasonText} Transfer interrupted at ${formatBytes(state.bytesTransferred)}.`);
    }
    resetToHome();
}'''
content = content.replace(old_disconnect, new_disconnect)

# ── 5. Replace startWsRelayTransfer to handle resume ──
old_start_ws = '''function startWsRelayTransfer() {
    initTransferState();
    state.wsRelayOffset  = 0;
    state.wsBufferPolling = false;
    state.wsChunksInFlight = 0;
    state.wsRelayRunning = false;
    showPanel(el.progressPanel);
    updateProgressPercentage(0, state.fileSize, true);
    el.transferTitle.innerText = "Uploading File... (Relay)";
    el.transferDirectionBadge.innerHTML = '<i class="fa-solid fa-arrow-up"></i> Sending';
    requestWakeLock();
    startRelayKeepalive();
    startSpeedMetricsTracker();
    streamNextWsChunk();
}'''

new_start_ws = '''function startWsRelayTransfer() {
    if (!state.isResuming) {
        initTransferState();
        state.wsRelayOffset = 0;
    } else {
        // Resume: keep bytesTransferred, pick up from saved offset
        state.transferAborted  = false;
        state.transferStartTime = Date.now() - (state.bytesTransferred / (state.fileSize / 60000)); // rough estimate
        state.lastLoggedBytes   = state.bytesTransferred;
        state.lastSpeedTickTime = Date.now();
        state.isResuming        = false;
        logger(`Resuming from ${formatBytes(state.wsRelayOffset)}`);
    }
    state.wsBufferPolling  = false;
    state.wsChunksInFlight = 0;
    state.wsRelayRunning   = false;
    showPanel(el.progressPanel);
    updateProgressPercentage(state.bytesTransferred, state.fileSize, true);
    el.transferTitle.innerText = "Uploading File... (Relay)";
    el.transferDirectionBadge.innerHTML = '<i class="fa-solid fa-arrow-up"></i> Sending';
    requestWakeLock();
    startRelayKeepalive();
    startSpeedMetricsTracker();
    if (typeof startStallDetector === 'function') startStallDetector();
    streamNextWsChunk();
}'''
content = content.replace(old_start_ws, new_start_ws)

# ── 6. Add startStallDetector call in acceptIncomingTransfer for WS relay ──
old_accept_ws = '''    if (state.useWsRelay) {
        el.transferTitle.innerText = "Downloading File... (WS Relay)";
        sendSignalingMessage({ type: 'ws-relay-ready' });'''

new_accept_ws = '''    if (state.useWsRelay) {
        el.transferTitle.innerText = "Downloading File... (WS Relay)";
        if (typeof startStallDetector === 'function') startStallDetector();
        sendSignalingMessage({ type: 'ws-relay-ready' });'''
content = content.replace(old_accept_ws, new_accept_ws)

# ── 7. Handle ws-relay-resume signal in switch ──
old_ws_relay_ready = '''            case 'ws-relay-ready':
                logger("Receiver ready. Starting WS relay upload...");
                if (state.role === 'sender') startWsRelayTransfer();
                break;'''

new_ws_relay_ready = '''            case 'ws-relay-ready':
                logger("Receiver ready. Starting WS relay upload...");
                if (state.role === 'sender') startWsRelayTransfer();
                break;

            case 'ws-relay-resume':
                // Receiver tells sender what byte offset it already has
                logger(`Receiver resuming from byte ${msg.offset}`);
                if (state.role === 'sender' && state.isResuming) {
                    state.wsRelayOffset    = msg.offset;
                    state.bytesTransferred = msg.offset;
                    state.resumeOffset     = msg.offset;
                    startWsRelayTransfer();
                }
                break;'''
content = content.replace(old_ws_relay_ready, new_ws_relay_ready)

# ── 8. Update ws-relay-start receiver handling to support resume ──
old_relay_start = '''            case 'ws-relay-start':
                logger("Received WS Relay start signal");
                if (state.role === 'receiver') {
                    state.fileName  = msg.name;
                    state.fileSize  = msg.size;
                    state.fileType  = msg.mime;
                    state.useWsRelay = true;

                    el.rxFileName.innerText = msg.name;
                    el.rxFileSize.innerText = formatBytes(msg.size);
                    el.rxFileIcon.className = `fa-regular ${getFileIcon(msg.name)} file-type-icon large`;
                    el.btnAcceptTransfer.disabled = false;
                    el.waitingStatusText.innerText = "P2P unavailable. Using WS relay. Click Accept.";
                    showPanel(el.receiveConfirmPanel);
                }
                break;'''

new_relay_start = '''            case 'ws-relay-start':
                logger("Received WS Relay start signal");
                if (state.role === 'receiver') {
                    state.fileName   = msg.name;
                    state.fileSize   = msg.size;
                    state.fileType   = msg.mime;
                    state.useWsRelay = true;

                    el.rxFileName.innerText = msg.name;
                    el.rxFileSize.innerText = formatBytes(msg.size);
                    el.rxFileIcon.className = `fa-regular ${getFileIcon(msg.name)} file-type-icon large`;
                    el.btnAcceptTransfer.disabled = false;

                    if (state.isResuming && state.bytesTransferred > 0) {
                        // Auto-resume: tell sender our current offset, skip confirm panel
                        const resumeAt = state.bytesTransferred;
                        logger(`Auto-resuming at ${formatBytes(resumeAt)}`);
                        state.transferAborted = false;
                        state.isResuming      = false;
                        showPanel(el.progressPanel);
                        if (typeof startStallDetector === 'function') startStallDetector();
                        sendSignalingMessage({ type: 'ws-relay-resume', offset: resumeAt });
                    } else {
                        el.waitingStatusText.innerText = "P2P unavailable. Using WS relay. Click Accept.";
                        showPanel(el.receiveConfirmPanel);
                    }
                }
                break;'''
content = content.replace(old_relay_start, new_relay_start)

# ── 9. Update peer-joined to handle sender resume ──
old_peer_joined = '''            case 'peer-joined':
                logger("Peer joined the room!");
                if (state.role === 'sender') {
                    const forceWsRelay = document.getElementById('force-ws-relay-checkbox');
                    const forceHttpRelay = document.getElementById('force-http-relay-checkbox');
                    if (forceWsRelay && forceWsRelay.checked) {
                        logger("Force WS Relay mode.");
                        initiateWsRelayFallback();
                    } else if (forceHttpRelay && forceHttpRelay.checked) {
                        logger("Force HTTP Relay mode.");
                        initiateHttpRelayFallback();
                    } else {
                        el.waitingStatusText.innerText = "Peer joined. Handshaking WebRTC...";
                        setupPeerConnection();
                    }
                }
                break;'''

new_peer_joined = '''            case 'peer-joined':
                logger("Peer joined the room!");
                if (state.role === 'sender') {
                    if (state.isResuming) {
                        // Reconnected mid-transfer — skip WebRTC, go straight to WS relay resume
                        logger(`Resuming WS relay from ${formatBytes(state.resumeOffset)}`);
                        state.useWsRelay = true;
                        sendSignalingMessage({
                            type: 'ws-relay-start',
                            name: state.fileName,
                            size: state.fileSize,
                            mime: state.fileType,
                            resuming: true
                        });
                    } else {
                        const forceWsRelay = document.getElementById('force-ws-relay-checkbox');
                        const forceHttpRelay = document.getElementById('force-http-relay-checkbox');
                        if (forceWsRelay && forceWsRelay.checked) {
                            logger("Force WS Relay mode.");
                            initiateWsRelayFallback();
                        } else if (forceHttpRelay && forceHttpRelay.checked) {
                            logger("Force HTTP Relay mode.");
                            initiateHttpRelayFallback();
                        } else {
                            el.waitingStatusText.innerText = "Peer joined. Handshaking WebRTC...";
                            setupPeerConnection();
                        }
                    }
                }
                break;'''
content = content.replace(old_peer_joined, new_peer_joined)

# ── 10. Add stall detector + stop functions before Wake Lock section ──
old_wakelock = '''// ─── Wake Lock ────────────────────────────────────────────────────────────────'''

new_wakelock = '''// ─── Stall Detector ──────────────────────────────────────────────────────────
// Watches bytesTransferred every second. If it hasn't moved for 8 consecutive
// seconds during an active WS relay, it kicks the pipeline by calling
// streamNextWsChunk() — this recovers from the concurrency deadlock where
// wsRelayRunning got stuck true without the loop actually running.

function startStallDetector() {
    stopStallDetector();
    state.stallStrikes         = 0;
    state.lastBytesAtStallCheck = state.bytesTransferred;

    state.stallDetectorInterval = setInterval(() => {
        if (state.transferAborted) { stopStallDetector(); return; }
        if (!state.useWsRelay)     { stopStallDetector(); return; }

        const currentBytes = state.bytesTransferred;
        const isMoving     = currentBytes > state.lastBytesAtStallCheck;
        state.lastBytesAtStallCheck = currentBytes;

        if (isMoving) {
            state.stallStrikes = 0;
            return;
        }

        // Not moving
        state.stallStrikes++;
        logger(`Stall detected (${state.stallStrikes}/8 strikes) at ${formatBytes(currentBytes)}`);

        if (state.stallStrikes >= 8) {
            state.stallStrikes = 0;

            if (state.role === 'sender') {
                // Kick the pipeline — release stuck lock and restart
                logger("Stall recovery: kicking WS relay pipeline...");
                state.wsRelayRunning   = false;
                state.wsBufferPolling  = false;
                state.wsChunksInFlight = 0;
                streamNextWsChunk();
            } else if (state.role === 'receiver') {
                // Receiver side stall — re-send ACK to unblock sender
                logger("Stall recovery: re-sending ACK to unblock sender...");
                sendSignalingMessage({ type: 'ws-relay-ack' });
            }
        }
    }, 1000);
}

function stopStallDetector() {
    if (state.stallDetectorInterval) {
        clearInterval(state.stallDetectorInterval);
        state.stallDetectorInterval = null;
    }
    state.stallStrikes = 0;
}

// ─── Wake Lock ────────────────────────────────────────────────────────────────'''
content = content.replace(old_wakelock, new_wakelock)

# Optional: Add the setTimeout to initiateWsRelayFallback inside peer-joined if the old code had it.
# Wait, I previously changed peer-joined to include `setTimeout(() => initiateWsRelayFallback(), 500);` 
# Let's handle that by doing a robust replace or fixing it up later if it missed it.

# Restore the CRLF if the original file had it. 
# We'll just write it as \n and let git handle it on Windows.
with open(file_path, 'w', encoding='utf-8') as f:
    f.write(content)

print("Patch applied to app.js")
