// DOM Elements
const localVideo = document.getElementById('local-video');
const remoteVideo = document.getElementById('remote-video');

const btnStartMedia = document.getElementById('btn-start-media');
const btnToggleVideo = document.getElementById('btn-toggle-video');
const btnToggleAudio = document.getElementById('btn-toggle-audio');
const btnShareScreen = document.getElementById('btn-share-screen');
const btnConnect = document.getElementById('btn-connect');
const btnDisconnect = document.getElementById('btn-disconnect');

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
let targetPeerId = null;
let currentRoomId = null;

let localStream = null;
let screenStream = null;
let peerConnection = null;
let dataChannel = null; // Used for E2E WebRTC chat
let socket = null; // WebSocket connection to signaling server

let isVideoMuted = false;
let isAudioMuted = false;
let isSharingScreen = false;

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
        btnJoinRoom.disabled = false; // Aktifkan butang sertai bilik selepas ada media
        
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
    const roomId = inputRoomId.value.trim();
    if (!roomId) {
        alert('Sila masukkan ID Bilik terlebih dahulu.');
        return;
    }

    currentRoomId = roomId;
    log(`Menyambung ke bilik: ${roomId}...`, 'info');
    
    // Tentukan URL WebSocket secara automatik berdasarkan host semasa (biasanya localhost:8787)
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.hostname}:8787/room/${roomId}?peerId=${myPeerId}`;
    
    try {
        socket = new WebSocket(wsUrl);
        
        socket.onopen = () => {
            log('Berjaya disambung ke Cloudflare Workers Signaling Server.', 'success');
            wsStatus.className = 'status-badge connected';
            wsStatus.innerHTML = '<i class="fa-solid fa-circle-nodes"></i> WS: Aktif';
            
            // Kunci input bilik
            inputRoomId.disabled = true;
            btnJoinRoom.disabled = true;
        };
        
        socket.onmessage = async (event) => {
            const data = JSON.parse(event.data);
            handleSignalingMessage(data);
        };
        
        socket.onclose = () => {
            log('Sambungan ke pelayan isyarat terputus.', 'warning');
            wsStatus.className = 'status-badge disconnected';
            wsStatus.innerHTML = '<i class="fa-solid fa-circle-nodes"></i> WS: Putus';
            resetRoomUI();
        };
        
        socket.onerror = (error) => {
            log(`Ralat WebSocket: Hubungan gagal. Sila pastikan Cloudflare Worker sedang berjalan di port 8787.`, 'error');
        };
        
    } catch (e) {
        log(`Gagal menyambung WebSocket: ${e.message}`, 'error');
    }
}

function resetRoomUI() {
    inputRoomId.disabled = false;
    btnJoinRoom.disabled = false;
    btnConnect.disabled = true;
    disconnectCall();
}

// 3. Terima & Proses Isyarat daripada WebSocket
async function handleSignalingMessage(data) {
    switch (data.type) {
        case 'room-joined':
            log(`Anda telah menyertai bilik "${currentRoomId}" sebagai ${data.peerId}`, 'success');
            if (data.peers && data.peers.length > 0) {
                targetPeerId = data.peers[0]; // Set peer pertama sebagai target panggilan
                log(`Rakan sedia ada dikesan: ${targetPeerId}. Anda boleh memulakan panggilan.`, 'info');
                btnConnect.disabled = false;
            } else {
                log('Menunggu rakan lain untuk masuk ke dalam bilik...', 'info');
            }
            break;
            
        case 'peer-joined':
            targetPeerId = data.peerId;
            log(`Rakan baru masuk: ${targetPeerId}. Sedia untuk dihubungi.`, 'info');
            btnConnect.disabled = false;
            break;
            
        case 'peer-left':
            log(`Rakan ${data.peerId} telah meninggalkan bilik.`, 'warning');
            if (data.peerId === targetPeerId) {
                targetPeerId = null;
                btnConnect.disabled = true;
                disconnectCall();
            }
            break;
            
        case 'offer':
            targetPeerId = data.sender;
            log(`Menerima isyarat Panggilan (SDP Offer) daripada ${data.sender}`, 'info');
            await handleOffer(data);
            break;
            
        case 'answer':
            log(`Menerima jawapan Panggilan (SDP Answer) daripada ${data.sender}`, 'info');
            await handleAnswer(data);
            break;
            
        case 'candidate':
            await handleCandidate(data);
            break;
            
        default:
            log(`Isyarat tidak dikenali: ${data.type}`, 'warning');
    }
}

// Pembantu menghantar isyarat melalui WebSocket
function sendSignalingMessage(message) {
    if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify(message));
    } else {
        log('Ralat: WebSocket tidak aktif. Isyarat gagal dihantar.', 'error');
    }
}

// 4. Proses WebRTC: Membina Peer Connection (Initiator)
async function connectCall() {
    log(`Memulakan panggilan WebRTC ke peranti ${targetPeerId}...`, 'info');
    
    connectionStatus.className = 'status-badge connecting';
    connectionStatus.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Menyambung...';
    
    btnConnect.disabled = true;
    
    // Bina Peer Connection
    createPeerConnection();
    
    // Cipta DataChannel untuk chat (Initiator)
    dataChannel = peerConnection.createDataChannel('chatChannel');
    setupDataChannelEvents();
    
    try {
        log('Mencipta SDP Offer...', 'system');
        const offer = await peerConnection.createOffer();
        await peerConnection.setLocalDescription(offer);
        
        sendSignalingMessage({
            type: 'offer',
            target: targetPeerId,
            sdp: offer
        });
        
        log('SDP Offer berjaya dihantar ke WebSocket.', 'success');
    } catch (e) {
        log(`Gagal membina panggilan: ${e.message}`, 'error');
        disconnectCall();
    }
}

// 5. Cipta Objek RTCPeerConnection & Event Handlers
function createPeerConnection() {
    if (peerConnection) return;
    
    log('Mencipta RTCPeerConnection...', 'system');
    const configuration = {
        iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
    };
    
    peerConnection = new RTCPeerConnection(configuration);
    
    // Hantar ICE candidates kita ke pihak sebelah melalui WebSocket
    peerConnection.onicecandidate = event => {
        if (event.candidate && targetPeerId) {
            sendSignalingMessage({
                type: 'candidate',
                target: targetPeerId,
                candidate: event.candidate
            });
        }
    };
    
    // Terima stream video/audio pihak sebelah
    peerConnection.ontrack = event => {
        log('Menerima stream video/audio dari pihak jauh!', 'success');
        if (remoteVideo.srcObject !== event.streams[0]) {
            remoteVideo.srcObject = event.streams[0];
        }
    };
    
    // Pantau status sambungan
    peerConnection.onconnectionstatechange = () => {
        log(`Status WebRTC bertukar: ${peerConnection.connectionState}`, 'info');
        
        if (peerConnection.connectionState === 'connected') {
            connectionStatus.className = 'status-badge connected';
            connectionStatus.innerHTML = '<i class="fa-solid fa-circle"></i> Panggilan: Aktif';
            btnDisconnect.disabled = false;
        } else if (peerConnection.connectionState === 'disconnected' || 
                   peerConnection.connectionState === 'failed' || 
                   peerConnection.connectionState === 'closed') {
            disconnectCall();
        }
    };
    
    // Masukkan track media local (kamera/screen) ke dalam sambungan
    const activeStream = isSharingScreen ? screenStream : localStream;
    if (activeStream) {
        activeStream.getTracks().forEach(track => {
            peerConnection.addTrack(track, activeStream);
        });
        log('Local tracks berjaya dimasukkan ke PeerConnection.', 'system');
    }
}

// 6. Menguruskan Tawaran Panggilan Masuk (Offer Receiver)
async function handleOffer(data) {
    createPeerConnection();
    
    // Mendengar kemasukan DataChannel daripada pemanggil
    peerConnection.ondatachannel = event => {
        dataChannel = event.channel;
        setupDataChannelEvents();
    };
    
    try {
        await peerConnection.setRemoteDescription(new RTCSessionDescription(data.sdp));
        log('Set Remote Description (Offer) selesai.', 'system');
        
        log('Mencipta SDP Answer...', 'system');
        const answer = await peerConnection.createAnswer();
        await peerConnection.setLocalDescription(answer);
        
        sendSignalingMessage({
            type: 'answer',
            target: data.sender,
            sdp: answer
        });
        
        log('SDP Answer dihantar ke pemanggil.', 'success');
    } catch (e) {
        log(`Gagal menjawab panggilan: ${e.message}`, 'error');
    }
}

// 7. Menguruskan Jawapan Panggilan Diterima (Answer Receiver)
async function handleAnswer(data) {
    try {
        if (peerConnection) {
            await peerConnection.setRemoteDescription(new RTCSessionDescription(data.sdp));
            log('Set Remote Description (Answer) selesai. Jaluan panggilan ditubuhkan.', 'success');
        }
    } catch (e) {
        log(`Gagal melengkapkan panggilan: ${e.message}`, 'error');
    }
}

// 8. Menguruskan Kemasukan ICE Candidate
async function handleCandidate(data) {
    try {
        if (peerConnection) {
            await peerConnection.addIceCandidate(new RTCIceCandidate(data.candidate));
            log('ICE Candidate berjaya ditambah.', 'system');
        }
    } catch (e) {
        log(`Ralat menambah ICE Candidate: ${e.message}`, 'error');
    }
}

// 9. Setup Event bagi RTCDataChannel Chat
function setupDataChannelEvents() {
    if (!dataChannel) return;
    
    dataChannel.onopen = () => {
        log('Saluran RTCDataChannel sedia untuk permesejan disulitkan (E2EE).', 'success');
        chatInput.disabled = false;
        btnSendChat.disabled = false;
        
        // Bersihkan mesej pembuka
        chatMessages.innerHTML = '';
        const systemMsg = document.createElement('div');
        systemMsg.className = 'chat-system-message';
        systemMsg.innerHTML = '<i class="fa-solid fa-lock"></i> Chat WebRTC Disulitkan sepenuhnya (E2EE).';
        chatMessages.appendChild(systemMsg);
    };
    
    dataChannel.onmessage = event => {
        appendMessage('Rakan (Remote)', event.data, 'remote');
    };
    
    dataChannel.onclose = () => {
        log('Saluran RTCDataChannel ditutup.', 'warning');
        chatInput.disabled = true;
        btnSendChat.disabled = true;
    };
}

// 10. Hantar Mesej Chat
function sendChatMessage() {
    const text = chatInput.value.trim();
    if (!text) return;
    
    if (dataChannel && dataChannel.readyState === 'open') {
        dataChannel.send(text);
        appendMessage('Anda (Local)', text, 'local');
        chatInput.value = '';
    } else {
        log('Gagal hantar chat: Saluran tidak aktif.', 'error');
    }
}

function appendMessage(sender, text, type) {
    const bubble = document.createElement('div');
    bubble.className = `chat-bubble ${type}`;
    
    const senderSpan = document.createElement('span');
    senderSpan.className = 'sender-name';
    senderSpan.textContent = sender;
    
    const textNode = document.createTextNode(text);
    
    bubble.appendChild(senderSpan);
    bubble.appendChild(textNode);
    
    chatMessages.appendChild(bubble);
    chatMessages.scrollTop = chatMessages.scrollHeight;
}

// 11. Tamatkan Panggilan
function disconnectCall() {
    if (peerConnection || dataChannel) {
        log('Memutuskan sambungan panggilan WebRTC...', 'warning');
    }
    
    if (dataChannel) {
        dataChannel.close();
        dataChannel = null;
    }
    
    if (peerConnection) {
        peerConnection.close();
        peerConnection = null;
    }
    
    remoteVideo.srcObject = null;
    
    if (isSharingScreen) {
        stopScreenShare();
    }
    
    connectionStatus.className = 'status-badge disconnected';
    connectionStatus.innerHTML = '<i class="fa-solid fa-circle-dot"></i> Panggilan: Tiada';
    
    btnDisconnect.disabled = true;
    if (targetPeerId) {
        btnConnect.disabled = false;
    }
    
    chatInput.disabled = true;
    btnSendChat.disabled = true;
}

// 12. Tutup/Buka Kamera
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

// 13. Tutup/Buka Mik
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

// 14. Perkongsian Skrin (Hot-Swap Video Track)
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
        
        // Tukar track video secara dynamically di PeerConnection jika panggilan sedang berjalan
        if (peerConnection) {
            const videoSender = peerConnection.getSenders().find(s => s.track && s.track.kind === 'video');
            if (videoSender) {
                videoSender.replaceTrack(screenTrack);
                log('Tukar track video kepada Screen Sharing secara dynamic.', 'info');
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
    
    localVideo.srcObject = localStream;
    
    if (peerConnection && localStream) {
        const webcamTrack = localStream.getVideoTracks()[0];
        const videoSender = peerConnection.getSenders().find(s => s.track && s.track.kind === 'video');
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
btnJoinRoom.addEventListener('click', joinRoom);
btnConnect.addEventListener('click', connectCall);
btnDisconnect.addEventListener('click', disconnectCall);

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
