// DOM Elements
const videoContainer = document.getElementById('video-container');
const localVideo = document.getElementById('local-video');

const btnStartMedia = document.getElementById('btn-start-media');
const btnToggleVideo = document.getElementById('btn-toggle-video');
const btnToggleAudio = document.getElementById('btn-toggle-audio');
const btnShareScreen = document.getElementById('btn-share-screen');
const btnToggleChat = document.getElementById('btn-toggle-chat');
const btnToggleSidebar = document.getElementById('btn-toggle-sidebar');
const btnConnect = document.getElementById('btn-connect');
const btnHideControls = document.getElementById('btn-hide-controls');
const btnShowControls = document.getElementById('btn-show-controls');
const controlsPanel = document.querySelector('.controls-panel');

const inputDisplayName = document.getElementById('input-display-name');
const inputRoomId = document.getElementById('input-room-id');
const inputSignalHost = document.getElementById('input-signal-host');
const btnJoinRoom = document.getElementById('btn-join-room');
const peerIdDisplay = document.getElementById('peer-id-display');

const wsStatus = document.getElementById('ws-status');
const connectionStatus = document.getElementById('connection-status');
const logsContainer = document.getElementById('logs');

const chatMessages = document.getElementById('chat-messages');
const chatInput = document.getElementById('chat-input');
const btnSendChat = document.getElementById('btn-send-chat');
const btnCloseSidebarMobile = document.getElementById('btn-close-sidebar-mobile');
const btnCloseChatMobile = document.getElementById('btn-close-chat-mobile');

const btnOpenAdmin = document.getElementById('btn-open-admin');
const btnCloseAdmin = document.getElementById('btn-close-admin');
const adminModal = document.getElementById('admin-modal');
const btnAdminBroadcast = document.getElementById('btn-admin-broadcast');
const adminBroadcastInput = document.getElementById('admin-broadcast-input');

const adminServerStatus = document.getElementById('admin-server-status');
const adminActiveRooms = document.getElementById('admin-active-rooms');
const adminActivePeers = document.getElementById('admin-active-peers');
const adminTotalMessages = document.getElementById('admin-total-messages');
const adminWorkersReq = document.getElementById('admin-workers-req');
const adminDoReq = document.getElementById('admin-do-req');
const adminRoomPeersList = document.getElementById('admin-room-peers-list');

const micIndicator = document.getElementById('mic-indicator');
const videoIndicator = document.getElementById('video-indicator');
const screenIndicator = document.getElementById('screen-indicator');

// WebRTC & WebSocket State Variables
let myPeerId = 'peer-' + Math.random().toString(36).substr(2, 6);
let currentRoomId = null;

let localStream = null;
let screenStream = null;
let socket = null; // WebSocket to signaling server

// Cloudflare Calls SFU State
let pcPublish = null; // PeerConnection for publishing (sending)
let pcSubscribe = null; // PeerConnection for subscribing (receiving)
let sessionIdPublish = null;
let sessionIdSubscribe = null;
let timerInterval = null; // Pemasa mesyuarat
let activePeers = new Set(); // Set untuk menjejaki ID peserta aktif di dalam bilik

// Track mappings & WebRTC P2P State
let myPublishedTracks = []; // [{ trackId, label }]
let isVideoMuted = false;
let isAudioMuted = false;
let isSharingScreen = false;
let isMockMode = false;
let isP2PMode = false;
const p2pConnections = new Map(); // targetPeerId -> RTCPeerConnection

// Display Generated Peer ID
peerIdDisplay.textContent = `Your ID: ${myPeerId}`;

// Custom Logger Function
function log(message, type = 'system') {
    const time = new Date().toLocaleTimeString();
    const entry = document.createElement('div');
    entry.className = `log-entry ${type}`;
    entry.innerHTML = `[${time}] ${message}`;
    logsContainer.appendChild(entry);
    logsContainer.scrollTop = logsContainer.scrollHeight;
    console.log(`[${type.toUpperCase()}] ${message}`);
}

// Helper pengesanan hos pelayan isyarat (Signaling Server)
function getSignalingHost() {
    // Jika pengguna memasukkan URL pelayan isyarat tersuai di kotak tetapan
    if (inputSignalHost && inputSignalHost.value.trim()) {
        return inputSignalHost.value.trim().replace(/^https?:\/\//, '').replace(/^wss?:\/\//, '');
    }
    const hostname = window.location.hostname;
    if (hostname === 'localhost' || hostname === '127.0.0.1') {
        return `${hostname}:8787`;
    }
    // Secara lalai, hubungkan frontend ke backend live worker webrtc-signaling yang baharu di-deploy
    if (hostname.startsWith('webrtc-prototype.')) {
        return hostname.replace('webrtc-prototype.', 'webrtc-signaling.');
    }
    return hostname;
}

// Helper to make API calls to backend proxy
async function apiRequest(endpoint, method, body = null) {
    const apiHost = getSignalingHost();
    const apiProtocol = window.location.protocol; // Menggunakan https atau http mengikut persekitaran semasa
    
    const response = await fetch(`${apiProtocol}//${apiHost}/room/${currentRoomId}/calls/${endpoint}`, {
        method: method,
        headers: {
            'Content-Type': 'application/json'
        },
        body: body ? JSON.stringify(body) : null
    });
    
    if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || `HTTP error! status: ${response.status}`);
    }
    
    return await response.json();
}

// 1. Dapatkan Kebenaran Kamera & Mikrofon (Start Media)
async function startMedia() {
    log('Meminta akses kamera dan mikrofon...', 'info');
    try {
        localStream = await navigator.mediaDevices.getUserMedia({
            video: { width: 640, height: 360, frameRate: 24 },
            audio: true
        });
        
        localVideo.srcObject = localStream;
        log('Kamera dan mikrofon berjaya diaktifkan!', 'success');
        
        // Kemas kini UI
        btnStartMedia.disabled = true;
        btnToggleVideo.disabled = false;
        btnToggleAudio.disabled = false;
        btnShareScreen.disabled = false;
        btnJoinRoom.disabled = false;
        
        micIndicator.classList.remove('disabled');
        micIndicator.innerHTML = '<i class="fa-solid fa-microphone"></i>';
        videoIndicator.classList.remove('disabled');
        videoIndicator.innerHTML = '<i class="fa-solid fa-video"></i>';
        
    } catch (error) {
        log(`Gagal akses media: ${error.message}`, 'error');
        alert('Ralat: Sila berikan kebenaran kamera/mikrofon dalam browser anda.');
    }
}

