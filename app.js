// Global application state
const state = {
    role: null,               // 'sender' or 'receiver'
    roomID: null,
    ws: null,                 // WebSocket signaling connection
    peerConnection: null,
    dataChannel: null,

    // File parameters
    file: null,
    fileName: null,
    fileSize: 0,
    fileType: null,

    // Download parameters (receiver)
    fileHandle: null,
    fileWritable: null,
    receivedChunks: [],
    pendingWrites: [],        // Track unresolved write promises

    // Transfer progress
    bytesTransferred: 0,
    transferStartTime: 0,
    lastLoggedBytes: 0,
    lastSpeedTickTime: 0,
    speedHistory: [],
    speedTickInterval: null,
    maxSpeedObserved: 0,

    // Flow control
    isSendingPaused: false,
    sendOffset: 0,

    // WS relay mode
    useWsRelay: false,
    wsBufferPolling: false,
    wsRelayOffset: 0,
    wsChunksInFlight: 0,       // Tracks how many blocks are currently on the wire
    maxWsChunksInFlight: 3,    // Allowed pipeline window depth (6MB in flight max)
    wsRelayRunning: false,     // Guard: prevents concurrent streamNextWsChunk() calls

    // HTTP relay mode
    useHttpRelay: false,

    // Transfer abort flag
    transferAborted: false,

    // Wake Lock
    wakeLock: null,
    relayKeepalive: null,
    wsKeepalive: null,

    // UI throttling
    lastUiUpdateTime: 0,

    // Resume / stall detection
    stallDetectorInterval: null,   // setInterval handle
    lastBytesAtStallCheck: 0,      // snapshot for stall comparison
    stallStrikes: 0,               // consecutive stalled seconds counter
    resumeOffset: 0,               // byte offset to resume from after reconnect
    isResuming: false,             // true when reconnecting mid-transfer
    webrtcHandshakeTimer: null     // fallback timer for P2P connection
};

// WebRTC constants
const CHUNK_SIZE = 64 * 1024;              // 64KB for WebRTC data channel
const WS_CHUNK_SIZE = 2 * 1024 * 1024;     // 2MB for WebSocket relay (pipelined)
const BUFFER_HIGH_WATERMARK = 4 * 1024 * 1024;
const BUFFER_LOW_THRESHOLD = 1 * 1024 * 1024;
const ICE_CONFIG = {
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun2.l.google.com:19302' }
    ]
};

// DOM Elements
const el = {
    dot: document.getElementById('connection-dot'),
    text: document.getElementById('connection-text'),

    initialPanel: document.getElementById('initial-panel'),
    sendFilePanel: document.getElementById('send-file-panel'),
    shareLinkPanel: document.getElementById('share-link-panel'),
    receiveEnterPanel: document.getElementById('receive-enter-panel'),
    receiveConfirmPanel: document.getElementById('receive-confirm-panel'),
    progressPanel: document.getElementById('transfer-progress-panel'),
    completePanel: document.getElementById('transfer-complete-panel'),

    btnSendMode: document.getElementById('btn-send-mode'),
    btnReceiveMode: document.getElementById('btn-receive-mode'),
    fileInput: document.getElementById('file-input'),
    dropZone: document.getElementById('drop-zone'),
    fileInfoCard: document.getElementById('file-info-card'),
    fileNameText: document.getElementById('file-name'),
    fileSizeText: document.getElementById('file-size'),
    btnRemoveFile: document.getElementById('btn-remove-file'),
    btnGenerateLink: document.getElementById('btn-generate-link'),
    shareUrlInput: document.getElementById('share-url-input'),
    btnCopyUrl: document.getElementById('btn-copy-url'),
    roomCodeDisplay: document.getElementById('room-code-display'),
    qrImg: document.getElementById('qr-code-img'),
    qrPlaceholder: document.getElementById('qr-code-placeholder'),
    waitingStatusText: document.getElementById('waiting-status-text'),
    codeInput: document.getElementById('code-input'),
    btnJoinRoom: document.getElementById('btn-join-room'),

    rxFileIcon: document.getElementById('rx-file-icon'),
    rxFileName: document.getElementById('rx-file-name'),
    rxFileSize: document.getElementById('rx-file-size'),
    browserWarning: document.getElementById('browser-warning'),
    btnRejectTransfer: document.getElementById('btn-reject-transfer'),
    btnAcceptTransfer: document.getElementById('btn-accept-transfer'),

    transferTitle: document.getElementById('transfer-title-text'),
    statProgress: document.getElementById('stat-progress'),
    statSpeed: document.getElementById('stat-speed'),
    statEta: document.getElementById('stat-eta'),
    progressBarFill: document.getElementById('progress-bar-fill'),
    statBytesCounter: document.getElementById('stat-bytes-counter'),
    transferDirectionBadge: document.getElementById('transfer-direction-badge'),
    canvas: document.getElementById('speed-chart'),
    maxSpeedLabel: document.getElementById('max-speed-label'),
    wakeLockCheckbox: document.getElementById('wake-lock-checkbox'),

    summaryFileName: document.getElementById('summary-file-name'),
    summaryFileSize: document.getElementById('summary-file-size'),
    summaryAvgSpeed: document.getElementById('summary-avg-speed'),
    summaryDuration: document.getElementById('summary-duration'),
    btnDone: document.getElementById('btn-done'),

    btnBackInitSend: document.getElementById('btn-back-to-init-send'),
    btnBackFile: document.getElementById('btn-back-to-file'),
    btnBackInitRx: document.getElementById('btn-back-to-init-receive')
};

// ─── Init ────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
    setupEventListeners();
    updateServerStatus('offline', 'Ready (No active transfer)');
    checkUrlForRoom();
    checkFileApiSupport();
});

