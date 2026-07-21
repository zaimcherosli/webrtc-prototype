// Cloudflare Worker & Durable Object Signaling Server (Fasa 2 - Cloudflare Calls SFU)

// 1. Durable Object Class to manage room-level active tracks and connections
export class SignalingRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.tracks = new Map(); // Simpan tracks aktif: trackId -> { peerId, label }
  }

  async fetch(request) {
    const url = new URL(request.url);
    const peerId = url.searchParams.get("peerId");
    
    if (!peerId) {
      return new Response("Ralat: Parameter 'peerId' diperlukan.", { status: 400 });
    }

    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Ralat: Dapatkan sambungan WebSocket sahaja.", { status: 426 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    this.state.acceptWebSocket(server);
    server.serializeAttachment({ peerId });

    return new Response(null, {
      status: 101,
      webSocket: client
    });
  }

  async webSocketMessage(ws, message) {
    try {
      const data = JSON.parse(message);
      const senderAttachment = ws.deserializeAttachment();
      const senderPeerId = senderAttachment ? senderAttachment.peerId : "Unknown";

      data.sender = senderPeerId;

      if (data.type === "join") {
        // Hantar isyarat sertai bilik secara rasmi sekarang setelah client bersedia
        ws.send(JSON.stringify({
          type: "room-joined",
          peerId: senderPeerId,
          tracks: Array.from(this.tracks.entries())
        }));

        // Hebahkan kepada rakan lain
        this.broadcast({
          type: "peer-joined",
          peerId: senderPeerId
        }, ws);
        return;
      }

      if (data.type === "track-published") {
        // Daftarkan track baru di dalam bilik
        this.tracks.set(data.trackId, { peerId: senderPeerId, label: data.label });
        console.log(`Track diterbitkan: ${data.trackId} oleh ${senderPeerId}`);
        
        // Hebahkan kepada semua orang di dalam bilik
        this.broadcast(data, ws);
      } 
      else if (data.type === "track-unpublished") {
        // Buang track daripada bilik
        this.tracks.delete(data.trackId);
        console.log(`Track dihentikan: ${data.trackId}`);
        
        this.broadcast(data, ws);
      } 
      else {
        // Hebahkan mesej lain (contoh: Chat teks)
        this.broadcast(data, ws);
      }
    } catch (error) {
      console.error("Ralat memproses mesej WebSocket di DO:", error);
    }
  }

  async webSocketClose(ws, code, reason, wasClean) {
    this.handleDisconnect(ws);
    ws.close(code, "Sambungan ditutup");
  }

  async webSocketError(ws, error) {
    this.handleDisconnect(ws);
    ws.close(1011, "Ralat sambungan");
  }

  // Membersihkan tracks bagi peer yang telah terputus sambungan
  handleDisconnect(ws) {
    const attachment = ws.deserializeAttachment();
    if (attachment) {
      const peerId = attachment.peerId;
      const deletedTracks = [];

      this.tracks.forEach((info, trackId) => {
        if (info.peerId === peerId) {
          deletedTracks.push(trackId);
          this.tracks.delete(trackId);
        }
      });

      console.log(`Peer keluar: ${peerId}. Memadam ${deletedTracks.length} tracks.`);

      // Maklumkan kepada peer lain tentang pemergian peer ini dan tracks yang dipadam
      this.broadcast({
        type: "peer-left",
        peerId: peerId,
        deletedTracks: deletedTracks
      }, ws);
    }
  }

  broadcast(messageObj, excludeWs) {
    const messageString = JSON.stringify(messageObj);
    this.state.getWebSockets().forEach(client => {
      if (client !== excludeWs && client.readyState === 1) {
        client.send(messageString);
      }
    });
  }
}