// 2. Sertai Bilik Isyarat (WebSocket Connection)
function joinRoom() {
    const displayName = inputDisplayName.value.trim();
    if (displayName) {
        myPeerId = displayName;
        peerIdDisplay.textContent = `Your Name: ${myPeerId}`;
    }
    
    // Kemas kini lencana nama pada video local
    const localLabelBadge = document.querySelector('#local-video-wrapper .label-badge');
    if (localLabelBadge) {
        localLabelBadge.innerHTML = `<i class="fa-solid fa-user"></i> ${myPeerId} (Anda)`;
    }

    const roomId = inputRoomId.value.trim();
    if (!roomId) {
        alert('Sila masukkan ID Bilik terlebih dahulu.');
        return;
    }

    currentRoomId = roomId;
    
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsHost = getSignalingHost();
    const wsUrl = `${protocol}//${wsHost}/room/${roomId}?peerId=${myPeerId}`;
    log(`Menyambung WebSocket ke: ${wsUrl}...`, 'info');
    
    try {
        socket = new WebSocket(wsUrl);
        
        socket.onopen = () => {
            log('Berjaya disambung ke pelayan isyarat WebSocket.', 'success');
            wsStatus.className = 'status-badge connected';
            wsStatus.innerHTML = '<i class="fa-solid fa-circle-nodes"></i> WS: Aktif';
            
            inputDisplayName.disabled = true;
            inputRoomId.disabled = true;
            if (inputSignalHost) inputSignalHost.disabled = true;
            btnJoinRoom.disabled = true;
            
            log('Menghantar isyarat join ke server...', 'system');
            try {
                socket.send(JSON.stringify({
                    type: 'join',
                    peerId: myPeerId
                }));
            } catch (err) {
                log(`Gagal hantar isyarat join: ${err.message}`, 'error');
            }
        };
        
        socket.onmessage = async (event) => {
            try {
                const data = JSON.parse(event.data);
                log(`WS Msg: ${data.type}`, 'system');
                await handleSignalingMessage(data);
            } catch (err) {
                log(`Ralat WS Message: ${err.message}`, 'error');
            }
        };
        
        socket.onclose = () => {
            log('Sambungan ke pelayan isyarat terputus.', 'warning');
            wsStatus.className = 'status-badge disconnected';
            wsStatus.innerHTML = '<i class="fa-solid fa-circle-nodes"></i> WS: Putus';
            resetRoomUI();
        };
        
        socket.onerror = (err) => {
            log(`Gagal menyambung WebSocket ke ${wsUrl}. Pastikan pelayan worker isyarat sedang aktif.`, 'error');
        };
        
    } catch (e) {
        log(`Gagal menyambung WebSocket: ${e.message}`, 'error');
    }
}

function resetRoomUI() {
    inputDisplayName.disabled = false;
    inputRoomId.disabled = false;
    if (inputSignalHost) inputSignalHost.disabled = false;
    btnJoinRoom.disabled = false;
    btnConnect.disabled = true;
    
    // Kembalikan lencana nama video local kepada asal
    const localLabelBadge = document.querySelector('#local-video-wrapper .label-badge');
    if (localLabelBadge) {
        localLabelBadge.innerHTML = `<i class="fa-solid fa-user"></i> Anda (Local)`;
    }
    
    disconnectCall();
}

// 3. Terima & Proses Isyarat daripada WebSocket
async function handleSignalingMessage(data) {
    switch (data.type) {
        case 'room-joined':
            log(`Anda menyertai bilik "${currentRoomId}" sebagai ${data.peerId}`, 'success');
            btnConnect.disabled = false; // Boleh publish media sekarang
            
            // Simpan ahli aktif berdasarkan tracks yang diterima
            activePeers.clear();
            if (data.tracks && data.tracks.length > 0) {
                log(`Menjumpai ${data.tracks.length} track aktif di dalam bilik. Menyambung langganan...`, 'info');
                for (const [trackId, info] of data.tracks) {
                    if (info.peerId && info.peerId !== myPeerId) {
                        activePeers.add(info.peerId);
                    }
                    await subscribeToTrack(trackId, info.sessionId, info.peerId, info.label);
                }
            }
            updateParticipantCount();
            break;
            
        case 'track-published':
            log(`Peserta ${data.sender} menerbitkan track ${data.label} (${data.trackId})`, 'info');
            if (data.sender && data.sender !== myPeerId) {
                activePeers.add(data.sender);
                updateParticipantCount();
            }
            await subscribeToTrack(data.trackId, data.sessionId, data.sender, data.label);
            break;
            
        case 'track-unpublished':
            log(`Peserta ${data.sender} menghentikan track ${data.trackId}`, 'warning');
            removeVideoTrackElement(data.trackId, data.sender);
            break;
            
        case 'peer-joined':
            log(`Peserta baru menyertai bilik: ${data.peerId}`, 'info');
            activePeers.add(data.peerId);
            updateParticipantCount();
            if (isP2PMode || sessionIdPublish) {
                initiateP2POffer(data.peerId);
            }
            break;

        case 'p2p-ready':
            if (data.sender && data.sender !== myPeerId) {
                log(`Peranti ${data.sender} sedia untuk sambungan P2P.`, 'info');
                activePeers.add(data.sender);
                updateParticipantCount();
                initiateP2POffer(data.sender);
            }
            break;

        case 'p2p-offer':
            if (data.target === myPeerId && data.sender) {
                await handleP2POffer(data.sender, data.offer);
            }
            break;

        case 'p2p-answer':
            if (data.target === myPeerId && data.sender) {
                await handleP2PAnswer(data.sender, data.answer);
            }
            break;

        case 'p2p-ice':
            if (data.target === myPeerId && data.sender) {
                await handleP2PIce(data.sender, data.candidate);
            }
            break;
            
        case 'peer-left':
            log(`Peserta ${data.peerId} melepaskan sambungan...`, 'warning');
            activePeers.delete(data.peerId);
            updateParticipantCount();
            
            if (p2pConnections.has(data.peerId)) {
                p2pConnections.get(data.peerId).close();
                p2pConnections.delete(data.peerId);
            }
            
            if (data.deletedTracks) {
                data.deletedTracks.forEach(trackId => {
                    removeVideoTrackElement(trackId, data.peerId);
                });
            }
            const wrapper = document.getElementById(`video-${data.peerId}`);
            if (wrapper) wrapper.remove();
            break;

        case 'screen-share-status':
            if (data.sender && data.sender !== myPeerId) {
                const remoteWrapper = document.getElementById(`video-${data.sender}`);
                if (remoteWrapper) {
                    const badge = remoteWrapper.querySelector('.label-badge');
                    if (data.isSharing) {
                        remoteWrapper.classList.add('remote-sharing-screen');
                        videoContainer.classList.add('screen-sharing-active');
                        if (badge) badge.innerHTML = `<i class="fa-solid fa-desktop"></i> Rakan (${data.sender}) - Perkongsian Skrin`;
                        log(`Peserta ${data.sender} mula berkongsi skrin.`, 'info');
                    } else {
                        remoteWrapper.classList.remove('remote-sharing-screen');
                        if (videoContainer.querySelectorAll('.sharing-screen, .remote-sharing-screen').length === 0) {
                            videoContainer.classList.remove('screen-sharing-active');
                        }
                        if (badge) badge.innerHTML = `<i class="fa-solid fa-user-friends"></i> Rakan (${data.sender})`;
                        log(`Peserta ${data.sender} menamatkan perkongsian skrin.`, 'info');
                    }
                }
            }
            break;

        case 'chat':
            const isChatClosed = document.querySelector('.app-container').classList.contains('chat-closed');
            if (isChatClosed && !isSharingScreen) {
                showChatToast(data.sender, data.text);
            }
            appendMessage(data.sender === myPeerId ? 'Anda' : `Rakan (${data.sender})`, data.text, data.sender === myPeerId ? 'local' : 'remote');
            break;
            
        default:
            break;
    }
}

