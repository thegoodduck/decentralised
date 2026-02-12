// relay-server.js
// Simple WebSocket relay for cross-device/cross-browser P2P sync
// Install: npm install ws
// Run: node relay-server.js

import { WebSocketServer } from 'ws';
import http from 'http';
import fs from 'fs';
import crypto from 'crypto';
import { URL } from 'url';

const PORT = 8080;
const server = http.createServer();
const wss = new WebSocketServer({ server });

const clients = new Map(); // peerId -> WebSocket
const rooms = new Map();   // roomId -> Set of peerIds

// In-memory registry for backend-side vote protection
// key = `${pollId}:${deviceId}`
const voteRegistry = new Set();

// Simple append-only log for receipts and audit events
const RECEIPT_LOG_FILE = new URL('./storage.txt', import.meta.url).pathname;

const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || 'http://localhost:5173';


function generateRandomId(bytes = 16) {
  return crypto.randomBytes(bytes).toString('hex');
}


server.on('request', (req, res) => {
  // Basic CORS for the frontend dev server (supports credentials)
  const origin = req.headers.origin || FRONTEND_ORIGIN;
  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (!req.url) {
    res.writeHead(400);
    res.end('Bad request');
    return;
  }

  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (req.method === 'POST' && url.pathname === '/api/vote-authorize') {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk.toString();
    });
    req.on('end', () => {
      try {
        const data = JSON.parse(body || '{}');
        const pollId = String(data.pollId || '');
        const deviceId = String(data.deviceId || '');

        if (!pollId || !deviceId) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ allowed: false, reason: 'missing pollId or deviceId' }));
          return;
        }

        const key = `${pollId}:${deviceId}`;
        const alreadyVoted = voteRegistry.has(key);

        if (!alreadyVoted) {
          voteRegistry.add(key);
        }

        // Log the authorization attempt
        const logEntry = {
          type: 'vote-authorize',
          pollId,
          deviceId,
          allowed: !alreadyVoted,
          timestamp: Date.now(),
        };
        fs.appendFile(RECEIPT_LOG_FILE, JSON.stringify(logEntry) + '\n', () => {});

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ allowed: !alreadyVoted, reason: alreadyVoted ? 'already voted' : undefined }));
      } catch (error) {
        console.error('Error in /api/vote-authorize:', error);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ allowed: true }));
      }
    });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/receipts') {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk.toString();
    });
    req.on('end', () => {
      try {
        const data = JSON.parse(body || '{}');
        const logEntry = {
          type: 'receipt',
          payload: data,
          timestamp: Date.now(),
        };
        fs.appendFile(RECEIPT_LOG_FILE, JSON.stringify(logEntry) + '\n', (err) => {
          if (err) {
            console.error('Failed to write receipt log:', err);
          }
        });

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (error) {
        console.error('Error in /api/receipts:', error);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false }));
      }
    });
    return;
  }

  // Fallback 404 for unknown routes
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
});

wss.on('connection', (ws, req) => {
  let peerId = null;
  
  console.log('🔌 New connection from', req.socket.remoteAddress);

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message.toString());
      
      switch (data.type) {
        case 'register':
          peerId = data.peerId;
          clients.set(peerId, ws);
          console.log(`✅ Peer registered: ${peerId} (Total: ${clients.size})`);
          
          // Send list of active peers
          broadcast({
            type: 'peer-list',
            peers: Array.from(clients.keys())
          });
          break;
          
        case 'join-room':
          const roomId = data.roomId || 'default';
          if (!rooms.has(roomId)) {
            rooms.set(roomId, new Set());
          }
          rooms.get(roomId).add(peerId);
          console.log(`🚪 ${peerId} joined room: ${roomId}`);
          break;
          
        case 'broadcast':
          // Relay to all other peers
          console.log(`📡 Broadcasting ${data.data?.type || 'message'} from ${peerId}`);
          broadcastToOthers(peerId, data.data);
          break;
          
        case 'direct':
          // Send to specific peer
          const targetWs = clients.get(data.targetPeer);
          if (targetWs && targetWs.readyState === 1) { // 1 = OPEN
            targetWs.send(JSON.stringify(data.data));
          }
          break;
          
        // Handle direct P2P messages (not wrapped in 'broadcast')
        case 'new-poll':
        case 'new-block':
        case 'request-sync':
        case 'sync-response':
          console.log(`📡 Broadcasting ${data.type} from ${peerId}`);
          broadcastToOthers(peerId, data);
          break;
          
        default:
          console.log('Unknown message type:', data.type);
      }
    } catch (error) {
      console.error('Error handling message:', error);
    }
  });

  ws.on('close', () => {
    if (peerId) {
      clients.delete(peerId);
      
      // Remove from all rooms
      rooms.forEach((peers, roomId) => {
        peers.delete(peerId);
        if (peers.size === 0) {
          rooms.delete(roomId);
        }
      });
      
      console.log(`❌ Peer disconnected: ${peerId} (Total: ${clients.size})`);
      
      // Notify others
      broadcast({
        type: 'peer-left',
        peerId: peerId
      });
    }
  });

  ws.on('error', (error) => {
    console.error('WebSocket error:', error);
  });
  
  // Send welcome message
  ws.send(JSON.stringify({
    type: 'welcome',
    message: 'Connected to P2P relay',
    timestamp: Date.now()
  }));
});

function broadcast(message) {
  clients.forEach((ws) => {
    if (ws.readyState === 1) { // 1 = OPEN
      ws.send(JSON.stringify(message));
    }
  });
}

function broadcastToOthers(excludePeerId, message) {
  clients.forEach((ws, peerId) => {
    if (peerId !== excludePeerId && ws.readyState === 1) { // 1 = OPEN
      ws.send(JSON.stringify(message));
    }
  });
}

server.listen(PORT, () => {
  console.log('🚀 P2P Relay Server running on ws://localhost:' + PORT);
  console.log('📡 Waiting for connections...');
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n👋 Shutting down relay server...');
  wss.clients.forEach((ws) => {
    ws.close();
  });
  server.close(() => {
    console.log('✅ Server closed');
    process.exit(0);
  });
});