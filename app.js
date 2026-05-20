// Global application state
const state = {
    role: null,                // 'sender' or 'receiver'
    roomID: null,
    ws: null,                  // WebSocket signaling connection
    peerConnection: null,
    dataChannel: null,

    // File parameters
    file: null,                // File object (for sender)
    fileName: null,
    fileSize: 0,
    fileType: null,

    // Download parameters (for receiver)
    fileHandle: null,
    fileWritable: null,        // FileSystemWritableFileStream
    receivedChunks: [],        // Fallback buffer for non-Chromium browsers

    // Transfer progress metrics
    bytesTransferred: 0,
    transferStartTime: 0,
    lastLoggedBytes: 0,
    lastSpeedTickTime: 0,
    speedHistory: [],          // array of speed data points (in MB/s)
    speedTickInterval: null,
    maxSpeedObserved: 0,

    // Flow control markers
    isSendingPaused: false,
    sendOffset: 0,

    // Wake Lock
    wakeLock: null,

    // UI throttling
    lastUiUpdateTime: 0
};

// WebRTC constants
const CHUNK_SIZE = 64 * 1024; // 64KB chunks (safe standard for browser WebRTC)
const BUFFER_HIGH_WATERMARK = 4 * 1024 * 1024; // 4MB maximum buffer
const BUFFER_LOW_THRESHOLD = 1 * 1024 * 1024; // 1MB threshold to resume sending
const ICE_CONFIG = {
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun2.l.google.com:19302' }
    ]
};

// Dom Elements
const el = {
    dot: document.getElementById('connection-dot'),
    text: document.getElementById('connection-text'),

    // Panels
    initialPanel: document.getElementById('initial-panel'),
    sendFilePanel: document.getElementById('send-file-panel'),
    shareLinkPanel: document.getElementById('share-link-panel'),
    receiveEnterPanel: document.getElementById('receive-enter-panel'),
    receiveConfirmPanel: document.getElementById('receive-confirm-panel'),
    progressPanel: document.getElementById('transfer-progress-panel'),
    completePanel: document.getElementById('transfer-complete-panel'),

    // Inputs/Buttons
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

    // Receiver Info
    rxFileIcon: document.getElementById('rx-file-icon'),
    rxFileName: document.getElementById('rx-file-name'),
    rxFileSize: document.getElementById('rx-file-size'),
    browserWarning: document.getElementById('browser-warning'),
    btnRejectTransfer: document.getElementById('btn-reject-transfer'),
    btnAcceptTransfer: document.getElementById('btn-accept-transfer'),

    // Progress UI
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

    // Success Summary
    summaryFileName: document.getElementById('summary-file-name'),
    summaryFileSize: document.getElementById('summary-file-size'),
    summaryAvgSpeed: document.getElementById('summary-avg-speed'),
    summaryDuration: document.getElementById('summary-duration'),
    btnDone: document.getElementById('btn-done'),

    // Back Buttons
    btnBackInitSend: document.getElementById('btn-back-to-init-send'),
    btnBackFile: document.getElementById('btn-back-to-file'),
    btnBackInitRx: document.getElementById('btn-back-to-init-receive')
};

// Initialize Application
document.addEventListener('DOMContentLoaded', () => {
    setupEventListeners();
    updateServerStatus('offline', 'Ready (No active transfer)');
    checkUrlForRoom();
    checkFileApiSupport();
});

// Detect browser file save capability (Chromium File System Access API)
function checkFileApiSupport() {
    const isSupported = 'showSaveFilePicker' in window;
    if (!isSupported) {
        el.browserWarning.classList.remove('hidden');
    }
}

// Check URL parameters for direct room joining
function checkUrlForRoom() {
    const params = new URLSearchParams(window.location.search);
    const roomParam = params.get('room');
    if (roomParam && roomParam.length === 6) {
        state.role = 'receiver';
        state.roomID = roomParam;
        showPanel(el.receiveEnterPanel);
        el.codeInput.value = roomParam;
        el.btnJoinRoom.disabled = false;
        // Auto-join if user comes from link
        joinRoom();
    }
}