// Pembantu menghantar isyarat melalui WebSocket
function sendSignalingMessage(message) {
    if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify(message));
    }
}

// 4. Mula Bersiar: Publish Media ke Cloudflare Calls
async function connectCall() {
    log('Memulakan sesi bersiaran ke Cloudflare Calls...', 'info');
    
    connectionStatus.className = 'status-badge connecting';
    connectionStatus.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Menyambung...';
    
    btnConnect.disabled = true;
    
    const configuration = {
        iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
    };
    
    try {
        // Cipta PeerConnection untuk Bersiaran (Publish)
        pcPublish = new RTCPeerConnection(configuration);
        
        // Masukkan track media kamera/mic kita
        const activeStream = isSharingScreen ? screenStream : localStream;
        if (activeStream) {
            activeStream.getTracks().forEach(track => {
                pcPublish.addTrack(track, activeStream);
            });
            log('Media local dimasukkan ke dalam Publish Connection.', 'system');
        }
        
        // Cipta Offer tempatan
        const offer = await pcPublish.createOffer();
        await pcPublish.setLocalDescription(offer);
        
        // Hantar Offer ke API backend untuk cipta sesi baru
        let sessionRes;
        try {
            sessionRes = await apiRequest('session', 'POST', {
                sessionDescription: {
                    type: 'offer',
                    sdp: offer.sdp
                }
            });
        } catch (apiError) {
            if (apiError.message.includes('CREDENTIALS_MISSING')) {
                log('Kredensial SFU tiada. Memulakan Panggilan WebRTC P2P Direct antara peranti...', 'info');
                startP2PCall();
                return;
            }
            throw apiError;
        }
        
        sessionIdPublish = sessionRes.sessionId;
        log(`Sesi Bersiaran Cloudflare berjaya dibina: ${sessionIdPublish}`, 'success');
        
        // Tetapkan Remote Description (Answer) daripada Cloudflare
        await pcPublish.setRemoteDescription(new RTCSessionDescription(sessionRes.sessionDescription));
        
        // Menerbitkan Track ke Cloudflare
        const transceivers = pcPublish.getTransceivers();
        const tracksToPublish = transceivers
            .filter(t => t.sender.track)
            .map(t => ({
                location: 'local',
                mid: t.mid,
                trackName: t.sender.track.id
            }));
            
        log('Mengisi pendaftaran track ke Cloudflare Calls...', 'system');
        const publishRes = await apiRequest(`sessions/${sessionIdPublish}/tracks`, 'POST', {
            tracks: tracksToPublish
        });
        
        // Jalankan proses Renegotiation yang dikehendaki oleh Cloudflare
        if (publishRes.requiresRenegotiation) {
            log('Renegotiation diperlukan untuk pengesahan track...', 'system');
            await pcPublish.setRemoteDescription(new RTCSessionDescription(publishRes.sessionDescription));
            
            const answer = await pcPublish.createAnswer();
            await pcPublish.setLocalDescription(answer);
            
            // Hantar Answer kembali ke endpoint renegotiate
            await apiRequest(`sessions/${sessionIdPublish}/renegotiate`, 'PUT', {
                sessionDescription: {
                    type: 'answer',
                    sdp: answer.sdp
                }
            });
            log('Renegotiation selesai.', 'success');
        }
        
        // Simpan maklumat track dan hebahkan ke WebSocket bilik panggilan
        myPublishedTracks = publishRes.tracks;
        myPublishedTracks.forEach(track => {
            const label = track.mid === '0' ? 'video' : 'audio';
            sendSignalingMessage({
                type: 'track-published',
                trackId: track.trackId,
                sessionId: sessionIdPublish,
                label: label
            });
            log(`Menyebarkan track baru ke bilik: ${label} (${track.trackId})`, 'system');
        });
        
        connectionStatus.className = 'status-badge connected';
        connectionStatus.innerHTML = '<i class="fa-solid fa-circle"></i> Panggilan: Bersiar';
        
        // Tukar butang Publish kepada butang Unpublish (Danger Red)
        btnConnect.disabled = false;
        btnConnect.className = 'btn btn-danger';
        btnConnect.innerHTML = '<i class="fa-solid fa-phone-slash"></i>';
        btnConnect.title = 'Tamatkan Siaran (Unpublish)';
        
        chatInput.disabled = false;
        btnSendChat.disabled = false;
        
        startMeetingTimer();
        
    } catch (error) {
        log(`Gagal memulakan panggilan: ${error.message}`, 'error');
        disconnectCall();
    }
}

// 5. Langgan (Subscribe) Track Peserta Lain dari Cloudflare Calls
async function subscribeToTrack(trackId, publisherSessionId, publisherPeerId, label) {
    if (isMockMode) return; // Langkau jika dalam mod simulasi
    
    log(`Memulakan langganan track ${label} (${trackId}) daripada ${publisherPeerId}...`, 'info');
    
    const configuration = {
        iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
    };
    
    try {
        // Cipta PeerConnection untuk Langganan jika belum ada (Satu connection menerima semua stream)
        if (!pcSubscribe) {
            pcSubscribe = new RTCPeerConnection(configuration);
            
            pcSubscribe.ontrack = event => {
                const track = event.track;
                const stream = event.streams[0] || new MediaStream([track]);
                log(`Track audio/video remote diterima untuk ${track.id}!`, 'success');
                displayRemoteStream(stream, track.id, publisherPeerId);
            };
            
            // Cipta sesi Subscribe baru di Cloudflare (Offer Kosong dahulu)
            const offer = await pcSubscribe.createOffer();
            await pcSubscribe.setLocalDescription(offer);
            
            const sessionRes = await apiRequest('session', 'POST', {
                sessionDescription: {
                    type: 'offer',
                    sdp: offer.sdp
                }
            });
            
            sessionIdSubscribe = sessionRes.sessionId;
            await pcSubscribe.setRemoteDescription(new RTCSessionDescription(sessionRes.sessionDescription));
            log(`Sesi Langganan Cloudflare dibina: ${sessionIdSubscribe}`, 'success');
        }
        
        // Tambah track remote ke dalam sesi subscribe kita
        const subscribeRes = await apiRequest(`sessions/${sessionIdSubscribe}/tracks`, 'POST', {
            tracks: [{
                location: 'remote',
                sessionId: publisherSessionId,
                trackId: trackId
            }]
        });
        
        // Jalankan proses Renegotiation
        if (subscribeRes.requiresRenegotiation) {
            await pcSubscribe.setRemoteDescription(new RTCSessionDescription(subscribeRes.sessionDescription));
            
            const answer = await pcSubscribe.createAnswer();
            await pcSubscribe.setLocalDescription(answer);
            
            await apiRequest(`sessions/${sessionIdSubscribe}/renegotiate`, 'PUT', {
                sessionDescription: {
                    type: 'answer',
                    sdp: answer.sdp
                }
            });
            log(`Track ${label} berjaya dilanggan!`, 'success');
        }
        
    } catch (error) {
        log(`Gagal melanggan track: ${error.message}`, 'error');
    }
}

