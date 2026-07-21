// Cloudflare Worker & Durable Object Signaling Server

// 1. Durable Object Class to manage room-level connections
export class SignalingRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request) {
    const url = new URL(request.url);
    const peerId = url.searchParams.get("peerId");
    
    if (!peerId) {
      return new Response("Ralat: Parameter 'peerId' diperlukan.", { status: 400 });
    }

    // Periksa jika permintaan adalah WebSocket Upgrade
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Ralat: Dapatkan sambungan WebSocket sahaja.", { status: 426 });
    }

    // Cipta WebSocket Pair
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    // Terima WebSocket menggunakan Hibernation API
    this.state.acceptWebSocket(server);
    
    // Simpan peerId ke dalam attachment WebSocket
    server.serializeAttachment({ peerId });

    // Dapatkan senarai peer yang sedia ada di dalam bilik untuk memberitahu peer yang baru masuk
    const existingPeers = [];
    this.state.getWebSockets().forEach(ws => {
      const attachment = ws.deserializeAttachment();
      if (attachment && attachment.peerId !== peerId) {
        existingPeers.push(attachment.peerId);
      }
    });

    // Beritahu pengguna baru tentang senarai peer sedia ada
    server.send(JSON.stringify({
      type: "room-joined",
      peerId: peerId,
      peers: existingPeers
    }));

    // Beritahu peer lain bahawa ada peer baru masuk
    this.broadcast({
      type: "peer-joined",
      peerId: peerId
    }, server);

    return new Response(null, {
      status: 101,
      webSocket: client
    });
  }

  // Dipanggil apabila mesej diterima dari WebSocket
  async webSocketMessage(ws, message) {
    try {
      const data = JSON.parse(message);
      const senderAttachment = ws.deserializeAttachment();
      const senderPeerId = senderAttachment ? senderAttachment.peerId : "Unknown";

      // Tambah ID pengirim ke dalam mesej
      data.sender = senderPeerId;

      if (data.target) {
        // Hantar isyarat secara spesifik (Offer, Answer, ICE Candidate) kepada target peer
        const targetSockets = this.state.getWebSockets().filter(client => {
          const attach = client.deserializeAttachment();
          return attach && attach.peerId === data.target;
        });

        targetSockets.forEach(target => {
          if (target.readyState === 1) { // 1 = WebSocket.OPEN
            target.send(JSON.stringify(data));
          }
        });
      } else {
        // Hantar mesej ke seluruh bilik (contohnya Broadcast Chat)
        this.broadcast(data, ws);
      }
    } catch (error) {
      console.error("Ralat memproses mesej WebSocket:", error);
    }
  }

  // Dipanggil apabila WebSocket ditutup
  async webSocketClose(ws, code, reason, wasClean) {
    const attachment = ws.deserializeAttachment();
    if (attachment) {
      this.broadcast({
        type: "peer-left",
        peerId: attachment.peerId
      }, ws);
    }
    ws.close(code, "Sambungan ditutup");
  }

  // Dipanggil jika ralat WebSocket berlaku
  async webSocketError(ws, error) {
    const attachment = ws.deserializeAttachment();
    if (attachment) {
      this.broadcast({
        type: "peer-left",
        peerId: attachment.peerId
      }, ws);
    }
    ws.close(1011, "Ralat WebSocket berlaku");
  }

  // Fungsi utiliti untuk hantar mesej ke semua WebSocket dalam bilik
  broadcast(messageObj, excludeWs) {
    const messageString = JSON.stringify(messageObj);
    this.state.getWebSockets().forEach(client => {
      if (client !== excludeWs && client.readyState === 1) { // 1 = WebSocket.OPEN
        client.send(messageString);
      }
    });
  }
}

// 2. Main Entry Point (Router)
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    // Route format: /room/<roomId>
    const roomMatch = path.match(/^\/room\/([^\/]+)/);
    if (!roomMatch) {
      return new Response("WebRTC Signaling Server sedang berjalan! Sambung ke /room/<roomId> menggunakan WebSocket.", {
        status: 200,
        headers: { "Content-Type": "text/plain; charset=utf-8" }
      });
    }

    const roomId = roomMatch[1];

    // Cipta ID Durable Object berdasarkan nama bilik (roomId)
    const doId = env.SIGNALING_ROOM.idFromName(roomId);
    const doStub = env.SIGNALING_ROOM.get(doId);

    // Hantar permintaan terus kepada Durable Object
    return doStub.fetch(request);
  }
};