function setupEventListeners() {
    // Mode Choices
    el.btnSendMode.addEventListener('click', () => {
        state.role = 'sender';
        showPanel(el.sendFilePanel);
    });

    el.btnReceiveMode.addEventListener('click', () => {
        state.role = 'receiver';
        showPanel(el.receiveEnterPanel);
    });

    // Navigation back buttons
    el.btnBackInitSend.addEventListener('click', resetToHome);
    el.btnBackInitRx.addEventListener('click', resetToHome);
    el.btnBackFile.addEventListener('click', () => {
        disconnectWebSocket();
        showPanel(el.sendFilePanel);
    });

    // Drag & Drop Handlers
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
        if (e.dataTransfer.files.length > 0) {
            handleFileSelection(e.dataTransfer.files[0]);
        }
    });

    el.fileInput.addEventListener('change', (e) => {
        if (e.target.files.length > 0) {
            handleFileSelection(e.target.files[0]);
        }
    });

    el.btnRemoveFile.addEventListener('click', (e) => {
        e.stopPropagation();
        resetFileSelection();
    });

    el.btnGenerateLink.addEventListener('click', () => {
        if (state.file) {
            initializeSenderSignaling();
        }
    });

    // Receiver Input
    el.codeInput.addEventListener('input', () => {
        el.codeInput.value = el.codeInput.value.replace(/[^0-9]/g, '');
        el.btnJoinRoom.disabled = el.codeInput.value.length !== 6;
    });

    el.btnJoinRoom.addEventListener('click', joinRoom);

    // Receiver confirmation screen
    el.btnRejectTransfer.addEventListener('click', () => {
        sendSignalingMessage({ type: 'reject-transfer' });
        resetToHome();
    });

    el.btnAcceptTransfer.addEventListener('click', acceptIncomingTransfer);

    // Done Button
    el.btnDone.addEventListener('click', resetToHome);

    // Copy URL helper
    el.btnCopyUrl.addEventListener('click', () => {
        el.shareUrlInput.select();
        document.execCommand('copy');

        const originalText = el.btnCopyUrl.innerHTML;
        el.btnCopyUrl.innerHTML = '<i class="fa-solid fa-check"></i> Copied!';
        setTimeout(() => {
            el.btnCopyUrl.innerHTML = originalText;
        }, 2000);
    });
}

function showPanel(panelElement) {
    // Hide all panel sections
    document.querySelectorAll('.panel-section').forEach(section => {
        section.classList.remove('active');
    });
    // Show target section
    panelElement.classList.add('active');
}

function updateServerStatus(status, text) {
    el.dot.className = 'status-dot';
    el.dot.classList.add(`status-${status}`);
    el.text.innerText = text;
}

function handleFileSelection(file) {
    state.file = file;
    state.fileName = file.name;
    state.fileSize = file.size;
    state.fileType = file.type;

    el.fileNameText.innerText = file.name;
    el.fileSizeText.innerText = formatBytes(file.size);

    // Dynamically assign icon class based on file extension
    const extension = file.name.split('.').pop().toLowerCase();
    let iconClass = 'fa-file';
    if (['zip', 'rar', '7z', 'tar', 'gz'].includes(extension)) iconClass = 'fa-file-zipper';
    else if (['mp4', 'mkv', 'avi', 'mov'].includes(extension)) iconClass = 'fa-file-video';
    else if (['mp3', 'wav', 'flac', 'ogg'].includes(extension)) iconClass = 'fa-file-audio';
    else if (['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp'].includes(extension)) iconClass = 'fa-file-image';
    else if (['pdf'].includes(extension)) iconClass = 'fa-file-pdf';
    else if (['txt', 'md', 'json', 'csv'].includes(extension)) iconClass = 'fa-file-lines';
    else if (['exe', 'msi', 'bat'].includes(extension)) iconClass = 'fa-file-code';

    el.fileInfoCard.querySelector('i').className = `fa-regular ${iconClass} file-type-icon`;

    el.fileInfoCard.classList.remove('hidden');
    el.btnGenerateLink.classList.remove('hidden');
}

function resetFileSelection() {
    state.file = null;
    state.fileName = null;
    state.fileSize = 0;
    state.fileType = null;
    el.fileInput.value = '';
    el.fileInfoCard.classList.add('hidden');
    el.btnGenerateLink.classList.add('hidden');
}