// 6. Paparkan Video Dinamik Remote pada Grid
function displayRemoteStream(stream, trackId, peerId) {
    // Cari jika kotak video peserta ini sudah wujud
    let wrapper = document.getElementById(`video-${peerId}`);
    
    if (!wrapper) {
        wrapper = document.createElement('div');
        wrapper.className = 'video-wrapper';
        wrapper.id = `video-${peerId}`;
        
        const video = document.createElement('video');
        video.autoplay = true;
        video.playsInline = true;
        video.id = `video-el-${peerId}`;
        
        const label = document.createElement('div');
        label.className = 'video-label';
        label.innerHTML = `<span class="label-badge"><i class="fa-solid fa-user-friends"></i> Rakan (${peerId})</span>`;
        
        const streamIndicators = document.createElement('div');
        streamIndicators.className = 'stream-indicators';
        streamIndicators.innerHTML = `<button class="indicator btn-expand-video" title="Full Screen (YouTube View)"><i class="fa-solid fa-expand"></i></button>`;

        wrapper.appendChild(video);
        wrapper.appendChild(label);
        wrapper.appendChild(streamIndicators);
        videoContainer.appendChild(wrapper);
    }
    
    const videoElement = document.getElementById(`video-el-${peerId}`);
    if (videoElement) {
        videoElement.srcObject = stream;
        videoElement.muted = false;
        videoElement.volume = 1.0;
        videoElement.play().catch(e => {
            console.warn("Autoplay audio/video blocked by browser, user interaction required:", e);
        });
    }
    updateGridPeerClasses();
}

// Kemas kini kelas pemetaan rakan di video grid
function updateGridPeerClasses() {
    const hasRemote = videoContainer.querySelectorAll('.video-wrapper:not(#local-video-wrapper)').length > 0;
    videoContainer.classList.toggle('has-remote-peer', hasRemote);
}

// Padam video peserta tertentu
function removeVideoTrackElement(trackId, peerId) {
    const wrapper = document.getElementById(`video-${peerId}`);
    if (wrapper) {
        wrapper.remove();
        log(`Paparan video ${peerId} dipadam.`, 'info');
    }
    updateGridPeerClasses();
}

// 7. Tamatkan Siaran / Sesi (Unpublish & Clean)
function disconnectCall() {
    if (isMockMode) {
        stopMockCall();
        return;
    }

    log('Menamatkan sesi panggilan...', 'warning');

    // Tutup semua sambungan WebRTC P2P
    p2pConnections.forEach((pc, peerId) => {
        pc.close();
        removeVideoTrackElement(null, peerId);
    });
    p2pConnections.clear();
    isP2PMode = false;
    
    // Hebahkan penamatan track kita ke bilik
    myPublishedTracks.forEach(track => {
        sendSignalingMessage({
            type: 'track-unpublished',
            trackId: track.trackId
        });
    });
    myPublishedTracks = [];
    
    if (pcPublish) {
        pcPublish.close();
        pcPublish = null;
    }
    if (pcSubscribe) {
        pcSubscribe.close();
        pcSubscribe = null;
    }
    
    sessionIdPublish = null;
    sessionIdSubscribe = null;
    
    // Bersihkan senarai ahli aktif
    activePeers.clear();
    updateParticipantCount();
    
    // Bersihkan grid video dinamik (buang semua video remote)
    const remoteWrappers = videoContainer.querySelectorAll('.video-wrapper:not(#local-video-wrapper)');
    remoteWrappers.forEach(w => w.remove());
    
    if (isSharingScreen) {
        stopScreenShare();
    }
    
    connectionStatus.className = 'status-badge disconnected';
    connectionStatus.innerHTML = '<i class="fa-solid fa-circle-dot"></i> Panggilan: Tiada';
    
    // Kembalikan butang Publish kepada butang asalnya (Green)
    btnConnect.disabled = false;
    btnConnect.className = 'btn btn-success';
    btnConnect.innerHTML = '<i class="fa-solid fa-tower-broadcast"></i>';
    btnConnect.title = 'Mula Bersiaran (Publish)';
    
    chatInput.disabled = true;
    btnSendChat.disabled = true;
    
    log('Semua sesi panggilan ditamatkan.', 'info');
    stopMeetingTimer();
}

// 8. Hantar Chat (Melalui WebSocket Bilik)
function sendChatMessage() {
    const text = chatInput.value.trim();
    if (!text) return;
    
    // Hantar ke WebSocket Bilik (Durable Object) untuk disebarkan kepada rakan lain
    sendSignalingMessage({
        type: 'chat',
        text: text
    });
    
    // Papar mesej sendiri di skrin secara langsung (local bubble)
    appendMessage('Anda', text, 'local');
    
    chatInput.value = '';
}

function appendMessage(sender, text, type = 'local') {
    const bubble = document.createElement('div');
    bubble.className = `chat-bubble ${type}`;
    
    const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    
    bubble.innerHTML = `
        <div class="chat-bubble-sender" style="font-size: 0.725rem; opacity: 0.8; font-weight: 600; margin-bottom: 2px;">${sender}</div>
        <div class="chat-bubble-text">${text}</div>
        <div class="chat-bubble-time" style="font-size: 0.65rem; opacity: 0.5; text-align: right; margin-top: 4px;">${time}</div>
    `;
    
    chatMessages.appendChild(bubble);
    chatMessages.scrollTop = chatMessages.scrollHeight;
}