function checkFileApiSupport() {
    if (!('showSaveFilePicker' in window)) {
        el.browserWarning.classList.remove('hidden');
    }
}

function checkUrlForRoom() {
    const params = new URLSearchParams(window.location.search);
    const roomParam = params.get('room');
    if (roomParam && roomParam.length === 6) {
        state.role = 'receiver';
        state.roomID = roomParam;
        el.codeInput.value = roomParam;
        el.btnJoinRoom.disabled = false;
        showPanel(el.receiveEnterPanel);
        setTimeout(() => joinRoom(), 300);
    }
}

// ─── Event Listeners ─────────────────────────────────────────────────────────

function setupEventListeners() {
    el.btnSendMode.addEventListener('click', () => {
        state.role = 'sender';
        showPanel(el.sendFilePanel);
    });

    el.btnReceiveMode.addEventListener('click', () => {
        state.role = 'receiver';
        showPanel(el.receiveEnterPanel);
    });

    el.btnBackInitSend.addEventListener('click', resetToHome);
    el.btnBackInitRx.addEventListener('click', resetToHome);
    el.btnBackFile.addEventListener('click', () => {
        disconnectWebSocket();
        showPanel(el.sendFilePanel);
    });

    el.dropZone.addEventListener('dragover', (e) => {
        e.preventDefault();
        el.dropZone.classList.add('drag-over');
    });
    el.dropZone.addEventListener('dragleave', () => {
        el.dropZone.classList.remove('drag-over');
    });
    el.dropZone.addEventListener('drop', (e) => {
        e.preventDefault();
        el.dropZone.classList.remove('drag-over');
        if (e.dataTransfer.files.length > 0) handleFileSelection(e.dataTransfer.files[0]);
    });

    el.fileInput.addEventListener('change', (e) => {
        if (e.target.files.length > 0) handleFileSelection(e.target.files[0]);
    });

    el.btnRemoveFile.addEventListener('click', (e) => {
        e.stopPropagation();
        resetFileSelection();
    });

    el.btnGenerateLink.addEventListener('click', () => {
        if (state.file) initializeSenderSignaling();
    });

    el.codeInput.addEventListener('input', () => {
        el.codeInput.value = el.codeInput.value.replace(/[^0-9]/g, '');
        el.btnJoinRoom.disabled = el.codeInput.value.length !== 6;
    });
    el.codeInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !el.btnJoinRoom.disabled) joinRoom();
    });

    el.btnJoinRoom.addEventListener('click', joinRoom);

    el.btnRejectTransfer.addEventListener('click', () => {
        sendSignalingMessage({ type: 'reject-transfer' });
        resetToHome();
    });

    el.btnAcceptTransfer.addEventListener('click', acceptIncomingTransfer);
    el.btnDone.addEventListener('click', resetToHome);

    el.btnCopyUrl.addEventListener('click', async () => {
        try {
            await navigator.clipboard.writeText(el.shareUrlInput.value);
        } catch {
            el.shareUrlInput.select();
            document.execCommand('copy');
        }
        const orig = el.btnCopyUrl.innerHTML;
        el.btnCopyUrl.innerHTML = '<i class="fa-solid fa-check"></i> Copied!';
        setTimeout(() => { el.btnCopyUrl.innerHTML = orig; }, 2000);
    });
}

// ─── Panel Routing ────────────────────────────────────────────────────────────

function showPanel(panelElement) {
    document.querySelectorAll('.panel-section').forEach(s => s.classList.remove('active'));
    panelElement.classList.add('active');
}

function updateServerStatus(status, text) {
    el.dot.className = 'status-dot';
    el.dot.classList.add(`status-${status}`);
    el.text.innerText = text;
}

// ─── File Selection ───────────────────────────────────────────────────────────

function getFileIcon(filename) {
    const ext = filename.split('.').pop().toLowerCase();
    if (['zip', 'rar', '7z', 'tar', 'gz'].includes(ext)) return 'fa-file-zipper';
    if (['mp4', 'mkv', 'avi', 'mov'].includes(ext)) return 'fa-file-video';
    if (['mp3', 'wav', 'flac', 'ogg'].includes(ext)) return 'fa-file-audio';
    if (['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp'].includes(ext)) return 'fa-file-image';
    if (ext === 'pdf') return 'fa-file-pdf';
    if (['txt', 'md', 'json', 'csv'].includes(ext)) return 'fa-file-lines';
    if (['exe', 'msi', 'bat'].includes(ext)) return 'fa-file-code';
    return 'fa-file';
}

function handleFileSelection(file) {
    state.file = file;
    state.fileName = file.name;
    state.fileSize = file.size;
    state.fileType = file.type;

    el.fileNameText.innerText = file.name;
    el.fileSizeText.innerText = formatBytes(file.size);
    el.fileInfoCard.querySelector('i').className = `fa-regular ${getFileIcon(file.name)} file-type-icon`;
    el.fileInfoCard.classList.remove('hidden');
    el.btnGenerateLink.classList.remove('hidden');
}

function resetFileSelection() {
    state.file = state.fileName = state.fileType = null;
    state.fileSize = 0;
    el.fileInput.value = '';
    el.fileInfoCard.classList.add('hidden');
    el.btnGenerateLink.classList.add('hidden');
}

