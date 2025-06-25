const fs = require('fs');
const https = require('https');
const express = require('express');
const socketIO = require('socket.io');
const mediasoup = require('mediasoup');
const cors = require('cors');

const app = express();
const server = https.createServer(
  {
    key: fs.readFileSync('server.key'),
    cert: fs.readFileSync('server.cert'),
  },
  app
);
const io = socketIO(server, {
  cors: {
    origin: true,
    methods: ['GET', 'POST'],
    credentials: true
  }
});
app.use(cors());

const PORT = 3000;
const rooms = new Map(); // roomId => { router, peers }

(async () => {
  const worker = await mediasoup.createWorker();

  io.on('connection', (socket) => {
    console.log(`🔌 Client connected: ${socket.id}`);

    socket.on('joinRoom', async ({ roomId, userId }, callback) => {
      console.log(`joinRoom called with roomId=${roomId}, userId=${userId}`);
      const blockedUsers = ['5'];
      if (blockedUsers.includes(userId)) {
        console.log(`User ${userId} is blocked`);
        return callback({ error: 'You are not allowed to join this room.' });
      }
      if (!rooms.has(roomId)) {
        console.log(`Creating new room: ${roomId}`);
        const router = await worker.createRouter({
          mediaCodecs: [
            {
              kind: 'audio',
              mimeType: 'audio/opus',
              clockRate: 48000,
              channels: 2
            }
          ]
        });
        rooms.set(roomId, { router, peers: new Map() });
        console.log(`🏠 Room created: ${roomId}`);
      } else {
        console.log(`Room already exists: ${roomId}`);
      }

      const room = rooms.get(roomId);
      room.peers.set(socket.id, { transports: [], producers: [], consumers: [] });

      socket.join(roomId);
      callback(room.router.rtpCapabilities);
    });

    socket.on('createTransport', async ({ roomId, direction }, callback) => {
      const room = rooms.get(roomId);
      if (!room) {
        console.warn(`❌ Room not found: ${roomId}`);
        return callback({ error: 'Room not found' });
      }
      const peer = room.peers.get(socket.id);
      if (!peer) {
        console.warn(`❌ Peer not found in room: ${roomId}, socket: ${socket.id}`);
        return callback({ error: 'Peer not found in room' });
      }
      const transport = await room.router.createWebRtcTransport({
        listenIps: [
          { ip: '0.0.0.0', announcedIp: 'group-chat-production-6656.up.railway.app' }
        ],
        enableUdp: true,
        enableTcp: true,
        preferUdp: true
      });

      transport.appData = { direction };

      transport.on('dtlsstatechange', (state) => {
        if (state === 'closed') transport.close();
      });

      peer.transports.push(transport);

      callback({
        id: transport.id,
        iceParameters: transport.iceParameters,
        iceCandidates: transport.iceCandidates,
        dtlsParameters: transport.dtlsParameters
      });
    });

    socket.on('connectTransport', async ({ transportId, dtlsParameters, roomId }) => {
      const peer = rooms.get(roomId)?.peers.get(socket.id);
      const transport = peer?.transports.find((t) => t.id === transportId);
      if (transport) await transport.connect({ dtlsParameters });
    });

    socket.on('produce', async ({ transportId, kind, rtpParameters, roomId }, callback) => {
      const peer = rooms.get(roomId)?.peers.get(socket.id);
      const transport = peer?.transports.find((t) => t.id === transportId);
      const producer = await transport.produce({ kind, rtpParameters });
      peer.producers.push(producer);
      callback({ id: producer.id });

      socket.broadcast.to(roomId).emit('newProducer', {
        producerId: producer.id,
        peerId: socket.id
      });
    });

    socket.on('consume', async ({ roomId, producerId, rtpCapabilities }, callback) => {
      const room = rooms.get(roomId);
      const router = room.router;
      const peer = room.peers.get(socket.id);

      if (!router.canConsume({ producerId, rtpCapabilities })) {
        console.warn('❌ Cannot consume');
        return callback({ error: 'Cannot consume' });
      }

      const transport = peer.transports.find(t => t.appData.direction === 'recv');
      if (!transport) {
        console.warn('❌ No recv transport found');
        return callback({ error: 'No recv transport available' });
      }

      const consumer = await transport.consume({
        producerId,
        rtpCapabilities,
        paused: false
      });
      await consumer.resume();
      peer.consumers.push(consumer);

      callback({
        id: consumer.id,
        producerId,
        kind: consumer.kind,
        rtpParameters: consumer.rtpParameters
      });
    });

    socket.on('disconnect', () => {
      console.log(`❌ Client disconnected: ${socket.id}`);
      for (const [roomId, room] of rooms.entries()) {
        if (room.peers.has(socket.id)) {
          const { transports, producers, consumers } = room.peers.get(socket.id);
          consumers.forEach((c) => c.close());
          producers.forEach((p) => p.close());
          transports.forEach((t) => t.close());
          room.peers.delete(socket.id);
          if (room.peers.size === 0) {
            rooms.delete(roomId);
            console.log(`🗑️ Room deleted: ${roomId}`);
          }
        }
      }
    });
  });

  server.listen(PORT, () => {
    console.log(`✅ Mediasoup server running at http://localhost:${PORT}`);
  });
})();