function resetToHome() {
    disconnectWebSocket();
    closePeerConnection();
    resetFileSelection();

    state.role = null;
    state.roomID = null;
    state.receivedChunks = [];
    state.bytesTransferred = 0;
    state.speedHistory = [];
    state.maxSpeedObserved = 0;

    if (state.fileWritable) {
        try { state.fileWritable.close(); } catch (e) { }
        state.fileWritable = null;
    }

    state.useHttpRelay = false;
    state.transferAborted = true;

    // Clear URL query params
    window.history.pushState({}, document.title, window.location.pathname);

    el.codeInput.value = '';
    el.btnJoinRoom.disabled = true;

    showPanel(el.initialPanel);
    updateServerStatus('offline', 'Disconnected');
}

// Websocket Signaling Connections
function getWsProtocol() {
    return window.location.protocol === 'https:' ? 'wss://' : 'ws://';
}

function initializeSenderSignaling() {
    // Generate random 6 digit code
    state.roomID = Math.floor(100000 + Math.random() * 900000).toString();
    showPanel(el.shareLinkPanel);
    el.roomCodeDisplay.innerText = state.roomID;

    const host = window.location.host;
    const protocol = getWsProtocol();
    const shareUrl = `${window.location.protocol}//${host}/?room=${state.roomID}`;

    el.shareUrlInput.value = shareUrl;

    // Fetch QR Code from free API
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
    const protocol = getWsProtocol();
    const wsUrl = `${protocol}${window.location.host}/ws/${state.roomID}`;

    state.ws = new WebSocket(wsUrl);

    state.ws.onopen = () => {
        updateServerStatus('online', 'Connected to Server. Waiting for peer...');
        if (state.role === 'receiver') {
            el.waitingStatusText.innerText = "Connected to room. Handshaking...";
            showPanel(el.receiveConfirmPanel);
            el.rxFileName.innerText = "Waiting for file info...";
            el.rxFileSize.innerText = "-";
            el.btnAcceptTransfer.disabled = true;
        }
    };

    state.ws.onmessage = async (event) => {
        let msg;
        try {
            msg = JSON.parse(event.data);
        } catch (e) {
            console.error("Malformed JSON signal:", event.data);
            return;
        }

        switch (msg.type) {
            case 'http-relay-start':
                logger("Received HTTP Relay start signal");
                if (state.role === 'receiver') {
                    state.fileName = msg.name;
                    state.fileSize = msg.size;
                    state.fileType = msg.mime;
                    state.useHttpRelay = true;

                    el.rxFileName.innerText = msg.name;
                    el.rxFileSize.innerText = formatBytes(msg.size);
                    el.btnAcceptTransfer.disabled = false;

                    const extension = msg.name.split('.').pop().toLowerCase();
                    let iconClass = 'fa-file-video';
                    if (['zip', 'rar', '7z', 'tar', 'gz'].includes(extension)) iconClass = 'fa-file-zipper';
                    else if (['mp4', 'mkv', 'avi', 'mov'].includes(extension)) iconClass = 'fa-file-video';
                    else if (['mp3', 'wav', 'flac', 'ogg'].includes(extension)) iconClass = 'fa-file-audio';
                    else if (['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp'].includes(extension)) iconClass = 'fa-file-image';
                    else if (['pdf'].includes(extension)) iconClass = 'fa-file-pdf';
                    el.rxFileIcon.className = `fa-regular ${iconClass} file-type-icon large`;

                    el.waitingStatusText.innerText = "P2P blocked. Switched to HTTP Relay mode. Click Accept.";
                    showPanel(el.receiveConfirmPanel);
                }
                break;

            case 'http-relay-ready':
                logger("Receiver is ready for HTTP Relay. Initiating upload...");
                if (state.role === 'sender') {
                    startHttpFileTransfer();
                }
                break;

            case 'peer-joined':
                logger("Peer joined the room!");
                if (state.role === 'sender') {
                    const forceRelay = document.getElementById('force-relay-checkbox');
                    if (forceRelay && forceRelay.checked) {
                        logger("Force HTTP Relay mode enabled. Skipping WebRTC.");
                        initiateHttpRelayFallback();
                    } else {
                        el.waitingStatusText.innerText = "Peer joined. Handshaking WebRTC...";
                        setupPeerConnection();
                    }
                }
                break;

            case 'offer':
                logger("Received SDP Offer from sender");
                if (state.role === 'receiver') {
                    await setupPeerConnection(msg.offer);
                }
                break;

            case 'answer':
                logger("Received SDP Answer from receiver");
                if (state.role === 'sender' && state.peerConnection) {
                    await state.peerConnection.setRemoteDescription(new RTCSessionDescription(msg.answer));
                }
                break;

            case 'candidate':
                if (state.peerConnection) {
                    try {
                        await state.peerConnection.addIceCandidate(new RTCIceCandidate(msg.candidate));
                    } catch (e) {
                        console.error("Error adding ICE candidate:", e);
                    }
                }
                break;

            case 'peer-left':
                logger("Peer left the room");
                // Only disconnect if WebRTC setup has not started yet.
                // Once state.peerConnection exists, let WebRTC dictate the connection state.
                if (!state.peerConnection) {
                    handlePeerDisconnection("Peer disconnected.");
                } else {
                    logger("WebRTC setup is already in progress or active. Ignoring signaling peer-left.");
                }
                break;

            case 'reject-transfer':
                logger("Transfer rejected by receiver");
                alert("The receiver has declined the file transfer.");
                resetToHome();
                break;
        }
    };

    state.ws.onerror = (e) => {
        console.error("WebSocket error:", e);
        updateServerStatus('offline', 'Signaling server error.');
    };

    state.ws.onclose = () => {
        logger("WebSocket closed.");
    };
}