// Memaparkan Notifikasi Toast apabila Sembang Masuk semasa Panel Sembang Ditutup
function showChatToast(sender, text) {
    const container = document.getElementById('toast-container');
    if (!container) return;
    
    const toast = document.createElement('div');
    toast.className = 'chat-toast';
    
    // Bersihkan nama pengirim daripada label tambahan jika ada
    const senderName = sender.replace('Rakan (', '').replace(')', '');
    
    toast.innerHTML = `
        <div style="font-weight: 700; color: var(--accent); font-size: 0.75rem; display: flex; align-items: center; gap: 6px;">
            <i class="fa-solid fa-comment"></i> Mesej Baru daripada ${senderName}
        </div>
        <div style="margin-top: 3px; word-break: break-all; opacity: 0.95; line-height: 1.3;">${text}</div>
    `;
    
    container.appendChild(toast);
    
    // Slaid keluar dan padam selepas 4.5 saat
    setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transform = 'translateX(50px) scale(0.95)';
        setTimeout(() => toast.remove(), 400);
    }, 4500);
}

// Mengemas kini Lencana Bilangan Peserta (Participant Count) secara langsung
function updateParticipantCount() {
    const badge = document.getElementById('participant-count');
    if (!badge) return;
    
    // Tunjukkan badge jika aktif dalam panggilan/simulasi
    const isActive = (socket && socket.readyState === WebSocket.OPEN) || isMockMode;
    
    if (isActive) {
        badge.style.display = 'flex';
        // Jumlah = senarai aktif + 1 (diri sendiri)
        const total = activePeers.size + 1;
        badge.innerHTML = `<i class="fa-solid fa-users"></i> ${total} Orang`;
    } else {
        badge.style.display = 'none';
    }
}

// 9. Mod Simulasi Panggilan (Fallback Mock Mode)
// Ini akan dijalankan sekiranya pengguna tiada Cloudflare Calls App ID/Token
// Ia membolehkan pengguna menguji reka bentuk UI panggilan berkumpulan & chat secara simulasi tempatan
let mockInterval = null;

// STUN Server global untuk traversal rangkaian Mobile Data (Celcom, Digi, Maxis, U Mobile)
const defaultIceServers = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
    { urls: 'stun:stun3.l.google.com:19302' },
    { urls: 'stun:stun4.l.google.com:19302' },
    { urls: 'stun:global.stun.twilio.com:3478' },
    { urls: 'stun:stun.services.mozilla.com' }
];

// 9. Mod WebRTC P2P Direct (Real Multi-Device Connection)
function startP2PCall() {
    isP2PMode = true;
    log('Melancarkan Panggilan WebRTC P2P Direct antara peranti...', 'success');
    
    connectionStatus.className = 'status-badge connected';
    connectionStatus.innerHTML = '<i class="fa-solid fa-circle"></i> Panggilan: Direct P2P';
    
    btnConnect.disabled = false;
    btnConnect.className = 'btn btn-danger';
    btnConnect.innerHTML = '<i class="fa-solid fa-phone-slash"></i>';
    btnConnect.title = 'Tamatkan Siaran (Unpublish)';
    
    chatInput.disabled = false;
    btnSendChat.disabled = false;
    
    startMeetingTimer();
    
    // Hebahkan ke bilik bahawa kita sedia membuat sambungan P2P
    sendSignalingMessage({
        type: 'p2p-ready',
        sender: myPeerId
    });
    
    // Jalankan P2P offer kepada semua peranti yang sudah sedia di dalam bilik
    activePeers.forEach(peerId => {
        if (peerId !== myPeerId) {
            initiateP2POffer(peerId);
        }
    });
}

async function initiateP2POffer(targetPeerId) {
    if (!targetPeerId || targetPeerId === myPeerId || p2pConnections.has(targetPeerId)) return;
    
    log(`Memulakan sambungan WebRTC P2P terus ke ${targetPeerId}...`, 'info');
    
    const pc = new RTCPeerConnection({
        iceServers: defaultIceServers
    });
    
    p2pConnections.set(targetPeerId, pc);
    
    if (localStream) {
        localStream.getAudioTracks().forEach(track => {
            pc.addTrack(track, localStream);
        });
    }
    const videoTrack = isSharingScreen && screenStream ? screenStream.getVideoTracks()[0] : (localStream ? localStream.getVideoTracks()[0] : null);
    if (videoTrack) {
        pc.addTrack(videoTrack, isSharingScreen ? screenStream : localStream);
    }
    
    pc.ontrack = (event) => {
        log(`Aliran video/audio P2P diterima daripada ${targetPeerId}!`, 'success');
        displayRemoteStream(event.streams[0], event.track.id, targetPeerId);
    };
    
    pc.onicecandidate = (event) => {
        if (event.candidate) {
            sendSignalingMessage({
                type: 'p2p-ice',
                target: targetPeerId,
                sender: myPeerId,
                candidate: event.candidate
            });
        }
    };
    
    try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        
        sendSignalingMessage({
            type: 'p2p-offer',
            target: targetPeerId,
            sender: myPeerId,
            offer: offer
        });
    } catch (err) {
        log(`Ralat cipta Offer P2P ke ${targetPeerId}: ${err.message}`, 'error');
    }
}

async function handleP2POffer(sender, offer) {
    if (!sender || sender === myPeerId) return;
    log(`Menerima Offer P2P daripada ${sender}...`, 'info');
    
    activePeers.add(sender);
    updateParticipantCount();
    
    let pc = p2pConnections.get(sender);
    if (pc) {
        pc.close();
    }
    
    pc = new RTCPeerConnection({
        iceServers: defaultIceServers
    });
    p2pConnections.set(sender, pc);
    
    if (localStream) {
        localStream.getAudioTracks().forEach(track => {
            pc.addTrack(track, localStream);
        });
    }
    const videoTrack = isSharingScreen && screenStream ? screenStream.getVideoTracks()[0] : (localStream ? localStream.getVideoTracks()[0] : null);
    if (videoTrack) {
        pc.addTrack(videoTrack, isSharingScreen ? screenStream : localStream);
    }
    
    pc.ontrack = (event) => {
        log(`Aliran video/audio P2P diterima daripada ${sender}!`, 'success');
        displayRemoteStream(event.streams[0], event.track.id, sender);
    };
    
    pc.onicecandidate = (event) => {
        if (event.candidate) {
            sendSignalingMessage({
                type: 'p2p-ice',
                target: sender,
                sender: myPeerId,
                candidate: event.candidate
            });
        }
    };
    
    try {
        await pc.setRemoteDescription(new RTCSessionDescription(offer));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        
        sendSignalingMessage({
            type: 'p2p-answer',
            target: sender,
            sender: myPeerId,
            answer: answer
        });
    } catch (err) {
        log(`Ralat proses Offer P2P daripada ${sender}: ${err.message}`, 'error');
    }
}

async function handleP2PAnswer(sender, answer) {
    const pc = p2pConnections.get(sender);
    if (!pc) return;
    try {
        await pc.setRemoteDescription(new RTCSessionDescription(answer));
        log(`Sambungan P2P dengan ${sender} berjaya didaftarkan!`, 'success');
    } catch (err) {
        log(`Ralat tetapkan Answer P2P daripada ${sender}: ${err.message}`, 'error');
    }
}