function resetToHome() {
    disconnectWebSocket();
    closePeerConnection();
    resetFileSelection();
    stopRelayKeepalive();
    stopStallDetector();

    // FIX: clear wsKeepalive on reset (was leaking intervals)
    if (state.wsKeepalive) { clearInterval(state.wsKeepalive); state.wsKeepalive = null; }

    Object.assign(state, {
        role: null, roomID: null,
        receivedChunks: [], pendingWrites: [],
        bytesTransferred: 0, speedHistory: [], maxSpeedObserved: 0,
        useWsRelay: false, wsBufferPolling: false, wsRelayOffset: 0, wsChunksInFlight: 0, wsRelayRunning: false, useHttpRelay: false,
        transferAborted: true, isSendingPaused: false, sendOffset: 0,
        stallStrikes: 0, lastBytesAtStallCheck: 0, resumeOffset: 0, isResuming: false,
        webrtcHandshakeTimer: null
    });

    if (state.fileWritable) {
        try { state.fileWritable.close(); } catch (_) { }
        state.fileWritable = null;
    }

    window.history.pushState({}, document.title, window.location.pathname);
    el.codeInput.value = '';
    el.btnJoinRoom.disabled = true;
    showPanel(el.initialPanel);
    updateServerStatus('offline', 'Disconnected');
}

// ─── WebSocket Signaling ──────────────────────────────────────────────────────

function getWsProtocol() {
    return window.location.protocol === 'https:' ? 'wss://' : 'ws://';
}

function initializeSenderSignaling() {
    state.roomID = Math.floor(100000 + Math.random() * 900000).toString();
    showPanel(el.shareLinkPanel);
    el.roomCodeDisplay.innerText = state.roomID;

    const shareUrl = `${window.location.protocol}//${window.location.host}/?room=${state.roomID}`;
    el.shareUrlInput.value = shareUrl;

    el.qrImg.classList.add('hidden');
    el.qrPlaceholder.classList.remove('hidden');
    el.qrImg.src = `https://api.qrserver.com/v1/create-qr-code/?size=150x150&data=${encodeURIComponent(shareUrl)}`;
    el.qrImg.onload = () => {
        el.qrPlaceholder.classList.add('hidden');
        el.qrImg.classList.remove('hidden');
    };

    connectToSignalingServer();
}

function joinRoom() {
    state.roomID = el.codeInput.value;
    if (state.roomID.length !== 6) return;
    connectToSignalingServer();
}

function connectToSignalingServer() {
    disconnectWebSocket();
    updateServerStatus('connecting', 'Connecting to signaling server...');

    const wsUrl = `${getWsProtocol()}${window.location.host}/ws/${state.roomID}`;
    state.ws = new WebSocket(wsUrl);
    state.ws.binaryType = 'arraybuffer';

    state.ws.onopen = () => {
        updateServerStatus('online', 'Connected to Server. Waiting for peer...');

        state.wsKeepalive = setInterval(() => {
            if (state.ws && state.ws.readyState === WebSocket.OPEN) {
                state.ws.send(JSON.stringify({ type: 'ping' }));
            }
        }, 10000);

        if (state.role === 'receiver') {
            showPanel(el.receiveConfirmPanel);
            el.rxFileName.innerText = "Waiting for file info...";
            el.rxFileSize.innerText = "-";
            el.btnAcceptTransfer.disabled = true;
        }
    };

    state.ws.onmessage = async (event) => {
        // ── Binary frame = file chunk in WS relay mode ──
        if (event.data instanceof ArrayBuffer) {
            // FIX: guard against re-entry after transfer completes
            if (state.useWsRelay && state.role === 'receiver' && !state.transferAborted) {
                processIncomingChunk(event.data);
                updateProgressPercentage(state.bytesTransferred, state.fileSize);

                sendSignalingMessage({ type: 'ws-relay-ack' });

                if (state.bytesTransferred >= state.fileSize) {
                    state.transferAborted = true; // prevent double-complete
                    await completeIncomingTransfer();
                }
            }
            return;
        }

        // ── Text frame = JSON signaling message ──
        let msg;
        try { msg = JSON.parse(event.data); }
        catch (e) { console.error("Malformed JSON signal:", event.data); return; }

        switch (msg.type) {

            case 'peer-joined':
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
                            
                            // Timeout WebRTC if network blocks it (common on mobile data)
                            if (state.webrtcHandshakeTimer) clearTimeout(state.webrtcHandshakeTimer);
                            state.webrtcHandshakeTimer = setTimeout(() => {
                                if (state.peerConnection && state.peerConnection.connectionState !== 'connected') {
                                    logger("WebRTC handshake timeout (5s). Falling back to WS Relay.");
                                    initiateWsRelayFallback();
                                }
                            }, 5000);
                        }
                    }
                }
                break;

            case 'offer':
                logger("Received SDP Offer");
                if (state.role === 'receiver') await setupPeerConnection(msg.offer);
                break;

            case 'answer':
                logger("Received SDP Answer");
                if (state.role === 'sender' && state.peerConnection) {
                    await state.peerConnection.setRemoteDescription(
                        new RTCSessionDescription(msg.answer)
                    );
                }
                break;

            case 'candidate':
                if (state.peerConnection && msg.candidate) {
                    try {
                        await state.peerConnection.addIceCandidate(
                            new RTCIceCandidate(msg.candidate)
                        );
                    } catch (e) { console.error("ICE candidate error:", e); }
                }
                break;

            // ── WS Relay signaling ──
            case 'ws-relay-start':
                logger("Received WS Relay start signal");
                if (state.role === 'receiver') {
                    state.fileName = msg.name;
                    state.fileSize = msg.size;
                    state.fileType = msg.mime;
                    state.useWsRelay = true;

                    el.rxFileName.innerText = msg.name;
                    el.rxFileSize.innerText = formatBytes(msg.size);
                    el.rxFileIcon.className = `fa-regular ${getFileIcon(msg.name)} file-type-icon large`;
                    el.btnAcceptTransfer.disabled = false;
                    el.waitingStatusText.innerText = "P2P unavailable. Using WS relay. Click Accept.";
                    showPanel(el.receiveConfirmPanel);
                }
                break;

            case 'ws-relay-ready':
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
                break;

            case 'ws-relay-ack':
                if (state.role === 'sender' && state.useWsRelay) {
                    state.wsChunksInFlight = Math.max(0, state.wsChunksInFlight - 1);

                    if (state.wsRelayOffset >= state.fileSize && state.wsChunksInFlight === 0) {
                        if (!state.transferAborted) completeFileTransfer();
                    } else if (!state.wsBufferPolling && !state.wsRelayRunning && state.wsRelayOffset < state.fileSize) {
                        // Only call if loop isn't already running — guard prevents double-pump
                        streamNextWsChunk();
                    }
                }
                break;

            // ── HTTP Relay signaling ──
            case 'http-relay-start':
                logger("Received HTTP Relay start signal");
                if (state.role === 'receiver') {
                    state.fileName = msg.name;
                    state.fileSize = msg.size;
                    state.fileType = msg.mime;
                    state.useHttpRelay = true;

                    el.rxFileName.innerText = msg.name;
                    el.rxFileSize.innerText = formatBytes(msg.size);
                    el.rxFileIcon.className = `fa-regular ${getFileIcon(msg.name)} file-type-icon large`;
                    el.btnAcceptTransfer.disabled = false;
                    el.waitingStatusText.innerText = "P2P unavailable. Using HTTP relay. Click Accept.";
                    showPanel(el.receiveConfirmPanel);
                }
                break;

            case 'http-relay-ready':
                logger("Receiver ready. Starting HTTP relay upload...");
                if (state.role === 'sender') startHttpFileTransfer();
                break;

            case 'reject-transfer':
                alert("Receiver declined the transfer.");
                resetToHome();
                break;

            // FIX: peer-left was missing — transfer would just freeze silently
            case 'peer-left':
                logger("Peer disconnected.");
                if (!state.transferAborted) {
                    handlePeerDisconnection("The other peer disconnected.");
                }
                break;

            case 'ping':
                // Ignore keepalive pings forwarded from peer
                break;
        }
    };

    state.ws.onerror = (e) => {
        logger("WebSocket error.");
        updateServerStatus('offline', 'Connection error.');
    };

    // FIX: was defined twice — second definition silently overwrote the first,
    // meaning wsKeepalive was never cleared and peer disconnect was never handled
    state.ws.onclose = () => {
        if (state.wsKeepalive) { clearInterval(state.wsKeepalive); state.wsKeepalive = null; }
        logger("Disconnected from signaling server.");
        if (state.bytesTransferred > 0 && state.bytesTransferred < state.fileSize && !state.transferAborted) {
            handlePeerDisconnection("Signaling server disconnected.");
        }
    };
}