function disconnectWebSocket() {
    if (state.ws) {
        state.ws.close();
        state.ws = null;
    }
}

function sendSignalingMessage(message) {
    if (state.ws && state.ws.readyState === WebSocket.OPEN) {
        state.ws.send(JSON.stringify(message));
    }
}

// WebRTC Peer Connection Core Setup
async function setupPeerConnection(incomingOffer = null) {
    closePeerConnection();

    state.peerConnection = new RTCPeerConnection(ICE_CONFIG);

    state.peerConnection.onicecandidate = (event) => {
        if (event.candidate) {
            sendSignalingMessage({
                type: 'candidate',
                candidate: event.candidate
            });
        }
    };

    state.peerConnection.onconnectionstatechange = () => {
        if (!state.peerConnection) return;
        const connState = state.peerConnection.connectionState;
        logger(`WebRTC Connection State: ${connState}`);

        if (connState === 'connected') {
            // Clear any pending disconnect timer
            if (state.disconnectTimer) {
                clearTimeout(state.disconnectTimer);
                state.disconnectTimer = null;
            }
        } else if (connState === 'disconnected') {
            // 'disconnected' can recover — wait 5 seconds before triggering fallback
            logger("Connection temporarily lost. Waiting 5s for recovery...");
            state.disconnectTimer = setTimeout(() => {
                if (state.peerConnection && state.peerConnection.connectionState !== 'connected') {
                    if (!state.useHttpRelay) {
                        initiateHttpRelayFallback();
                    } else {
                        handlePeerDisconnection("P2P connection lost.");
                    }
                }
            }, 5000);
        } else if (connState === 'failed') {
            if (state.disconnectTimer) {
                clearTimeout(state.disconnectTimer);
                state.disconnectTimer = null;
            }
            if (!state.useHttpRelay) {
                initiateHttpRelayFallback();
            } else {
                handlePeerDisconnection("Direct P2P connection failed.");
            }
        }
    };

    if (state.role === 'sender') {
        // Sender creates data channel
        state.dataChannel = state.peerConnection.createDataChannel('warp-channel', {
            ordered: true
        });
        setupDataChannelHandlers();

        // Create SDP Offer
        const offer = await state.peerConnection.createOffer();
        await state.peerConnection.setLocalDescription(offer);
        sendSignalingMessage({
            type: 'offer',
            offer: offer
        });
    } else {
        // Receiver handles incoming data channel
        state.peerConnection.ondatachannel = (event) => {
            state.dataChannel = event.channel;
            setupDataChannelHandlers();
        };

        // Handle incoming Offer and create Answer
        await state.peerConnection.setRemoteDescription(new RTCSessionDescription(incomingOffer));
        const answer = await state.peerConnection.createAnswer();
        await state.peerConnection.setLocalDescription(answer);
        sendSignalingMessage({
            type: 'answer',
            answer: answer
        });
    }
}

