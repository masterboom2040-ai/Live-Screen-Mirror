import express from 'express';
import http from 'http';
import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { createServer as createViteServer } from 'vite';

const PORT = 3000;
const STALE_MS = 45000;
const MAX_FILE_SIZE = (Number(process.env.FILE_MAX_MB) || 500) * 1024 * 1024;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const FILE_ID_RE = /^[A-Za-z0-9]{16}$/;

const PERSIST_FILE = path.join(process.cwd(), 'approvals.json');
const FILES_DIR = path.join(process.cwd(), 'shared_files');
const FILES_META_FILE = path.join(process.cwd(), 'files.json');

const TURN_HOST = process.env.TURN_HOST || '';
const TURN_SECRET = process.env.TURN_SECRET || '';
const TURN_TTL_SECONDS = 6 * 60 * 60;

function generateTurnCredentials(label?: string) {
  const expiry = Math.floor(Date.now() / 1000) + TURN_TTL_SECONDS;
  const username = `${expiry}:${label || 'user'}`;
  const credential = crypto.createHmac('sha1', TURN_SECRET).update(username).digest('base64');
  return { username, credential };
}

function getLocalIP() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name] || []) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return 'localhost';
}

const LOCAL_IP = process.env.DISPLAY_HOST || getLocalIP();

// Helper MIME mapping
const MIME_TYPES: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.zip': 'application/zip',
  '.txt': 'text/plain',
  '.csv': 'text/csv',
  '.json': 'application/json',
  '.apk': 'application/vnd.android.package-archive',
};

function mimeFor(ext: string) {
  return MIME_TYPES[ext.toLowerCase()] || 'application/octet-stream';
}

function sanitizeFileName(name: string) {
  if (typeof name !== 'string' || !name.trim()) return 'file';
  return name.replace(/[\/\\]/g, '_').replace(/[\x00-\x1f]/g, '').trim().slice(0, 180) || 'file';
}

interface Session {
  offer: any;
  answer: any;
  senderCandidates: any[];
  receiverCandidates: any[];
  epoch: number;
  lastSeen: number;
  ws: WebSocket | null;
}

interface Approval {
  approved: boolean;
  connected: boolean;
  name: string | null;
  ws: WebSocket | null;
  handRaised?: boolean;
  canDraw?: boolean;
}

interface SharedFileMeta {
  id: string;
  name: string;
  size: number;
  type: string;
  uploadedAt: number;
}

const sessions = new Map<string, Session>();
const approvals = new Map<string, Approval>();
const senders = new Set<WebSocket>();
const sharedFiles = new Map<string, SharedFileMeta>();
const pendingDeviceLeft = new Map<string, NodeJS.Timeout>();
const lastRenegotiateAt = new Map<string, number>();

// Load persistent data
function loadApprovals() {
  try {
    if (fs.existsSync(PERSIST_FILE)) {
      const data = JSON.parse(fs.readFileSync(PERSIST_FILE, 'utf8'));
      for (const [id, entry] of Object.entries<any>(data)) {
        if (!ID_RE.test(id)) continue;
        approvals.set(id, {
          approved: !!entry.approved,
          connected: false,
          name: typeof entry.name === 'string' ? entry.name.slice(0, 30) : null,
          ws: null,
          handRaised: false,
          canDraw: false,
        });
      }
    }
  } catch (e) {
    console.warn('Failed to load approvals:', e);
  }
}

function scheduleSaveApprovals() {
  setTimeout(() => {
    try {
      const out: Record<string, { approved: boolean; name: string | null }> = {};
      for (const [id, a] of approvals) {
        if (a.approved || a.name) out[id] = { approved: a.approved, name: a.name };
      }
      fs.writeFileSync(PERSIST_FILE, JSON.stringify(out, null, 2));
    } catch (e) {
      console.warn('Failed to save approvals:', e);
    }
  }, 300);
}

if (!fs.existsSync(FILES_DIR)) {
  fs.mkdirSync(FILES_DIR, { recursive: true });
}

function loadFilesMeta() {
  try {
    if (fs.existsSync(FILES_META_FILE)) {
      const data = JSON.parse(fs.readFileSync(FILES_META_FILE, 'utf8'));
      for (const entry of data) {
        if (!entry || !FILE_ID_RE.test(entry.id)) continue;
        if (fs.existsSync(path.join(FILES_DIR, entry.id))) {
          sharedFiles.set(entry.id, entry);
        }
      }
    }
  } catch (e) {
    console.warn('Failed to load files meta:', e);
  }
}