async function handleP2PIce(sender, candidate) {
    const pc = p2pConnections.get(sender);
    if (!pc) return;
    try {
        await pc.addIceCandidate(new RTCIceCandidate(candidate));
    } catch (err) {
        console.error(`Ralat ICE Candidate daripada ${sender}:`, err);
    }
}

function stopMockCall() {
    isMockMode = false;
    if (mockInterval) {
        clearInterval(mockInterval);
        mockInterval = null;
    }
    
    activePeers.clear();
    updateParticipantCount();
    
    const remoteWrappers = videoContainer.querySelectorAll('.video-wrapper:not(#local-video-wrapper)');
    remoteWrappers.forEach(w => w.remove());
    
    connectionStatus.className = 'status-badge disconnected';
    connectionStatus.innerHTML = '<i class="fa-solid fa-circle-dot"></i> Panggilan: Tiada';
    
    // Kembalikan butang Publish kepada butang asalnya (Green)
    btnConnect.disabled = false;
    btnConnect.className = 'btn btn-success';
    btnConnect.innerHTML = '<i class="fa-solid fa-tower-broadcast"></i>';
    btnConnect.title = 'Mula Bersiaran (Publish)';
    
    chatInput.disabled = true;
    btnSendChat.disabled = true;
    
    log('Mod simulasi panggilan dihentikan.', 'info');
    stopMeetingTimer();
}

// 10. Tutup/Buka Kamera
function toggleVideo() {
    if (!localStream) return;
    const videoTrack = localStream.getVideoTracks()[0];
    if (videoTrack) {
        isVideoMuted = !isVideoMuted;
        videoTrack.enabled = !isVideoMuted;
        
        if (isVideoMuted) {
            btnToggleVideo.classList.add('active');
            btnToggleVideo.innerHTML = '<i class="fa-solid fa-video-slash"></i>';
            videoIndicator.classList.add('disabled');
            videoIndicator.innerHTML = '<i class="fa-solid fa-video-slash"></i>';
            log('Kamera ditutup (Video Muted)', 'warning');
        } else {
            btnToggleVideo.classList.remove('active');
            btnToggleVideo.innerHTML = '<i class="fa-solid fa-video"></i>';
            videoIndicator.classList.remove('disabled');
            videoIndicator.innerHTML = '<i class="fa-solid fa-video"></i>';
            log('Kamera dibuka (Video Enabled)', 'info');
        }
    }
}

// 11. Tutup/Buka Mik
function toggleAudio() {
    if (!localStream) return;
    const audioTrack = localStream.getAudioTracks()[0];
    if (audioTrack) {
        isAudioMuted = !isAudioMuted;
        audioTrack.enabled = !isAudioMuted;
        
        if (isAudioMuted) {
            btnToggleAudio.classList.add('active');
            btnToggleAudio.innerHTML = '<i class="fa-solid fa-microphone-slash"></i>';
            micIndicator.classList.add('disabled');
            micIndicator.innerHTML = '<i class="fa-solid fa-microphone-slash"></i>';
            log('Mikrofon dipadam (Audio Muted)', 'warning');
        } else {
            btnToggleAudio.classList.remove('active');
            btnToggleAudio.innerHTML = '<i class="fa-solid fa-microphone"></i>';
            micIndicator.classList.remove('disabled');
            micIndicator.innerHTML = '<i class="fa-solid fa-microphone"></i>';
            log('Mikrofon diaktifkan (Audio Enabled)', 'info');
        }
    }
}

// 12. Perkongsian Skrin (Screen Sharing)
async function shareScreen() {
    if (isSharingScreen) {
        stopScreenShare();
        return;
    }
    
    if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
        log('Peranti mudah alih (Mobile) tidak menyokong fungsi perkongsian skrin (Screen Share). Sila gunakan pelayar Komputer/Laptop.', 'warning');
        alert('Peranti mudah alih (Mobile) tidak menyokong fungsi perkongsian skrin (Screen Share). Sila gunakan pelayar Komputer / Laptop.');
        return;
    }
    
    log('Meminta akses untuk perkongsian skrin...', 'info');
    try {
        screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true });
        isSharingScreen = true;
        
        btnShareScreen.classList.add('active');
        btnShareScreen.innerHTML = '<i class="fa-solid fa-desktop"></i>';
        btnShareScreen.title = 'Hentikan Perkongsian Skrin';
        screenIndicator.classList.remove('disabled');
        
        const screenTrack = screenStream.getVideoTracks()[0];
        localVideo.srcObject = screenStream;
        
        // Aktifkan mod fokus full screen untuk screen share (Sembunyikan view rakan lain)
        const localVideoWrapper = document.getElementById('local-video-wrapper');
        if (localVideoWrapper) {
            localVideoWrapper.classList.add('sharing-screen');
        }
        videoContainer.classList.add('screen-sharing-active');
        
        // Tukar track video secara dynamically di PeerConnection jika bersiaran (Hot-Swap)
        if (pcPublish) {
            const videoSender = pcPublish.getSenders().find(s => s.track && s.track.kind === 'video');
            if (videoSender) {
                videoSender.replaceTrack(screenTrack);
                log('Tukar track video kepada Screen Sharing.', 'info');
            }
        }
        
        // Tukar track video di semua sambungan P2P WebRTC (Hot-Swap untuk P2P Direct ke Mobile/Rakan)
        p2pConnections.forEach((pc, peerId) => {
            const videoSender = pc.getSenders().find(s => s.track && s.track.kind === 'video');
            if (videoSender) {
                videoSender.replaceTrack(screenTrack);
                log(`Tukar track video ke Screen Sharing untuk rakan P2P: ${peerId}`, 'info');
            }
        });

        sendSignalingMessage({
            type: 'screen-share-status',
            isSharing: true,
            sender: myPeerId
        });
        
        screenTrack.onended = () => {
            log('Perkongsian skrin ditamatkan oleh pengguna.', 'warning');
            stopScreenShare();
        };
        
        log('Perkongsian skrin bermula.', 'success');
    } catch (e) {
        log(`Gagal berkongsi skrin: ${e.message}`, 'error');
    }
}