function closePeerConnection() {
    if (state.dataChannel) {
        state.dataChannel.onopen = null;
        state.dataChannel.onmessage = null;
        state.dataChannel.onclose = null;
        state.dataChannel.close();
        state.dataChannel = null;
    }
    if (state.peerConnection) {
        state.peerConnection.onconnectionstatechange = null;
        state.peerConnection.onicecandidate = null;
        state.peerConnection.ondatachannel = null;
        state.peerConnection.close();
        state.peerConnection = null;
    }
}

// WebRTC Data Channel Event Handling
function setupDataChannelHandlers() {
    state.dataChannel.binaryType = 'arraybuffer';

    state.dataChannel.onopen = () => {
        logger("P2P Data Channel Open!");
        updateServerStatus('online', 'P2P Link Secured.');

        if (state.role === 'sender') {
            // Send metadata
            const metadata = {
                type: 'metadata',
                name: state.fileName,
                size: state.fileSize,
                mime: state.fileType
            };
            state.dataChannel.send(JSON.stringify(metadata));
            el.waitingStatusText.innerText = "Secure peer link open. Preparing file transfer...";
        }
    };

    state.dataChannel.onmessage = async (event) => {
        const data = event.data;

        if (typeof data === 'string') {
            // Process control signal strings
            let msg;
            try {
                msg = JSON.parse(data);
            } catch (e) {
                console.error("Failed to parse string from data channel:", data);
                return;
            }

            switch (msg.type) {
                case 'metadata':
                    logger("Received metadata: " + msg.name);
                    state.fileName = msg.name;
                    state.fileSize = msg.size;
                    state.fileType = msg.mime;

                    el.rxFileName.innerText = msg.name;
                    el.rxFileSize.innerText = formatBytes(msg.size);
                    el.btnAcceptTransfer.disabled = false;

                    // Assign icon to receiver card
                    const extension = msg.name.split('.').pop().toLowerCase();
                    let iconClass = 'fa-file-video';
                    if (['zip', 'rar', '7z', 'tar', 'gz'].includes(extension)) iconClass = 'fa-file-zipper';
                    else if (['mp4', 'mkv', 'avi', 'mov'].includes(extension)) iconClass = 'fa-file-video';
                    else if (['mp3', 'wav', 'flac', 'ogg'].includes(extension)) iconClass = 'fa-file-audio';
                    else if (['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp'].includes(extension)) iconClass = 'fa-file-image';
                    else if (['pdf'].includes(extension)) iconClass = 'fa-file-pdf';
                    el.rxFileIcon.className = `fa-regular ${iconClass} file-type-icon large`;
                    break;

                case 'ready':
                    logger("Receiver is ready. Initiating stream...");
                    startFileTransfer();
                    break;

                case 'eof':
                    logger("Received EOF (End of File)");
                    await completeIncomingTransfer();
                    break;
            }
        } else {
            // Binary Chunk Received (Receiver side)
            processIncomingChunk(data);
        }
    };

    state.dataChannel.onclose = () => {
        logger("P2P Data Channel Closed.");
    };

    // Monitor WebRTC buffer Low Threshold (flow control hook)
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

// Sender-side Transmission Logic
function startFileTransfer() {
    state.bytesTransferred = 0;
    state.sendOffset = 0;
    state.isSendingPaused = false;
    state.transferStartTime = Date.now();
    state.lastLoggedBytes = 0;
    state.lastSpeedTickTime = Date.now();
    state.speedHistory = [];
    state.maxSpeedObserved = 0;
    state.lastUiUpdateTime = 0;

    // Switch to progress UI
    showPanel(el.progressPanel);
    updateProgressPercentage(0, state.fileSize, true);
    el.transferTitle.innerText = "Uploading File...";
    el.transferDirectionBadge.innerHTML = '<i class="fa-solid fa-arrow-up"></i> Sending';

    // Request Screen Lock (prevent tab sleep)
    requestWakeLock();

    // Start measuring transfer speeds
    startSpeedMetricsTracker();

    // Start transmission loop
    streamNextChunks();
}

async function streamNextChunks() {
    while (state.sendOffset < state.fileSize) {
        // Implement backpressure: Pause if WebRTC buffer is full
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

            // Fast progress update
            updateProgressPercentage(state.bytesTransferred, state.fileSize);
        } catch (e) {
            console.error("Chunk transmission error:", e);
            handlePeerDisconnection("Transmission buffer error.");
            return;
        }
    }

    // Send EOF indicator when done
    if (state.sendOffset >= state.fileSize && !state.isSendingPaused) {
        state.dataChannel.send(JSON.stringify({ type: 'eof' }));
        completeFileTransfer();
    }
}