function disconnectWebSocket() {
    if (state.ws) {
        state.ws.onmessage = null;
        state.ws.onclose = null;
        state.ws.onerror = null;
        state.ws.close();
        state.ws = null;
    }
}

function sendSignalingMessage(message) {
    if (state.ws && state.ws.readyState === WebSocket.OPEN) {
        state.ws.send(JSON.stringify(message));
    }
}

// ─── WebRTC Peer Connection ───────────────────────────────────────────────────

async function setupPeerConnection(incomingOffer = null) {
    closePeerConnection();
    state.peerConnection = new RTCPeerConnection(ICE_CONFIG);

    state.peerConnection.onicecandidate = (event) => {
        if (event.candidate) {
            sendSignalingMessage({ type: 'candidate', candidate: event.candidate });
        }
    };

    state.peerConnection.onconnectionstatechange = () => {
        if (!state.peerConnection) return;
        const s = state.peerConnection.connectionState;
        logger(`WebRTC State: ${s}`);

        if (s === 'connected') {
            if (state.disconnectTimer) {
                clearTimeout(state.disconnectTimer);
                state.disconnectTimer = null;
            }
        } else if (s === 'disconnected') {
            state.disconnectTimer = setTimeout(() => {
                if (state.peerConnection && state.peerConnection.connectionState !== 'connected') {
                    if (!state.useWsRelay && !state.useHttpRelay) initiateWsRelayFallback();
                    else handlePeerDisconnection("P2P connection lost.");
                }
            }, 5000);
        } else if (s === 'failed') {
            if (state.disconnectTimer) { clearTimeout(state.disconnectTimer); state.disconnectTimer = null; }
            if (!state.useWsRelay && !state.useHttpRelay) initiateWsRelayFallback();
            else handlePeerDisconnection("Direct P2P connection failed.");
        }
    };

    if (state.role === 'sender') {
        state.dataChannel = state.peerConnection.createDataChannel('warp-channel', { ordered: true });
        setupDataChannelHandlers();

        const offer = await state.peerConnection.createOffer();
        await state.peerConnection.setLocalDescription(offer);
        sendSignalingMessage({ type: 'offer', offer });

    } else {
        state.peerConnection.ondatachannel = (event) => {
            state.dataChannel = event.channel;
            setupDataChannelHandlers();
        };

        await state.peerConnection.setRemoteDescription(new RTCSessionDescription(incomingOffer));
        const answer = await state.peerConnection.createAnswer();
        await state.peerConnection.setLocalDescription(answer);
        sendSignalingMessage({ type: 'answer', answer });
    }
}

function closePeerConnection() {
    if (state.dataChannel) {
        state.dataChannel.onopen = state.dataChannel.onmessage =
            state.dataChannel.onclose = null;
        state.dataChannel.close();
        state.dataChannel = null;
    }
    if (state.peerConnection) {
        state.peerConnection.onconnectionstatechange =
            state.peerConnection.onicecandidate =
            state.peerConnection.ondatachannel = null;
        state.peerConnection.close();
        state.peerConnection = null;
    }
}

// ─── WebRTC Data Channel ──────────────────────────────────────────────────────