function scheduleFilesSave() {
  setTimeout(() => {
    try {
      fs.writeFileSync(FILES_META_FILE, JSON.stringify([...sharedFiles.values()], null, 2));
    } catch (e) {
      console.warn('Failed to save files meta:', e);
    }
  }, 300);
}

loadApprovals();
loadFilesMeta();

function getOrCreateSession(id: string): Session {
  let s = sessions.get(id);
  if (!s) {
    s = {
      offer: null,
      answer: null,
      senderCandidates: [],
      receiverCandidates: [],
      epoch: 0,
      lastSeen: Date.now(),
      ws: null,
    };
    sessions.set(id, s);
  }
  return s;
}

function getApproval(id: string): Approval {
  let a = approvals.get(id);
  if (!a) {
    a = { approved: false, connected: false, name: null, ws: null, handRaised: false, canDraw: false };
    approvals.set(id, a);
  }
  return a;
}

function wsSend(ws: WebSocket | null, type: string, payload: Record<string, any>) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type, ...payload }));
  }
}

function broadcastToSenders(type: string, payload: Record<string, any>) {
  for (const ws of senders) {
    wsSend(ws, type, payload);
  }
}

function broadcastFileEvent(type: string, payload: Record<string, any>) {
  broadcastToSenders(type, payload);
  for (const a of approvals.values()) {
    if (a.ws) wsSend(a.ws, type, payload);
  }
}