// Receiver-side Reception Logic
async function acceptIncomingTransfer() {
    // Attempt Direct Disk Writing setup via Chrome's File System Access API
    if ('showSaveFilePicker' in window) {
        try {
            state.fileHandle = await window.showSaveFilePicker({
                suggestedName: state.fileName
            });
            state.fileWritable = await state.fileHandle.createWritable();
            logger("File System Writable Stream initialized.");
        } catch (e) {
            logger("User cancelled save file dialog, or file write denied: " + e);
            return;
        }
    } else {
        // Fallback for Safari/Firefox
        state.receivedChunks = [];
        logger("Direct Writable Stream unsupported, using RAM fallback.");
    }

    state.bytesTransferred = 0;
    state.transferStartTime = Date.now();
    state.lastLoggedBytes = 0;
    state.lastSpeedTickTime = Date.now();
    state.speedHistory = [];
    state.maxSpeedObserved = 0;
    state.lastUiUpdateTime = 0;

    // Setup UI
    showPanel(el.progressPanel);
    updateProgressPercentage(0, state.fileSize, true);
    el.transferTitle.innerText = "Downloading File...";
    el.transferDirectionBadge.innerHTML = '<i class="fa-solid fa-arrow-down"></i> Receiving';

    requestWakeLock();
    startSpeedMetricsTracker();

    // Keep signaling connection open during transfer to prevent peer-left triggers
    // disconnectWebSocket();

    if (state.useHttpRelay) {
        sendSignalingMessage({ type: 'http-relay-ready' });
        startHttpDownloadLoop();
    } else {
        // Send ready message to sender to trigger chunk transmission
        state.dataChannel.send(JSON.stringify({ type: 'ready' }));
    }
}

function processIncomingChunk(arrayBuffer) {
    try {
        if (state.fileWritable) {
            // Direct Writable Stream (zero-copy straight to disk)
            // Call write without await to let browser stream handle queuing.
            // This prevents I/O latency from blocking the WebRTC thread.
            state.fileWritable.write(arrayBuffer).catch(e => {
                console.error("Failed writing chunk to disk:", e);
                handlePeerDisconnection("Local storage writing failed.");
            });
        } else {
            // RAM Buffer fallback
            state.receivedChunks.push(arrayBuffer);
        }

        state.bytesTransferred += arrayBuffer.byteLength;
        updateProgressPercentage(state.bytesTransferred, state.fileSize);
    } catch (e) {
        console.error("Error processing incoming chunk:", e);
        handlePeerDisconnection("Chunk processing error.");
    }
}

async function completeIncomingTransfer() {
    updateProgressPercentage(state.fileSize, state.fileSize, true);
    stopSpeedMetricsTracker();
    releaseWakeLock();

    const durationMs = Date.now() - state.transferStartTime;
    const avgSpeedBytes = state.bytesTransferred / (durationMs / 1000);

    if (state.fileWritable) {
        try {
            await state.fileWritable.close();
            state.fileWritable = null;
            logger("File save complete and stream closed.");
        } catch (e) {
            console.error("Error closing writable stream:", e);
        }
    } else {
        // Compile RAM chunks to a Blob and trigger standard browser download
        try {
            el.transferTitle.innerText = "Compiling file...";
            const blob = new Blob(state.receivedChunks, { type: state.fileType || 'application/octet-stream' });

            // Free the memory buffer reference
            state.receivedChunks = [];

            const downloadUrl = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = downloadUrl;
            a.download = state.fileName;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);

            // Clean memory references after trigger
            setTimeout(() => URL.revokeObjectURL(downloadUrl), 5000);
        } catch (e) {
            alert("File assembly failed due to memory limit. Please use Chrome or Edge for large files!");
            resetToHome();
            return;
        }
    }

    showSuccessScreen(durationMs, avgSpeedBytes);
}

