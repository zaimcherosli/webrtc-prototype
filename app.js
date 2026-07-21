// DOM Elements
const videoContainer = document.getElementById('video-container');
const localVideo = document.getElementById('local-video');

const btnStartMedia = document.getElementById('btn-start-media');
const btnToggleVideo = document.getElementById('btn-toggle-video');
const btnToggleAudio = document.getElementById('btn-toggle-audio');
const btnShareScreen = document.getElementById('btn-share-screen');
const btnToggleChat = document.getElementById('btn-toggle-chat');
const btnConnect = document.getElementById('btn-connect');

const inputDisplayName = document.getElementById('input-display-name');
const inputRoomId = document.getElementById('input-room-id');
const btnJoinRoom = document.getElementById('btn-join-room');
const peerIdDisplay = document.getElementById('peer-id-display');

const wsStatus = document.getElementById('ws-status');
const connectionStatus = document.getElementById('connection-status');
const logsContainer = document.getElementById('logs');

const chatMessages = document.getElementById('chat-messages');
const chatInput = document.getElementById('chat-input');
const btnSendChat = document.getElementById('btn-send-chat');

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

// Track mappings
let myPublishedTracks = []; // [{ trackId, label }]
let isVideoMuted = false;
let isAudioMuted = false;
let isSharingScreen = false;
let isMockMode = false; // Set to true if Cloudflare Calls credentials are missing

// Display Generated Peer ID
peerIdDisplay.textContent = `ID Anda: ${myPeerId}`;

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