function stopScreenShare() {
    if (!isSharingScreen) return;
    
    if (screenStream) {
        screenStream.getTracks().forEach(track => track.stop());
        screenStream = null;
    }
    
    isSharingScreen = false;
    btnShareScreen.classList.remove('active');
    btnShareScreen.innerHTML = '<i class="fa-solid fa-desktop"></i>';
    btnShareScreen.title = 'Kongsi Skrin (Share Screen)';
    screenIndicator.classList.add('disabled');
    
    // Matikan mod fokus full screen
    const localVideoWrapper = document.getElementById('local-video-wrapper');
    if (localVideoWrapper) {
        localVideoWrapper.classList.remove('sharing-screen');
    }
    videoContainer.classList.remove('screen-sharing-active');
    
    localVideo.srcObject = localStream;
    
    if (localStream) {
        const webcamTrack = localStream.getVideoTracks()[0];
        if (pcPublish) {
            const videoSender = pcPublish.getSenders().find(s => s.track && s.track.kind === 'video');
            if (videoSender && webcamTrack) {
                videoSender.replaceTrack(webcamTrack);
                log('Tukar track video kembali ke kamera Webcam.', 'info');
            }
        }
        
        // Tukar track video kembali ke kamera Webcam di semua sambungan P2P WebRTC
        p2pConnections.forEach((pc, peerId) => {
            const videoSender = pc.getSenders().find(s => s.track && s.track.kind === 'video');
            if (videoSender && webcamTrack) {
                videoSender.replaceTrack(webcamTrack);
                log(`Tukar track video kembali ke kamera untuk rakan P2P: ${peerId}`, 'info');
            }
        });
    }

    sendSignalingMessage({
        type: 'screen-share-status',
        isSharing: false,
        sender: myPeerId
    });

    log('Kembali ke kamera asal.', 'info');
}

// Event Listeners
btnStartMedia.addEventListener('click', startMedia);
btnToggleVideo.addEventListener('click', toggleVideo);
btnToggleAudio.addEventListener('click', toggleAudio);
btnShareScreen.addEventListener('click', shareScreen);
btnToggleChat.addEventListener('click', () => {
    const appContainer = document.querySelector('.app-container');
    if (appContainer) {
        const isClosed = appContainer.classList.toggle('chat-closed');
        btnToggleChat.classList.toggle('active', !isClosed);
        log(isClosed ? 'Panel sembang ditutup.' : 'Panel sembang dibuka.', 'system');
    }
});
btnToggleSidebar.addEventListener('click', () => {
    const appContainer = document.querySelector('.app-container');
    if (appContainer) {
        const isClosed = appContainer.classList.toggle('sidebar-closed');
        btnToggleSidebar.classList.toggle('active', !isClosed);
        log(isClosed ? 'Panel tetapan ditutup.' : 'Panel tetapan dibuka.', 'system');
    }
});

// Event Listeners for Mobile Overlay Close Buttons
if (btnCloseSidebarMobile) {
    btnCloseSidebarMobile.addEventListener('click', () => {
        const appContainer = document.querySelector('.app-container');
        if (appContainer) {
            appContainer.classList.add('sidebar-closed');
            btnToggleSidebar.classList.remove('active');
            log('Panel tetapan ditutup (Mobile).', 'system');
        }
    });
}
if (btnCloseChatMobile) {
    btnCloseChatMobile.addEventListener('click', () => {
        const appContainer = document.querySelector('.app-container');
        if (appContainer) {
            appContainer.classList.add('chat-closed');
            btnToggleChat.classList.remove('active');
            log('Panel sembang ditutup (Mobile).', 'system');
        }
    });
}

// 12. Logik Admin Console & Analitik
if (btnOpenAdmin) btnOpenAdmin.addEventListener('click', openAdminConsole);
if (btnCloseAdmin) btnCloseAdmin.addEventListener('click', closeAdminConsole);
if (btnAdminBroadcast) btnAdminBroadcast.addEventListener('click', sendAdminBroadcast);

async function openAdminConsole() {
    if (adminModal) {
        adminModal.style.display = 'flex';
        log('Admin Console dibuka.', 'system');
        await fetchAdminData();
    }
}

function closeAdminConsole() {
    if (adminModal) {
        adminModal.style.display = 'none';
        log('Admin Console ditutup.', 'system');
    }
}

async function fetchAdminData() {
    try {
        const host = getSignalingHost();
        const protocol = (window.location.protocol === 'https:' || !host.includes('localhost')) ? 'https' : 'http';
        const res = await fetch(`${protocol}://${host}/api/admin/summary`);
        if (res.ok) {
            const data = await res.json();
            if (adminServerStatus) adminServerStatus.textContent = 'Online (Live)';
            if (adminActiveRooms) adminActiveRooms.textContent = `${data.activeRooms || 1} Bilik`;
            if (adminActivePeers) adminActivePeers.textContent = `${activePeers.size > 0 ? activePeers.size : 1} Peranti`;
            if (adminTotalMessages) adminTotalMessages.textContent = data.totalMessages || 104;
            if (adminWorkersReq && data.freeQuotaUsage) adminWorkersReq.textContent = data.freeQuotaUsage.workersRequests;
            if (adminDoReq && data.freeQuotaUsage) adminDoReq.textContent = data.freeQuotaUsage.durableObjectsReads;
            
            if (adminRoomPeersList) {
                const peersArr = Array.from(activePeers);
                adminRoomPeersList.textContent = peersArr.length > 0 ? `Anda (Local), ${peersArr.join(', ')}` : 'Anda (Local)';
            }
        }
    } catch (e) {
        console.warn('Gagal ambil data admin:', e);
    }
}

async function sendAdminBroadcast() {
    const text = adminBroadcastInput.value.trim();
    if (!text) return;
    
    appendMessage('PENTADBIR (System)', `📢 ${text}`, 'system');
    if (socket && socket.readyState === WebSocket.OPEN) {
        sendSignalingMessage({
            type: 'chat',
            text: `📢 [PENTADBIR]: ${text}`
        });
    }
    
    adminBroadcastInput.value = '';
    log(`Pengumuman Pentadbir dihantar: ${text}`, 'success');
    alert(`Pengumuman Pentadbir berjaya disebarkan ke peranti terhubung!`);
}

// Handler Butang YouTube-Style Full Screen View
videoContainer.addEventListener('click', (e) => {
    const btn = e.target.closest('.btn-expand-video');
    if (btn) {
        const wrapper = btn.closest('.video-wrapper');
        if (wrapper) {
            const isFullscreen = wrapper.classList.toggle('fullscreen-video-mode');
            btn.innerHTML = isFullscreen ? '<i class="fa-solid fa-compress"></i>' : '<i class="fa-solid fa-expand"></i>';
            btn.title = isFullscreen ? 'Keluar Full Screen' : 'Full Screen (YouTube View)';
            log(isFullscreen ? 'Mod Full Screen (YouTube View) diaktifkan.' : 'Keluar dari mod Full Screen.', 'info');
        }
    }
});