function completeFileTransfer() {
    updateProgressPercentage(state.fileSize, state.fileSize, true);
    stopSpeedMetricsTracker();
    releaseWakeLock();

    const durationMs = Date.now() - state.transferStartTime;
    const avgSpeedBytes = state.bytesTransferred / (durationMs / 1000);

    showSuccessScreen(durationMs, avgSpeedBytes);
}

// UI Stats & Canvas Drawing
function updateProgressPercentage(transferred, total, force = false) {
    const now = Date.now();
    if (!force && now - state.lastUiUpdateTime < 100) {
        return; // Skip DOM update to prevent layout thrashing
    }
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

        const speedBps = deltaBytes / (deltaMs / 1000); // Bytes/sec
        const speedMbps = speedBps / (1024 * 1024); // MB/s

        state.speedHistory.push(speedMbps);
        if (state.speedHistory.length > 60) {
            state.speedHistory.shift();
        }

        if (speedMbps > state.maxSpeedObserved) {
            state.maxSpeedObserved = speedMbps;
            el.maxSpeedLabel.innerText = `Max: ${speedMbps.toFixed(1)} MB/s`;
        }

        // Update stats
        el.statSpeed.innerText = `${speedMbps.toFixed(1)} MB/s`;

        // Calculate ETA
        const bytesLeft = state.fileSize - state.bytesTransferred;
        if (speedBps > 0) {
            const etaSeconds = Math.round(bytesLeft / speedBps);
            el.statEta.innerText = formatTime(etaSeconds);
        } else {
            el.statEta.innerText = "Stalled";
        }

        // Re-draw history canvas
        drawSpeedHistoryChart();

        // Reset pointers
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

    // Draw Grid Lines
    ctx.strokeStyle = 'rgba(255,255,255,0.03)';
    ctx.lineWidth = 1;
    for (let i = 1; i < 4; i++) {
        const y = (height / 4) * i;
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(width, y);
        ctx.stroke();
    }

    // Calculate Scaling
    const points = state.speedHistory;
    const maxVal = Math.max(...points, 5); // scale to at least 5MB/s max peak limit
    const padding = 10;

    // Setup Neon Gradient
    const gradient = ctx.createLinearGradient(0, height - padding, 0, padding);
    gradient.addColorStop(1, 'rgba(6, 182, 212, 0.4)'); // Neon cyan
    gradient.addColorStop(0, 'rgba(139, 92, 246, 0.0)'); // Fade to translucent violet

    ctx.beginPath();

    // Draw path
    for (let i = 0; i < points.length; i++) {
        const x = (width / 59) * i;
        const valRatio = points[i] / maxVal;
        const y = height - padding - (valRatio * (height - (padding * 2)));

        if (i === 0) {
            ctx.moveTo(x, y);
        } else {
            // Cubic bezier smoothing for high quality look
            const prevX = (width / 59) * (i - 1);
            const prevValRatio = points[i - 1] / maxVal;
            const prevY = height - padding - (prevValRatio * (height - (padding * 2)));
            ctx.bezierCurveTo((prevX + x) / 2, prevY, (prevX + x) / 2, y, x, y);
        }
    }

    // Trace the Line
    ctx.strokeStyle = '#06b6d4';
    ctx.lineWidth = 2.5;
    ctx.shadowBlur = 4;
    ctx.shadowColor = 'rgba(6, 182, 212, 0.5)';
    ctx.stroke();

    // Close area path for filling gradient
    if (points.length > 0) {
        ctx.shadowBlur = 0; // Disable shadow for gradient fill
        const lastX = (width / 59) * (points.length - 1);
        ctx.lineTo(lastX, height);
        ctx.lineTo(0, height);
        ctx.closePath();
        ctx.fillStyle = gradient;
        ctx.fill();
    }
}