// Helper to make API calls to backend proxy
async function apiRequest(endpoint, method, body = null) {
    const response = await fetch(`http://${window.location.hostname}:8787/room/${currentRoomId}/calls/${endpoint}`, {
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
        peerIdDisplay.textContent = `Nama Anda: ${myPeerId}`;
    }

    const roomId = inputRoomId.value.trim();
    if (!roomId) {
        alert('Sila masukkan ID Bilik terlebih dahulu.');
        return;
    }

    currentRoomId = roomId;
    log(`Menyambung ke bilik: ${roomId}...`, 'info');
    
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.hostname}:8787/room/${roomId}?peerId=${myPeerId}`;
    
    try {
        socket = new WebSocket(wsUrl);
        
        socket.onopen = () => {
            log('Berjaya disambung ke Cloudflare Workers Signaling Server.', 'success');
            wsStatus.className = 'status-badge connected';
            wsStatus.innerHTML = '<i class="fa-solid fa-circle-nodes"></i> WS: Aktif';
            
            inputDisplayName.disabled = true;
            inputRoomId.disabled = true;
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
        
        socket.onerror = () => {
            log(`Ralat WebSocket. Sila pastikan Cloudflare Worker sedang berjalan di port 8787.`, 'error');
        };
        
    } catch (e) {
        log(`Gagal menyambung WebSocket: ${e.message}`, 'error');
    }
}

function resetRoomUI() {
    inputDisplayName.disabled = false;
    inputRoomId.disabled = false;
    btnJoinRoom.disabled = false;
    btnConnect.disabled = true;
    disconnectCall();
}

// 3. Terima & Proses Isyarat daripada WebSocket
async function handleSignalingMessage(data) {
    switch (data.type) {
        case 'room-joined':
            log(`Anda menyertai bilik "${currentRoomId}" sebagai ${data.peerId}`, 'success');
            btnConnect.disabled = false; // Boleh publish media sekarang
            
            // Langgan semua track yang sedia ada di dalam bilik
            if (data.tracks && data.tracks.length > 0) {
                log(`Menjumpai ${data.tracks.length} track aktif di dalam bilik. Menyambung langganan...`, 'info');
                for (const [trackId, info] of data.tracks) {
                    await subscribeToTrack(trackId, info.sessionId, info.peerId, info.label);
                }
            }
            break;
            
        case 'track-published':
            log(`Peserta ${data.sender} menerbitkan track ${data.label} (${data.trackId})`, 'info');
            await subscribeToTrack(data.trackId, data.sessionId, data.sender, data.label);
            break;
            
        case 'track-unpublished':
            log(`Peserta ${data.sender} menghentikan track ${data.trackId}`, 'warning');
            removeVideoTrackElement(data.trackId, data.sender);
            break;
            
        case 'peer-left':
            log(`Peserta ${data.peerId} meninggalkan bilik panggilan.`, 'warning');
            if (data.deletedTracks) {
                data.deletedTracks.forEach(trackId => {
                    removeVideoTrackElement(trackId, data.peerId);
                });
            }
            // Bersihkan wrapper video kosong jika ada
            const wrapper = document.getElementById(`video-${data.peerId}`);
            if (wrapper) wrapper.remove();
            break;

        case 'chat':
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
                log('Kredensial Cloudflare Calls tiada! Beralih ke SIMULASI MOCK bilik panggilan...', 'warning');
                startMockCall();
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
        
        wrapper.appendChild(video);
        wrapper.appendChild(label);
        videoContainer.appendChild(wrapper);
    }
    
    const videoElement = document.getElementById(`video-el-${peerId}`);
    if (videoElement) {
        videoElement.srcObject = stream;
        videoElement.play().catch(e => console.error("Video play fail:", e));
    }
}

// Padam video peserta tertentu
function removeVideoTrackElement(trackId, peerId) {
    const wrapper = document.getElementById(`video-${peerId}`);
    if (wrapper) {
        wrapper.remove();
        log(`Paparan video ${peerId} dipadam.`, 'info');
    }
}

// 7. Tamatkan Siaran / Sesi (Unpublish & Clean)
function disconnectCall() {
    if (isMockMode) {
        stopMockCall();
        return;
    }

    if (pcPublish || pcSubscribe) {
        log('Menamatkan semua sesi panggilan WebRTC Cloudflare...', 'warning');
    }
    
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
    
    // Untuk SFU 15 orang, chat dihantar terus melalui WebSocket bilik (Durable Object) untuk kecekapan penyiaran
    sendSignalingMessage({
        type: 'chat',
        text: text
    });
    
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

// 9. Mod Simulasi Panggilan (Fallback Mock Mode)
// Ini akan dijalankan sekiranya pengguna tiada Cloudflare Calls App ID/Token
// Ia membolehkan pengguna menguji reka bentuk UI panggilan berkumpulan & chat secara simulasi tempatan
let mockInterval = null;

function startMockCall() {
    isMockMode = true;
    log('Melancarkan mod SIMULASI PANGGILAN KUMPULAN (Local Demo)...', 'success');
    
    connectionStatus.className = 'status-badge connected';
    connectionStatus.innerHTML = '<i class="fa-solid fa-circle"></i> Panggilan: Simulasi';
    
    // Tukar butang kepada butang Unpublish semasa simulasi
    btnConnect.disabled = false;
    btnConnect.className = 'btn btn-danger';
    btnConnect.innerHTML = '<i class="fa-solid fa-phone-slash"></i>';
    btnConnect.title = 'Tamatkan Siaran (Unpublish)';
    
    chatInput.disabled = false;
    btnSendChat.disabled = false;
    
    // Cipta 2 peserta simulasi (Mock Peer A & B) pada grid selepas 1 saat
    setTimeout(() => {
        log('Peserta simulasi "Rakan (Ali)" menyertai panggilan.', 'info');
        displayRemoteStream(localStream, 'mock-track-1', 'Ali');
    }, 1000);
    
    setTimeout(() => {
        log('Peserta simulasi "Rakan (Siti)" menyertai panggilan.', 'info');
        displayRemoteStream(localStream, 'mock-track-2', 'Siti');
    }, 2500);

    // Hantar mesej chat palsu secara berkala
    mockInterval = setInterval(() => {
        const mockMessages = [
            "Hai semua! Dengar tak suara saya?",
            "Reka bentuk UI ni nampak sangat premium! Guna CSS vanilla je ke?",
            "Lancar gila screen share tu.",
            "Nanti kalau push ke cloudflare pages dah boleh deploy terus la kan?",
            "Boleh support 15 orang ke bilik ni? Mantap."
        ];
        const randomPeer = Math.random() > 0.5 ? 'Ali' : 'Siti';
        const randomText = mockMessages[Math.floor(Math.random() * mockMessages.length)];
        
        appendMessage(`Rakan (${randomPeer})`, randomText, 'remote');
    }, 8000);
    
    startMeetingTimer();
}

function stopMockCall() {
    isMockMode = false;
    if (mockInterval) {
        clearInterval(mockInterval);
        mockInterval = null;
    }
    
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
    
    log('Meminta akses untuk perkongsian skrin...', 'info');
    try {
        screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true });
        isSharingScreen = true;
        
        btnShareScreen.classList.add('active');
        btnShareScreen.innerHTML = '<i class="fa-solid fa-desktop"></i> <span>Stop Share</span>';
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
    btnShareScreen.innerHTML = '<i class="fa-solid fa-desktop"></i> <span>Share Screen</span>';
    screenIndicator.classList.add('disabled');
    
    // Matikan mod fokus full screen
    const localVideoWrapper = document.getElementById('local-video-wrapper');
    if (localVideoWrapper) {
        localVideoWrapper.classList.remove('sharing-screen');
    }
    videoContainer.classList.remove('screen-sharing-active');
    
    localVideo.srcObject = localStream;
    
    if (pcPublish && localStream) {
        const webcamTrack = localStream.getVideoTracks()[0];
        const videoSender = pcPublish.getSenders().find(s => s.track && s.track.kind === 'video');
        if (videoSender && webcamTrack) {
            videoSender.replaceTrack(webcamTrack);
            log('Tukar track video kembali ke kamera Webcam.', 'info');
        }
    }
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
btnJoinRoom.addEventListener('click', joinRoom);
btnConnect.addEventListener('click', () => {
    // Bertindak sebagai butang toggle siaran (Publish/Unpublish)
    if (sessionIdPublish || isMockMode) {
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