// 2. Main Entry Point (Router dengan Proxy API Cloudflare Calls)
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    // Sediakan CORS headers untuk membolehkan frontend (port 8080) membuat permintaan
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS, PUT",
      "Access-Control-Allow-Headers": "Content-Type",
      "Content-Type": "application/json"
    };

    // 2a. Mengendalikan CORS Preflight Options
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders
      });
    }

    // 2b. Proxy Endpoint: Cipta Sesi Cloudflare Calls Baru
    // POST /room/<roomId>/calls/session
    const sessionMatch = path.match(/^\/room\/([^\/]+)\/calls\/session$/);
    if (sessionMatch && request.method === "POST") {
      return handleCallsSession(request, env, corsHeaders);
    }

    // 2c. Proxy Endpoint: Tambah/Langgan Track Media
    // POST /room/<roomId>/calls/sessions/<sessionId>/tracks
    const tracksMatch = path.match(/^\/room\/([^\/]+)\/calls\/sessions\/([^\/]+)\/tracks$/);
    if (tracksMatch && request.method === "POST") {
      const sessionId = tracksMatch[2];
      return handleCallsTracks(request, env, sessionId, corsHeaders);
    }

    // 2d. Proxy Endpoint: Renegotiate Session
    // PUT /room/<roomId>/calls/sessions/<sessionId>/renegotiate
    const renegotiateMatch = path.match(/^\/room\/([^\/]+)\/calls\/sessions\/([^\/]+)\/renegotiate$/);
    if (renegotiateMatch && request.method === "PUT") {
      const sessionId = renegotiateMatch[2];
      return handleCallsRenegotiate(request, env, sessionId, corsHeaders);
    }

    // 2e. Standard WebSocket: /room/<roomId>
    const roomMatch = path.match(/^\/room\/([^\/]+)$/);
    if (roomMatch) {
      const roomId = roomMatch[1];
      const doId = env.SIGNALING_ROOM.idFromName(roomId);
      const doStub = env.SIGNALING_ROOM.get(doId);
      return doStub.fetch(request);
    }

    return new Response("Not Found", { status: 404, headers: corsHeaders });
  }
};

// Pengendali API: Cipta Sesi Panggilan Baru di Cloudflare
async function handleCallsSession(request, env, corsHeaders) {
  const appId = env.CALLS_APP_ID;
  const appToken = env.CALLS_APP_TOKEN;

  // Jika tiada kredential yang sah, kembalikan ralat mesra untuk demo tempatan
  if (!appId || appId === "YOUR_CALLS_APP_ID" || !appToken) {
    return new Response(JSON.stringify({
      error: "CREDENTIALS_MISSING",
      message: "Sila tetapkan CALLS_APP_ID di wrangler.toml dan CALLS_APP_TOKEN di dalam .dev.vars untuk memulakan panggilan Cloudflare Calls."
    }), { status: 400, headers: corsHeaders });
  }

  try {
    const requestBody = await request.json(); // contains { sessionDescription: { type: "offer", sdp: "..." } }
    
    const cfResponse = await fetch(`https://rtc.live.cloudflare.com/v1/apps/${appId}/sessions/new`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${appToken}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(requestBody)
    });

    const responseText = await cfResponse.text();
    return new Response(responseText, {
      status: cfResponse.status,
      headers: corsHeaders
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: "INTERNAL_ERROR", message: error.message }), {
      status: 500,
      headers: corsHeaders
    });
  }
}

// Pengendali API: Hantar/Langgan Track Media di Cloudflare
async function handleCallsTracks(request, env, sessionId, corsHeaders) {
  const appId = env.CALLS_APP_ID;
  const appToken = env.CALLS_APP_TOKEN;

  if (!appId || appId === "YOUR_CALLS_APP_ID" || !appToken) {
    return new Response(JSON.stringify({
      error: "CREDENTIALS_MISSING"
    }), { status: 400, headers: corsHeaders });
  }

  try {
    const requestBody = await request.json(); // contains { tracks: [...], sessionDescription: ... }

    const cfResponse = await fetch(`https://rtc.live.cloudflare.com/v1/apps/${appId}/sessions/${sessionId}/tracks/new`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${appToken}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(requestBody)
    });

    const responseText = await cfResponse.text();
    return new Response(responseText, {
      status: cfResponse.status,
      headers: corsHeaders
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: "INTERNAL_ERROR", message: error.message }), {
      status: 500,
      headers: corsHeaders
    });
  }
}

// Pengendali API: Renegotiate Sesi (untuk bertukar SDP Answer kembali ke Cloudflare)
async function handleCallsRenegotiate(request, env, sessionId, corsHeaders) {
  const appId = env.CALLS_APP_ID;
  const appToken = env.CALLS_APP_TOKEN;

  if (!appId || appId === "YOUR_CALLS_APP_ID" || !appToken) {
    return new Response(JSON.stringify({
      error: "CREDENTIALS_MISSING"
    }), { status: 400, headers: corsHeaders });
  }

  try {
    const requestBody = await request.json(); // contains { sessionDescription: { type: "answer", sdp: "..." } }

    const cfResponse = await fetch(`https://rtc.live.cloudflare.com/v1/apps/${appId}/sessions/${sessionId}/renegotiate`, {
      method: "PUT",
      headers: {
        "Authorization": `Bearer ${appToken}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(requestBody)
    });

    const responseText = await cfResponse.text();
    return new Response(responseText, {
      status: cfResponse.status,
      headers: corsHeaders
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: "INTERNAL_ERROR", message: error.message }), {
      status: 500,
      headers: corsHeaders
    });
  }
}