function setupDataChannelHandlers() {
    state.dataChannel.binaryType = 'arraybuffer';

    state.dataChannel.onopen = () => {
        logger("P2P Data Channel Open!");
        if (state.webrtcHandshakeTimer) {
            clearTimeout(state.webrtcHandshakeTimer);
            state.webrtcHandshakeTimer = null;
        }
        updateServerStatus('online', 'P2P Link Secured.');
        if (state.role === 'sender') {
            state.dataChannel.send(JSON.stringify({
                type: 'metadata',
                name: state.fileName,
                size: state.fileSize,
                mime: state.fileType
            }));
            el.waitingStatusText.innerText = "Secure P2P link open. Preparing transfer...";
        }
    };

    state.dataChannel.onmessage = async (event) => {
        const data = event.data;

        if (typeof data === 'string') {
            let msg;
            try { msg = JSON.parse(data); }
            catch (e) { console.error("Bad data channel JSON:", data); return; }

            switch (msg.type) {
                case 'metadata':
                    logger("Received metadata: " + msg.name);
                    state.fileName = msg.name;
                    state.fileSize = msg.size;
                    state.fileType = msg.mime;
                    el.rxFileName.innerText = msg.name;
                    el.rxFileSize.innerText = formatBytes(msg.size);
                    el.rxFileIcon.className = `fa-regular ${getFileIcon(msg.name)} file-type-icon large`;
                    el.btnAcceptTransfer.disabled = false;
                    break;

                case 'ready':
                    logger("Receiver ready. Starting P2P stream...");
                    startFileTransfer();
                    break;

                case 'eof':
                    logger("EOF received.");
                    await completeIncomingTransfer();
                    break;
            }
        } else {
            processIncomingChunk(data);
        }
    };

    state.dataChannel.onclose = () => logger("Data Channel Closed.");

    if (state.role === 'sender') {
        state.dataChannel.bufferedAmountLowThreshold = BUFFER_LOW_THRESHOLD;
        state.dataChannel.onbufferedamountlow = () => {
            if (state.isSendingPaused) {
                state.isSendingPaused = false;
                streamNextChunks();
            }
        };
    }
}

// ─── WebRTC Sender ────────────────────────────────────────────────────────────

function startFileTransfer() {
    initTransferState();
    showPanel(el.progressPanel);
    updateProgressPercentage(0, state.fileSize, true);
    el.transferTitle.innerText = "Uploading File... (P2P)";
    el.transferDirectionBadge.innerHTML = '<i class="fa-solid fa-arrow-up"></i> Sending';
    requestWakeLock();
    startSpeedMetricsTracker();
    streamNextChunks();
}

async function streamNextChunks() {
    while (state.sendOffset < state.fileSize) {
        if (state.dataChannel.bufferedAmount > BUFFER_HIGH_WATERMARK) {
            state.isSendingPaused = true;
            return;
        }

        const end = Math.min(state.sendOffset + CHUNK_SIZE, state.fileSize);
        const slice = state.file.slice(state.sendOffset, end);

        try {
            const buffer = await slice.arrayBuffer();
            state.dataChannel.send(buffer);
            state.sendOffset = end;
            state.bytesTransferred = end;
            updateProgressPercentage(state.bytesTransferred, state.fileSize);
        } catch (e) {
            console.error("Chunk send error:", e);
            handlePeerDisconnection("Transmission error.");
            return;
        }
    }

    if (state.sendOffset >= state.fileSize && !state.isSendingPaused) {
        const waitForDrain = () => {
            if (state.dataChannel.bufferedAmount === 0) {
                state.dataChannel.send(JSON.stringify({ type: 'eof' }));
                completeFileTransfer();
            } else {
                setTimeout(waitForDrain, 100);
            }
        };
        waitForDrain();
    }
}

// ─── WebRTC Receiver ──────────────────────────────────────────────────────────

async function acceptIncomingTransfer() {
    if ('showSaveFilePicker' in window) {
        try {
            state.fileHandle = await window.showSaveFilePicker({ suggestedName: state.fileName });
            state.fileWritable = await state.fileHandle.createWritable();
            state.pendingWrites = [];
            logger("File System Writable Stream initialized.");
        } catch (e) {
            logger("Save dialog cancelled: " + e);
            return;
        }
    } else {
        state.receivedChunks = [];
        logger("Using RAM buffer fallback.");
    }

    initTransferState();
    showPanel(el.progressPanel);
    updateProgressPercentage(0, state.fileSize, true);
    el.transferDirectionBadge.innerHTML = '<i class="fa-solid fa-arrow-down"></i> Receiving';

    requestWakeLock();
    startRelayKeepalive();
    startSpeedMetricsTracker();

    if (state.useWsRelay) {
        el.transferTitle.innerText = "Downloading File... (WS Relay)";
        if (typeof startStallDetector === 'function') startStallDetector();
        sendSignalingMessage({ type: 'ws-relay-ready' });
    } else if (state.useHttpRelay) {
        el.transferTitle.innerText = "Downloading File... (HTTP Relay)";
        sendSignalingMessage({ type: 'http-relay-ready' });
        startHttpDownloadLoop();
    } else {
        el.transferTitle.innerText = "Downloading File... (P2P)";
        state.dataChannel.send(JSON.stringify({ type: 'ready' }));
    }
}

function processIncomingChunk(arrayBuffer) {
    try {
        if (state.fileWritable) {
            const writePromise = state.fileWritable.write(arrayBuffer).catch(e => {
                console.error("Write error:", e);
                handlePeerDisconnection("Local file write failed.");
            });
            state.pendingWrites.push(writePromise);

            if (state.pendingWrites.length > 50) {
                state.pendingWrites = state.pendingWrites.filter(p => {
                    let settled = false;
                    p.then(() => { settled = true; }).catch(() => { settled = true; });
                    return !settled;
                });
            }
        } else {
            state.receivedChunks.push(arrayBuffer);
        }
        state.bytesTransferred += arrayBuffer.byteLength;
    } catch (e) {
        console.error("Error processing chunk:", e);
        handlePeerDisconnection("Chunk processing error.");
    }
}