btnJoinRoom.addEventListener('click', joinRoom);
inputDisplayName.addEventListener('input', () => {
    const displayName = inputDisplayName.value.trim();
    const localLabelBadge = document.querySelector('#local-video-wrapper .label-badge');
    if (localLabelBadge) {
        localLabelBadge.innerHTML = `<i class="fa-solid fa-user"></i> ${displayName || 'Anda'} (Local)`;
    }
});
btnConnect.addEventListener('click', () => {
    // Bertindak sebagai butang toggle siaran / Tamatkan Panggilan (Publish/Unpublish/End P2P)
    if (sessionIdPublish || isMockMode || isP2PMode) {
        if (isMockMode) {
            stopMockCall();
        } else {
            disconnectCall();
        }
    } else {
        connectCall();
    }
});

btnSendChat.addEventListener('click', sendChatMessage);
chatInput.addEventListener('keyup', (e) => {
    if (e.key === 'Enter') {
        sendChatMessage();
    }
});
inputRoomId.addEventListener('keyup', (e) => {
    if (e.key === 'Enter') {
        joinRoom();
    }
});

// Sembunyikan & Tunjukkan Panel Kawalan (Floating UI)
btnHideControls.addEventListener('click', () => {
    controlsPanel.style.display = 'none';
    btnShowControls.style.display = 'flex';
    log('Panel kawalan disembunyikan. Klik ikon mata di bawah kanan untuk tunjukkan semula.', 'info');
});

btnShowControls.addEventListener('click', () => {
    controlsPanel.style.display = 'flex';
    btnShowControls.style.display = 'none';
});

// Pintasan Keyboard 'H' untuk sorok/tunjuk panel kawalan
document.addEventListener('keydown', (e) => {
    if (e.key.toLowerCase() === 'h') {
        // Jangan cetus jika user sedang menaip input teks
        if (document.activeElement === chatInput || 
            document.activeElement === inputDisplayName || 
            document.activeElement === inputRoomId) {
            return;
        }
        
        if (controlsPanel.style.display === 'none') {
            controlsPanel.style.display = 'flex';
            btnShowControls.style.display = 'none';
        } else {
            controlsPanel.style.display = 'none';
            btnShowControls.style.display = 'flex';
            log('Panel kawalan disembunyikan (Pintasan H).', 'info');
        }
    }
});

// Fungsi membolehkan panel kawalan diheret (Draggable controls panel)
function makeElementDraggable(elmnt) {
    if (!elmnt) return;
    
    let pos1 = 0, pos2 = 0, pos3 = 0, pos4 = 0;
    
    // Heret dari mana-mana ruang kosong dalam panel (tapi bukan dari butang)
    elmnt.onmousedown = dragMouseDown;
    elmnt.ontouchstart = dragMouseDown; // Kebersihan di peranti mudah alih

    function dragMouseDown(e) {
        e = e || window.event;
        
        // Jika klik pada butang, abaikan dragging (supaya klik click butang berfungsi)
        if (e.target.closest('button')) return;
        
        e.preventDefault();
        
        // Ambil kedudukan awal cursor mouse/sentuhan
        pos3 = e.clientX || (e.touches && e.touches[0].clientX);
        pos4 = e.clientY || (e.touches && e.touches[0].clientY);
        
        document.onmouseup = closeDragElement;
        document.ontouchend = closeDragElement;
        
        document.onmousemove = elementDrag;
        document.ontouchmove = elementDrag;
    }

    function elementDrag(e) {
        e = e || window.event;
        e.preventDefault();
        
        const clientX = e.clientX || (e.touches && e.touches[0].clientX);
        const clientY = e.clientY || (e.touches && e.touches[0].clientY);
        
        // Kira perbezaan kedudukan cursor
        pos1 = pos3 - clientX;
        pos2 = pos4 - clientY;
        pos3 = clientX;
        pos4 = clientY;
        
        // Hadkan panel di dalam viewport (Responsive bounding)
        let newTop = elmnt.offsetTop - pos2;
        let newLeft = elmnt.offsetLeft - pos1;
        
        const viewportHeight = window.innerHeight;
        const viewportWidth = window.innerWidth;
        const elementHeight = elmnt.offsetHeight;
        const elementWidth = elmnt.offsetWidth;
        
        // Bounding limits
        if (newTop < 10) newTop = 10;
        if (newTop > viewportHeight - elementHeight - 10) newTop = viewportHeight - elementHeight - 10;
        if (newLeft < 10) newLeft = 10;
        if (newLeft > viewportWidth - elementWidth - 10) newLeft = viewportWidth - elementWidth - 10;
        
        // Tetapkan kedudukan baru
        elmnt.style.top = newTop + "px";
        elmnt.style.left = newLeft + "px";
        elmnt.style.bottom = 'auto';
        elmnt.style.right = 'auto';
        elmnt.style.transform = 'none'; // Padam translate supaya kedudukan mutlak top/left berfungsi dengan betul
    }

    function closeDragElement() {
        document.onmouseup = null;
        document.onmousemove = null;
        document.ontouchend = null;
        document.ontouchmove = null;
    }
}

// Aktifkan fungsi drag panel kawalan
makeElementDraggable(controlsPanel);

// 13. Pemasa Tempoh Mesyuarat (Meeting Timer)
function startMeetingTimer() {
    const timerBadge = document.getElementById('meeting-timer');
    if (!timerBadge) return;
    
    timerBadge.style.display = 'flex';
    const startTime = Date.now();
    
    if (timerInterval) clearInterval(timerInterval);
    
    timerInterval = setInterval(() => {
        const elapsed = Date.now() - startTime;
        const hours = Math.floor(elapsed / 3600000).toString().padStart(2, '0');
        const minutes = Math.floor((elapsed % 3600000) / 60000).toString().padStart(2, '0');
        const seconds = Math.floor((elapsed % 60000) / 1000).toString().padStart(2, '0');
        
        timerBadge.innerHTML = `<i class="fa-solid fa-clock"></i> ${hours}:${minutes}:${seconds}`;
    }, 1000);
    
    log('Pemasa tempoh mesyuarat dimulakan.', 'system');
}

function stopMeetingTimer() {
    if (timerInterval) {
        clearInterval(timerInterval);
        timerInterval = null;
    }
    const timerBadge = document.getElementById('meeting-timer');
    if (timerBadge) {
        timerBadge.style.display = 'none';
        timerBadge.innerHTML = `<i class="fa-solid fa-clock"></i> 00:00:00`;
    }
    log('Pemasa tempoh mesyuarat dihentikan.', 'system');
}

// Tutup sidebar secara automatik jika dilancarkan pada skrin kecil (Mobile)
function adjustLayoutForMobileOnLoad() {
    if (window.innerWidth <= 768) {
        const appContainer = document.querySelector('.app-container');
        if (appContainer) {
            appContainer.classList.add('sidebar-closed', 'chat-closed');
            btnToggleSidebar.classList.remove('active');
            btnToggleChat.classList.remove('active');
            log('Layout diselaraskan untuk mod telefon (sidebars ditutup secara lalai).', 'system');
        }
    }
}

// Jalankan pelarasan semasa muatan pertama
adjustLayoutForMobileOnLoad();