function showSuccessScreen(durationMs, avgSpeedBytes) {
    el.summaryFileName.innerText = state.fileName;
    el.summaryFileSize.innerText = formatBytes(state.fileSize);
    el.summaryAvgSpeed.innerText = `${(avgSpeedBytes / (1024 * 1024)).toFixed(1)} MB/s`;
    el.summaryDuration.innerText = formatTime(Math.round(durationMs / 1000));

    if (state.role === 'sender') {
        el.completePanel.querySelector('#complete-subtext').innerText = "The file has been successfully uploaded to your peer.";
    } else {
        el.completePanel.querySelector('#complete-subtext').innerText = "The file has been successfully saved to your device.";
    }

    showPanel(el.completePanel);
}

function handlePeerDisconnection(reasonText) {
    stopSpeedMetricsTracker();
    releaseWakeLock();

    if (state.bytesTransferred > 0 && state.bytesTransferred < state.fileSize) {
        alert(`${reasonText} Transfer interrupted.`);
    }
    resetToHome();
}

// Background Wake Lock Handling (Keep browser active)
async function requestWakeLock() {
    if (!el.wakeLockCheckbox.checked) return;

    if ('wakeLock' in navigator) {
        try {
            state.wakeLock = await navigator.wakeLock.request('screen');
            logger("Wake Lock activated successfully.");
        } catch (err) {
            console.error("Failed to request Wake Lock:", err);
        }
    }
}

function releaseWakeLock() {
    if (state.wakeLock) {
        state.wakeLock.release().then(() => {
            state.wakeLock = null;
            logger("Wake Lock released.");
        });
    }
}

// HTTP Relay Fallback Operations
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

    showPanel(el.progressPanel);
    updateProgressPercentage(0, state.fileSize, true);
    el.transferTitle.innerText = "Uploading File (HTTP Relay)...";
    el.transferDirectionBadge.innerHTML = '<i class="fa-solid fa-arrow-up"></i> Sending';

    requestWakeLock();
    startSpeedMetricsTracker();

    startHttpUploadLoop();
}

async function startHttpUploadLoop() {
    const HTTP_CHUNK_SIZE = 1 * 1024 * 1024; // 1MB HTTP chunks for faster relay speed
    let retryCount = 0;

    while (state.sendOffset < state.fileSize) {
        if (state.transferAborted) break;

        const end = Math.min(state.sendOffset + HTTP_CHUNK_SIZE, state.fileSize);
        const slice = state.file.slice(state.sendOffset, end);

        try {
            const buffer = await slice.arrayBuffer();

            const formData = new FormData();
            const blob = new Blob([buffer], { type: 'application/octet-stream' });
            formData.append('file', blob, state.fileName);

            const response = await fetch(`/relay/upload/${state.roomID}`, {
                method: 'POST',
                body: formData
            });

            if (response.status === 408) {
                logger("Upload chunk timeout (408), retrying chunk...");
                await new Promise(r => setTimeout(r, 1000));
                continue;
            }

            if (!response.ok) {
                throw new Error(`Server returned HTTP ${response.status}`);
            }

            state.sendOffset = end;
            state.bytesTransferred = end;
            updateProgressPercentage(state.bytesTransferred, state.fileSize);
            retryCount = 0; // Reset retry count on successful chunk
        } catch (e) {
            console.error("HTTP Relay Upload error:", e);
            retryCount++;
            if (retryCount > 10) {
                handlePeerDisconnection("HTTP Relay upload connection lost after multiple retries.");
                return;
            }
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

    while (state.bytesTransferred < state.fileSize) {
        if (state.transferAborted) break;

        try {
            const response = await fetch(`/relay/download/${state.roomID}`);

            if (response.status === 408) {
                logger("Download chunk timeout (408), retrying...");
                await new Promise(r => setTimeout(r, 1000));
                continue;
            }

            if (!response.ok) {
                throw new Error(`Server returned HTTP ${response.status}`);
            }

            const arrayBuffer = await response.arrayBuffer();
            if (arrayBuffer.byteLength === 0) {
                throw new Error("Empty chunk received");
            }

            processIncomingChunk(arrayBuffer);
            updateProgressPercentage(state.bytesTransferred, state.fileSize);
            retryCount = 0; // Reset retry count on successful chunk
        } catch (e) {
            console.error("HTTP Relay Download error:", e);
            retryCount++;
            if (retryCount > 10) {
                handlePeerDisconnection("HTTP Relay download connection lost after multiple retries.");
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

// Utility Helper Functions
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