async function completeIncomingTransfer() {
    stopSpeedMetricsTracker();
    releaseWakeLock();
    stopRelayKeepalive();

    const durationMs = Date.now() - state.transferStartTime;
    const avgSpeedBytes = state.bytesTransferred / (durationMs / 1000);

    if (state.fileWritable) {
        try {
            await Promise.all(state.pendingWrites);
            await state.fileWritable.close();
            state.fileWritable = null;
            state.pendingWrites = [];
            logger("File saved and stream closed.");
        } catch (e) {
            console.error("Error closing writable stream:", e);
        }
    } else {
        try {
            el.transferTitle.innerText = "Compiling file...";
            const blob = new Blob(state.receivedChunks, {
                type: state.fileType || 'application/octet-stream'
            });
            state.receivedChunks = [];

            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = state.fileName;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            setTimeout(() => URL.revokeObjectURL(url), 5000);
        } catch (e) {
            alert("File assembly failed (memory limit). Use Chrome/Edge for large files.");
            resetToHome();
            return;
        }
    }

    updateProgressPercentage(state.fileSize, state.fileSize, true);
    showSuccessScreen(durationMs, avgSpeedBytes);
}

// ─── WS Relay Fallback ────────────────────────────────────────────────────────

function initiateWsRelayFallback() {
    logger("Initiating WS Relay fallback...");
    state.useWsRelay = true;
    closePeerConnection();

    if (state.role === 'sender') {
        el.waitingStatusText.innerText = "P2P failed. Switched to relay. Waiting for receiver...";
        sendSignalingMessage({
            type: 'ws-relay-start',
            name: state.fileName,
            size: state.fileSize,
            mime: state.fileType
        });
    }
}

function startWsRelayTransfer() {
    initTransferState();
    state.wsRelayOffset = 0;
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
}

async function streamNextWsChunk() {
    if (state.transferAborted) return;

    // Guard: only one concurrent instance allowed.
    // ACKs can call this while the loop is still awaiting arrayBuffer() —
    // without this guard two concurrent loops both advance wsRelayOffset,
    // chunks get skipped and the transfer corrupts then stalls.
    if (state.wsRelayRunning) return;
    state.wsRelayRunning = true;

    try {
        while (state.wsChunksInFlight < state.maxWsChunksInFlight && state.wsRelayOffset < state.fileSize) {
            if (state.transferAborted) return;

            // Socket buffer safeguard — pause if browser buffer is backed up
            if (state.ws && state.ws.bufferedAmount > 8 * 1024 * 1024) {
                state.wsRelayRunning = false; // release lock while waiting
                if (state.wsBufferPolling) return;
                state.wsBufferPolling = true;
                const wait = () => {
                    if (state.transferAborted) return;
                    if (state.ws.bufferedAmount < 2 * 1024 * 1024) {
                        state.wsBufferPolling = false;
                        streamNextWsChunk(); // re-enter with guard
                    } else {
                        setTimeout(wait, 50);
                    }
                };
                setTimeout(wait, 50);
                return;
            }

            const currentStart = state.wsRelayOffset;
            const end = Math.min(currentStart + WS_CHUNK_SIZE, state.fileSize);
            const slice = state.file.slice(currentStart, end);

            state.wsRelayOffset = end; // advance before await — safe because wsRelayRunning guards re-entry

            let buffer;
            try {
                buffer = await slice.arrayBuffer();
            } catch (e) {
                console.error("File read error:", e);
                handlePeerDisconnection("File read failed.");
                return;
            }

            if (state.transferAborted) return;

            if (!state.ws || state.ws.readyState !== WebSocket.OPEN) {
                handlePeerDisconnection("Connection dropped during relay.");
                return;
            }

            state.wsChunksInFlight++;
            state.ws.send(buffer);

            state.bytesTransferred = end;
            updateProgressPercentage(state.bytesTransferred, state.fileSize);
        }
    } finally {
        // Always release the lock when the loop exits for any reason
        state.wsRelayRunning = false;
    }
}

// ─── HTTP Relay Fallback ──────────────────────────────────────────────────────

function initiateHttpRelayFallback() {
    logger("Initiating HTTP Relay fallback...");
    state.useHttpRelay = true;
    closePeerConnection();

    if (state.role === 'sender') {
        el.waitingStatusText.innerText = "P2P failed. Switched to HTTP Relay fallback. Waiting for receiver...";
        sendSignalingMessage({
            type: 'http-relay-start',
            name: state.fileName,
            size: state.fileSize,
            mime: state.fileType
        });
    } else {
        el.waitingStatusText.innerText = "P2P failed. Switched to HTTP Relay fallback. Waiting for file info...";
    }
}

function startHttpFileTransfer() {
    initTransferState();
    showPanel(el.progressPanel);
    updateProgressPercentage(0, state.fileSize, true);
    el.transferTitle.innerText = "Uploading File... (HTTP Relay)";
    el.transferDirectionBadge.innerHTML = '<i class="fa-solid fa-arrow-up"></i> Sending';

    requestWakeLock();
    startRelayKeepalive();
    startSpeedMetricsTracker();
    startHttpUploadLoop();
}