async function startServer() {
  const app = express();
  const server = http.createServer(app);

  app.use(express.json({ limit: '10mb' }));

  // API Routes
  app.get('/api/config', (req, res) => {
    const hostHeader = req.headers.host || `localhost:${PORT}`;
    const protocol = req.headers['x-forwarded-proto'] || 'http';
    const baseUrl = `${protocol}://${hostHeader}`;
    res.json({
      localIP: LOCAL_IP,
      port: PORT,
      tvUrl: `${baseUrl}/tv`,
      senderUrl: `${baseUrl}/`,
    });
  });

  app.get('/api/stats', (req, res) => {
    res.json({
      sessions: sessions.size,
      approved: [...approvals.values()].filter((a) => a.approved).length,
      connected: [...approvals.values()].filter((a) => a.connected).length,
      senders: senders.size,
      uptime: process.uptime(),
      localIP: LOCAL_IP,
    });
  });

  app.get('/api/turn-credentials', (req, res) => {
    if (!TURN_HOST || !TURN_SECRET) {
      return res.json({ enabled: false, iceServers: [] });
    }
    const { username, credential } = generateTurnCredentials('viewer');
    res.json({
      enabled: true,
      iceServers: [{ urls: [`turn:${TURN_HOST}?transport=tcp`], username, credential }],
    });
  });

  // File Upload Endpoint
  app.post('/api/files/upload', (req, res) => {
    const rawName = (req.headers['x-file-name'] as string) || 'file';
    let fileName = rawName;
    try {
      fileName = decodeURIComponent(rawName);
    } catch (e) {}
    fileName = sanitizeFileName(fileName);

    const id = crypto.randomBytes(8).toString('hex');
    const diskPath = path.join(FILES_DIR, id);
    const writeStream = fs.createWriteStream(diskPath);
    let bytesWritten = 0;
    let failed = false;

    req.on('data', (chunk) => {
      if (failed) return;
      bytesWritten += chunk.length;
      if (bytesWritten > MAX_FILE_SIZE) {
        failed = true;
        writeStream.destroy();
        fs.unlink(diskPath, () => {});
        res.status(413).json({ error: 'File exceeds maximum limit' });
      }
    });

    req.on('error', () => {
      failed = true;
      writeStream.destroy();
      fs.unlink(diskPath, () => {});
    });

    writeStream.on('finish', () => {
      if (failed) return;
      const ext = path.extname(fileName);
      const meta: SharedFileMeta = {
        id,
        name: fileName,
        size: bytesWritten,
        type: mimeFor(ext),
        uploadedAt: Date.now(),
      };
      sharedFiles.set(id, meta);
      scheduleFilesSave();
      res.json({ ok: true, file: meta });
      broadcastFileEvent('file-shared', meta);
    });

    req.pipe(writeStream);
  });

  app.get('/api/files', (req, res) => {
    const files = [...sharedFiles.values()].sort((a, b) => b.uploadedAt - a.uploadedAt);
    res.json({ files });
  });

  app.get('/api/files/:id', (req, res) => {
    const { id } = req.params;
    if (!FILE_ID_RE.test(id)) return res.status(400).send('Invalid file id');
    const meta = sharedFiles.get(id);
    if (!meta) return res.status(404).send('File not found');
    const diskPath = path.join(FILES_DIR, id);
    if (!fs.existsSync(diskPath)) return res.status(404).send('File content missing');

    const safeAscii = meta.name.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '');
    res.setHeader('Content-Type', meta.type);
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${safeAscii}"; filename*=UTF-8''${encodeURIComponent(meta.name)}`
    );
    fs.createReadStream(diskPath).pipe(res);
  });

  app.delete('/api/files/:id', (req, res) => {
    const { id } = req.params;
    if (!FILE_ID_RE.test(id)) return res.status(400).json({ error: 'Invalid file id' });
    const meta = sharedFiles.get(id);
    if (!meta) return res.status(404).json({ error: 'File not found' });

    sharedFiles.delete(id);
    scheduleFilesSave();
    fs.unlink(path.join(FILES_DIR, id), () => {});
    res.json({ ok: true });
    broadcastFileEvent('file-removed', { id });
  });

  // Attach WebSocket server
  const wss = new WebSocketServer({ server });

  wss.on('connection', (ws) => {
    let role: 'receiver' | 'sender' | null = null;
    let receiverId: string | null = null;

    ws.on('message', (raw) => {
      let msg: any;
      try {
        msg = JSON.parse(raw.toString());
      } catch (e) {
        return;
      }

      if (!msg || typeof msg.type !== 'string') return;
      if (msg.id !== undefined && typeof msg.id === 'string' && !ID_RE.test(msg.id)) return;

      if (msg.type === 'register') {
        role = 'receiver';
        receiverId = msg.id;
        const s = getOrCreateSession(receiverId);
        s.lastSeen = Date.now();
        s.ws = ws;
        const a = getApproval(receiverId);
        a.ws = ws;

        if (msg.name && typeof msg.name === 'string' && !a.name) {
          a.name = msg.name.slice(0, 30);
        }

        if (msg.fresh) {
          s.offer = null;
          s.answer = null;
          s.senderCandidates = [];
          s.receiverCandidates = [];
          s.epoch += 1;
          a.connected = false;
        }

        wsSend(ws, 'registered', { epoch: s.epoch, approved: a.approved });
        if (a.canDraw) wsSend(ws, 'draw-approved', {});

        const pending = pendingDeviceLeft.get(receiverId);
        if (pending) {
          clearTimeout(pending);
          pendingDeviceLeft.delete(receiverId);
        }

        broadcastToSenders(msg.fresh ? 'device-joined' : 'device-updated', {
          id: receiverId,
          name: a.name || receiverId.slice(-8),
          approved: a.approved,
          connected: a.connected,
          handRaised: !!a.handRaised,
          canDraw: !!a.canDraw,
          forceRenegotiate: !!msg.fresh,
        });

        scheduleSaveApprovals();
        return;
      }

      if (msg.type === 'sender-register') {
        role = 'sender';
        senders.add(ws);
        const devices = [...sessions.keys()].map((id) => {
          const a = getApproval(id);
          return {
            id,
            name: a.name || id.slice(-8),
            approved: a.approved,
            connected: a.connected,
            handRaised: !!a.handRaised,
            canDraw: !!a.canDraw,
          };
        });
        wsSend(ws, 'device-list', { devices });
        return;
      }

      if (msg.type === 'rename') {
        if (typeof msg.name !== 'string') return;
        const a = getApproval(msg.id);
        a.name = msg.name.trim().slice(0, 30) || null;
        if (a.ws) wsSend(a.ws, 'renamed', { name: a.name });
        broadcastToSenders('device-updated', { id: msg.id, name: a.name });
        scheduleSaveApprovals();
        return;
      }

      if (msg.type === 'approve') {
        const a = getApproval(msg.id);
        a.approved = !!msg.approved;
        if (!a.approved) {
          a.connected = false;
          const s = sessions.get(msg.id);
          if (s) {
            s.offer = null;
            s.answer = null;
            s.senderCandidates = [];
            s.receiverCandidates = [];
            s.epoch += 1;
          }
          if (a.ws) wsSend(a.ws, 'revoked', {});
        } else {
          if (a.ws) wsSend(a.ws, 'approved', {});
        }
        broadcastToSenders('device-updated', { id: msg.id, approved: a.approved, connected: a.connected });
        scheduleSaveApprovals();
        return;
      }

      if (msg.type === 'kick') {
        const a = getApproval(msg.id);
        if (a) a.connected = false;
        const s = sessions.get(msg.id);
        if (s) {
          s.offer = null;
          s.answer = null;
          s.senderCandidates = [];
          s.receiverCandidates = [];
          s.epoch += 1;
          if (s.ws) wsSend(s.ws, 'kicked', {});
        }
        broadcastToSenders('device-updated', { id: msg.id, connected: false });
        return;
      }

      if (msg.type === 'offer') {
        const s = getOrCreateSession(msg.id);
        s.offer = msg.offer;
        s.answer = null;
        s.senderCandidates = [];
        s.receiverCandidates = [];
        s.epoch += 1;
        s.lastSeen = Date.now();
        const a = getApproval(msg.id);
        a.connected = false;

        if (a.ws && a.approved) {
          wsSend(a.ws, 'offer', { offer: msg.offer, epoch: s.epoch });
        }
        wsSend(ws, 'offer-ack', { id: msg.id, epoch: s.epoch });
        broadcastToSenders('device-updated', { id: msg.id, connected: false });
        return;
      }

      if (msg.type === 'answer') {
        const s = getOrCreateSession(msg.id);
        s.answer = msg.answer;
        s.lastSeen = Date.now();
        broadcastToSenders('answer', { id: msg.id, answer: msg.answer });
        return;
      }

      if (msg.type === 'candidate') {
        const s = getOrCreateSession(msg.id);
        if (typeof msg.epoch === 'number' && msg.epoch !== s.epoch) return;
        const list = msg.from === 'sender' ? s.senderCandidates : s.receiverCandidates;
        if (list.length < 500) list.push(msg.candidate);
        s.lastSeen = Date.now();

        if (msg.from === 'sender') {
          const a = approvals.get(msg.id);
          if (a && a.ws) wsSend(a.ws, 'candidate', { candidate: msg.candidate, epoch: msg.epoch });
        } else {
          broadcastToSenders('candidate', { id: msg.id, candidate: msg.candidate, epoch: msg.epoch });
        }
        return;
      }

      if (msg.type === 'renegotiate') {
        const id = receiverId || msg.id;
        if (!id) return;
        const now = Date.now();
        const last = lastRenegotiateAt.get(id) || 0;
        if (now - last < 4000) return;
        lastRenegotiateAt.set(id, now);

        const s = getOrCreateSession(id);
        s.offer = null;
        s.answer = null;
        s.senderCandidates = [];
        s.receiverCandidates = [];
        s.epoch += 1;
        const a = getApproval(id);
        a.connected = false;

        broadcastToSenders('device-joined', {
          id,
          name: a.name || id.slice(-8),
          approved: a.approved,
          connected: a.connected,
          handRaised: !!a.handRaised,
          canDraw: !!a.canDraw,
          forceRenegotiate: true,
        });
        return;
      }

      if (msg.type === 'connected') {
        const a = getApproval(msg.id);
        if (a) {
          a.connected = !!msg.connected;
          broadcastToSenders('device-updated', { id: msg.id, connected: a.connected });
        }
        return;
      }

      if (msg.type === 'raise-hand') {
        const a = getApproval(msg.id);
        a.handRaised = !!msg.raised;
        if (!a.handRaised) {
          a.canDraw = false;
          if (a.ws) wsSend(a.ws, 'draw-revoked', {});
        }
        broadcastToSenders('hand-updated', {
          id: msg.id,
          name: a.name || msg.id.slice(-8),
          raised: a.handRaised,
        });
        return;
      }

      if (msg.type === 'draw-approve') {
        const a = getApproval(msg.id);
        a.canDraw = !!msg.approved;
        if (a.ws) wsSend(a.ws, a.canDraw ? 'draw-approved' : 'draw-revoked', {});
        broadcastToSenders('device-updated', { id: msg.id, canDraw: a.canDraw });
        return;
      }

      if (msg.type === 'draw-stroke' || msg.type === 'presenter-draw-stroke') {
        const isPresenterSender = role === 'sender' || msg.isPresenter;
        if (isPresenterSender) {
          const strokePayload = {
            isPresenter: true,
            id: 'presenter',
            name: 'Presenter',
            points: Array.isArray(msg.points) ? msg.points.slice(0, 300) : [],
            color: typeof msg.color === 'string' ? msg.color.slice(0, 30) : '#ef4444',
            lineWidth: typeof msg.lineWidth === 'number' ? Math.min(Math.max(msg.lineWidth, 1), 60) : 3,
            tool: typeof msg.tool === 'string' ? msg.tool : 'pen',
            opacity: typeof msg.opacity === 'number' ? msg.opacity : 1,
            phase: msg.phase === 'start' || msg.phase === 'end' ? msg.phase : 'draw',
          };
          for (const a of approvals.values()) {
            if (a.ws) wsSend(a.ws, 'draw-stroke', strokePayload);
          }
          broadcastToSenders('draw-stroke', strokePayload);
          return;
        }

        const a = approvals.get(msg.id);
        if (!a || !a.canDraw) return;
        broadcastToSenders('draw-stroke', {
          id: msg.id,
          name: a.name || msg.id.slice(-8),
          points: Array.isArray(msg.points) ? msg.points.slice(0, 300) : [],
          color: typeof msg.color === 'string' ? msg.color.slice(0, 30) : '#ef4444',
          lineWidth: typeof msg.lineWidth === 'number' ? Math.min(Math.max(msg.lineWidth, 1), 60) : 3,
          tool: typeof msg.tool === 'string' ? msg.tool : 'pen',
          opacity: typeof msg.opacity === 'number' ? msg.opacity : 1,
          phase: msg.phase === 'start' || msg.phase === 'end' ? msg.phase : 'draw',
        });
        return;
      }

      if (msg.type === 'draw-clear' || msg.type === 'presenter-draw-clear') {
        const isPresenterSender = role === 'sender' || msg.isPresenter;
        if (isPresenterSender) {
          for (const a of approvals.values()) {
            if (a.ws) wsSend(a.ws, 'draw-clear', { isPresenter: true });
          }
          broadcastToSenders('draw-clear', { isPresenter: true });
          return;
        }

        const a = approvals.get(msg.id);
        if (!a || !a.canDraw) return;
        broadcastToSenders('draw-clear', { id: msg.id });
        return;
      }

      if (msg.type === 'chat-message') {
        if (typeof msg.text !== 'string' || !msg.text.trim()) return;
        const a = getApproval(msg.id);
        broadcastToSenders('chat-message', {
          id: msg.id,
          name: a.name || msg.id.slice(-8),
          text: msg.text.trim().slice(0, 500),
          t: Date.now(),
        });
        return;
      }

      if (msg.type === 'chat-reply') {
        if (typeof msg.text !== 'string' || !msg.text.trim()) return;
        const a = getApproval(msg.id);
        if (a.ws) wsSend(a.ws, 'chat-reply', { text: msg.text.trim().slice(0, 500), t: Date.now() });
        return;
      }

      if (msg.type === 'ping') {
        wsSend(ws, 'pong', { t: msg.t });
        if (receiverId) {
          const s = sessions.get(receiverId);
          if (s) s.lastSeen = Date.now();
        }
        return;
      }
    });

    ws.on('close', () => {
      if (role === 'sender') senders.delete(ws);
      if (role === 'receiver' && receiverId) {
        const s = sessions.get(receiverId);
        if (s) s.ws = null;
        const a = approvals.get(receiverId);
        if (a) {
          a.ws = null;
          if (a.handRaised || a.canDraw) {
            a.handRaised = false;
            a.canDraw = false;
            broadcastToSenders('hand-updated', { id: receiverId, raised: false });
          }
        }
        const id = receiverId;
        clearTimeout(pendingDeviceLeft.get(id));
        const t = setTimeout(() => {
          pendingDeviceLeft.delete(id);
          broadcastToSenders('device-left', { id });
        }, 6000);
        pendingDeviceLeft.set(id, t);
      }
    });
  });

  // Stale session cleanup
  setInterval(() => {
    const now = Date.now();
    for (const [id, s] of sessions) {
      if (now - s.lastSeen > STALE_MS) {
        sessions.delete(id);
        const pending = pendingDeviceLeft.get(id);
        if (pending) {
          clearTimeout(pending);
          pendingDeviceLeft.delete(id);
        }
        if (s.ws) {
          try {
            s.ws.close();
          } catch (e) {}
        }
        broadcastToSenders('device-left', { id });
      }
    }
  }, 5000);

  // Mount Vite or Static middleware
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`Live Screen Mirror server running on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start server:', err);
});