async function startHttpUploadLoop() {
    const HTTP_CHUNK_SIZE = 4 * 1024 * 1024;
    const MAX_QUEUE_SIZE = 2;
    const chunkQueue = [];
    let readOffset = 0;
    let retryCount = 0;

    async function refillQueue() {
        while (chunkQueue.length < MAX_QUEUE_SIZE && readOffset < state.fileSize && !state.transferAborted) {
            const currentStart = readOffset;
            const end = Math.min(currentStart + HTTP_CHUNK_SIZE, state.fileSize);
            const slice = state.file.slice(currentStart, end);
            readOffset = end;

            const promise = slice.arrayBuffer().then(buffer => ({
                buffer: buffer,
                offsetEnd: end
            }));
            chunkQueue.push(promise);
        }
    }

    while (state.sendOffset < state.fileSize) {
        if (state.transferAborted) break;
        refillQueue();

        const currentChunkPromise = chunkQueue.shift();
        if (!currentChunkPromise) {
            await new Promise(r => setTimeout(r, 50));
            continue;
        }

        const currentChunk = await currentChunkPromise;

        try {
            const formData = new FormData();
            const blob = new Blob([currentChunk.buffer], { type: 'application/octet-stream' });
            formData.append('file', blob, state.fileName);

            const response = await fetch(`/relay/upload/${state.roomID}`, {
                method: 'POST',
                body: formData
            });

            if (response.status === 408) {
                logger("Upload chunk timeout (408), retrying...");
                chunkQueue.unshift(Promise.resolve(currentChunk));
                await new Promise(r => setTimeout(r, 1000));
                continue;
            }

            if (!response.ok) {
                throw new Error(`Server returned HTTP ${response.status}`);
            }

            state.sendOffset = currentChunk.offsetEnd;
            state.bytesTransferred = currentChunk.offsetEnd;
            updateProgressPercentage(state.bytesTransferred, state.fileSize);
            retryCount = 0;
        } catch (e) {
            console.error("HTTP Relay Upload error:", e);
            retryCount++;
            if (retryCount > 10) {
                handlePeerDisconnection("HTTP Relay upload failed after multiple retries.");
                return;
            }
            chunkQueue.unshift(Promise.resolve(currentChunk));
            logger(`Retrying upload (${retryCount}/10) in 1.5s...`);
            await new Promise(r => setTimeout(r, 1500));
        }
    }

    if (state.sendOffset >= state.fileSize) {
        setTimeout(() => {
            fetch(`/relay/cleanup/${state.roomID}`, { method: 'POST' }).catch(console.error);
        }, 2000);
        completeFileTransfer();
    }
}

async function startHttpDownloadLoop() {
    state.transferAborted = false;
    let retryCount = 0;
    const downloadQueue = [];
    const MAX_DOWNLOAD_QUEUE = 2;

    function fillDownloadQueue() {
        let currentFetchingOffset = state.bytesTransferred + (downloadQueue.length * 4 * 1024 * 1024);

        while (downloadQueue.length < MAX_DOWNLOAD_QUEUE && currentFetchingOffset < state.fileSize && !state.transferAborted) {
            const fetchPromise = fetch(`/relay/download/${state.roomID}`).then(async (response) => {
                if (response.status === 408) return { status: 408 };
                if (!response.ok) throw new Error(`Server returned HTTP ${response.status}`);

                const arrayBuffer = await response.arrayBuffer();
                if (arrayBuffer.byteLength === 0) throw new Error("Empty chunk received");
                return { status: 200, buffer: arrayBuffer };
            });

            downloadQueue.push(fetchPromise);
            currentFetchingOffset += 4 * 1024 * 1024;
        }
    }

    while (state.bytesTransferred < state.fileSize) {
        if (state.transferAborted) break;
        fillDownloadQueue();

        const nextChunkPromise = downloadQueue.shift();
        if (!nextChunkPromise) {
            await new Promise(r => setTimeout(r, 50));
            continue;
        }

        try {
            const chunkResult = await nextChunkPromise;

            if (chunkResult.status === 408) {
                logger("Download chunk timeout (408), retrying slot...");
                await new Promise(r => setTimeout(r, 1000));
                continue;
            }

            processIncomingChunk(chunkResult.buffer);
            updateProgressPercentage(state.bytesTransferred, state.fileSize);
            retryCount = 0;
        } catch (e) {
            console.error("HTTP Relay Download error:", e);
            retryCount++;
            if (retryCount > 10) {
                handlePeerDisconnection("HTTP Relay download failed after multiple retries.");
                return;
            }
            logger(`Retrying download (${retryCount}/10) in 1.5s...`);
            await new Promise(r => setTimeout(r, 1500));
        }
    }

    if (state.bytesTransferred >= state.fileSize) {
        completeIncomingTransfer();
    }
}

// ─── Transfer Complete (Sender) ───────────────────────────────────────────────

function completeFileTransfer() {
    updateProgressPercentage(state.fileSize, state.fileSize, true);
    stopSpeedMetricsTracker();
    releaseWakeLock();
    stopRelayKeepalive();

    const durationMs = Date.now() - state.transferStartTime;
    const avgSpeedBytes = state.bytesTransferred / (durationMs / 1000);
    showSuccessScreen(durationMs, avgSpeedBytes);
}

// ─── Progress & Stats UI ──────────────────────────────────────────────────────

function initTransferState() {
    state.bytesTransferred = 0;
    state.sendOffset = 0;
    state.isSendingPaused = false;
    state.transferStartTime = Date.now();
    state.lastLoggedBytes = 0;
    state.lastSpeedTickTime = Date.now();
    state.speedHistory = [];
    state.maxSpeedObserved = 0;
    state.lastUiUpdateTime = 0;
    state.transferAborted = false;
}

function updateProgressPercentage(transferred, total, force = false) {
    const now = Date.now();
    if (!force && now - state.lastUiUpdateTime < 100) return;
    state.lastUiUpdateTime = now;

    const pct = ((transferred / total) * 100).toFixed(1);
    el.statProgress.innerText = `${pct}%`;
    el.progressBarFill.style.width = `${pct}%`;
    el.statBytesCounter.innerText = `${formatBytes(transferred)} / ${formatBytes(total)}`;
}

function startSpeedMetricsTracker() {
    state.speedTickInterval = setInterval(() => {
        const now = Date.now();
        const deltaMs = now - state.lastSpeedTickTime;
        const deltaBytes = state.bytesTransferred - state.lastLoggedBytes;
        if (deltaMs <= 0) return;

        const speedBps = deltaBytes / (deltaMs / 1000);
        const speedMbps = speedBps / (1024 * 1024);

        state.speedHistory.push(speedMbps);
        if (state.speedHistory.length > 60) state.speedHistory.shift();

        if (speedMbps > state.maxSpeedObserved) {
            state.maxSpeedObserved = speedMbps;
            el.maxSpeedLabel.innerText = `Max: ${speedMbps.toFixed(1)} MB/s`;
        }

        el.statSpeed.innerText = `${speedMbps.toFixed(1)} MB/s`;

        const bytesLeft = state.fileSize - state.bytesTransferred;
        el.statEta.innerText = speedBps > 0
            ? formatTime(Math.round(bytesLeft / speedBps))
            : "Stalled";

        drawSpeedHistoryChart();

        state.lastLoggedBytes = state.bytesTransferred;
        state.lastSpeedTickTime = now;
    }, 1000);
}

function stopSpeedMetricsTracker() {
    if (state.speedTickInterval) {
        clearInterval(state.speedTickInterval);
        state.speedTickInterval = null;
    }
}

function drawSpeedHistoryChart() {
    const ctx = el.canvas.getContext('2d');
    const width = el.canvas.width;
    const height = el.canvas.height;
    ctx.clearRect(0, 0, width, height);

    if (state.speedHistory.length === 0) return;

    ctx.strokeStyle = 'rgba(255,255,255,0.03)';
    ctx.lineWidth = 1;
    for (let i = 1; i < 4; i++) {
        const y = (height / 4) * i;
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(width, y); ctx.stroke();
    }

    const points = state.speedHistory;
    const maxVal = Math.max(...points, 1);
    const padding = 10;

    const gradient = ctx.createLinearGradient(0, height - padding, 0, padding);
    gradient.addColorStop(1, 'rgba(6, 182, 212, 0.4)');
    gradient.addColorStop(0, 'rgba(139, 92, 246, 0.0)');

    ctx.beginPath();
    for (let i = 0; i < points.length; i++) {
        const x = (width / 59) * i;
        const valRatio = points[i] / maxVal;
        const y = height - padding - (valRatio * (height - padding * 2));
        if (i === 0) {
            ctx.moveTo(x, y);
        } else {
            const prevX = (width / 59) * (i - 1);
            const prevY = height - padding - (points[i - 1] / maxVal * (height - padding * 2));
            ctx.bezierCurveTo((prevX + x) / 2, prevY, (prevX + x) / 2, y, x, y);
        }
    }

    ctx.strokeStyle = '#06b6d4';
    ctx.lineWidth = 2.5;
    ctx.shadowBlur = 4;
    ctx.shadowColor = 'rgba(6, 182, 212, 0.5)';
    ctx.stroke();

    ctx.shadowBlur = 0;
    const lastX = (width / 59) * (points.length - 1);
    ctx.lineTo(lastX, height); ctx.lineTo(0, height); ctx.closePath();
    ctx.fillStyle = gradient;
    ctx.fill();
}

function showSuccessScreen(durationMs, avgSpeedBytes) {
    el.summaryFileName.innerText = state.fileName;
    el.summaryFileSize.innerText = formatBytes(state.fileSize);
    el.summaryAvgSpeed.innerText = `${(avgSpeedBytes / (1024 * 1024)).toFixed(1)} MB/s`;
    el.summaryDuration.innerText = formatTime(Math.round(durationMs / 1000));

    el.completePanel.querySelector('#complete-subtext').innerText =
        state.role === 'sender'
            ? "File successfully sent to your peer."
            : "File successfully saved to your device.";

    showPanel(el.completePanel);
}

function handlePeerDisconnection(reasonText) {
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
        const msg = `${reasonText}\n\nTransfer was at ${pct}% (${formatBytes(state.bytesTransferred)}).\n\nReconnect to resume from where it stopped?`;

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
}

// ─── Stall Detector ──────────────────────────────────────────────────────────
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

        // If we are actively polling the buffer to drain, we are NOT stalled.
        // We are just waiting for a slow network connection to send the data!
        if (state.wsBufferPolling) {
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

// ─── Wake Lock ────────────────────────────────────────────────────────────────

async function requestWakeLock() {
    if (!el.wakeLockCheckbox.checked) return;
    if ('wakeLock' in navigator) {
        try {
            state.wakeLock = await navigator.wakeLock.request('screen');
            logger("Wake Lock activated.");
        } catch (e) { console.error("Wake Lock failed:", e); }
    }
}

function releaseWakeLock() {
    if (state.wakeLock) {
        state.wakeLock.release().then(() => { state.wakeLock = null; });
    }
}

// ─── Relay Keepalive (prevents Render free tier sleep) ───────────────────────

function startRelayKeepalive() {
    stopRelayKeepalive();
    state.relayKeepalive = setInterval(() => {
        fetch('/ping').catch(() => { });
    }, 20000);
}

function stopRelayKeepalive() {
    if (state.relayKeepalive) {
        clearInterval(state.relayKeepalive);
        state.relayKeepalive = null;
    }
}

// ─── Utility ──────────────────────────────────────────────────────────────────

function formatBytes(bytes, decimals = 2) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

function formatTime(seconds) {
    if (seconds === Infinity || isNaN(seconds)) return 'Calculating...';
    if (seconds < 60) return `${seconds}s`;
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    if (m < 60) return `${m}m ${s}s`;
    const h = Math.floor(m / 60);
    const rm = m % 60;
    return `${h}h ${rm}m`;
}

function logger(msg) {
    console.log(`[WarpDrop] ${new Date().toISOString().substring(11, 19)}: ${msg}`);
}