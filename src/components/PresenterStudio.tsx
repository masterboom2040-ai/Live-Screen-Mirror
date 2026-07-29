import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  Play,
  Square,
  Lock,
  Unlock,
  Radio,
  Tv,
  Users,
  Hand,
  Pencil,
  Highlighter,
  Eraser,
  Undo,
  RotateCcw,
  Camera,
  MousePointer,
  Palette,
  MessageSquare,
  UploadCloud,
  File,
  Trash2,
  Download,
  Share2,
  CheckCircle2,
  XCircle,
  Clock,
  Sparkles,
  Circle,
  X,
  Send,
  AlertTriangle,
  Video,
  Pause,
  ExternalLink,
} from 'lucide-react';
import { Device, SharedFile, ChatMessage, DoodleStroke, Point } from '../types';
import {
  fetchIceServers,
  applyBitrateCap,
  getLetterboxMetrics,
  normalizedToPixel,
  pixelToNormalized,
  formatBytes,
} from '../lib/webrtc';

interface PresenterStudioProps {
  onOpenShareModal: () => void;
  onStreamStateChange?: (isStreaming: boolean, viewerCount: number) => void;
}

interface PeerInfo {
  pc: RTCPeerConnection;
  epoch: number;
  epochConfirmed: boolean;
  connected: boolean;
}

export const PresenterStudio: React.FC<PresenterStudioProps> = ({
  onOpenShareModal,
  onStreamStateChange,
}) => {
  // Streaming state
  const [isSharing, setIsSharing] = useState(false);
  const [statusText, setStatusText] = useState('Ready to share screen');
  const [statusType, setStatusType] = useState<'info' | 'success' | 'warn' | 'error'>('info');
  const [showPermissionHelp, setShowPermissionHelp] = useState(false);
  const [uptime, setUptime] = useState('00:00');
  const [fpsResText, setFpsResText] = useState('— fps / —');

  // Screen recording state
  const [recState, setRecState] = useState<'idle' | 'recording' | 'paused'>('idle');
  const [recSeconds, setRecSeconds] = useState(0);

  // Classroom data
  const [devices, setDevices] = useState<Device[]>([]);
  const [raisedHands, setRaisedHands] = useState<{ id: string; name: string; canDraw: boolean }[]>([]);
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [chatReplyTo, setChatReplyTo] = useState<{ id: string; name: string } | null>(null);
  const [chatInput, setChatInput] = useState('');
  const [unreadChatCount, setUnreadChatCount] = useState(0);

  // Shared Files
  const [sharedFiles, setSharedFiles] = useState<SharedFile[]>([]);
  const [uploadProgress, setUploadProgress] = useState<{ name: string; progress: number } | null>(null);

  // Doodle Overlay State
  const [isDoodleMode, setIsDoodleMode] = useState(true);
  const [doodleTool, setDoodleTool] = useState<'pen' | 'highlighter' | 'eraser'>('pen');
  const [doodleColor, setDoodleColor] = useState('#ef4444');
  const [doodleSize, setDoodleSize] = useState(4);
  const [historyStack, setHistoryStack] = useState<ImageData[]>([]);

  const isDrawingRef = useRef(false);
  const currentStrokeRef = useRef<Point[]>([]);

  const COLOR_PRESETS = [
    { name: 'Red', hex: '#ef4444' },
    { name: 'Yellow', hex: '#f59e0b' },
    { name: 'Green', hex: '#10b981' },
    { name: 'Blue', hex: '#3b82f6' },
    { name: 'Purple', hex: '#8b5cf6' },
    { name: 'Pink', hex: '#ec4899' },
    { name: 'White', hex: '#ffffff' },
    { name: 'Black', hex: '#000000' },
  ];

  const SIZE_PRESETS = [
    { label: 'Fine', value: 2 },
    { label: 'Medium', value: 5 },
    { label: 'Thick', value: 10 },
    { label: 'Marker', value: 20 },
  ];

  // References
  const previewRef = useRef<HTMLVideoElement | null>(null);
  const drawOverlayCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const peersRef = useRef<Map<string, PeerInfo>>(new Map());

  const shareStartTimeRef = useRef<number | null>(null);
  const uptimeTimerRef = useRef<NodeJS.Timeout | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const recChunksRef = useRef<Blob[]>([]);
  const recTimerRef = useRef<NodeJS.Timeout | null>(null);

  const [drawLabel, setDrawLabel] = useState<string | null>(null);
  const drawLabelTimerRef = useRef<NodeJS.Timeout | null>(null);

  const sendWs = useCallback((type: string, payload: Record<string, any> = {}) => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type, ...payload }));
    }
  }, []);

  // Sync shared files list from backend
  const loadSharedFiles = useCallback(async () => {
    try {
      const res = await fetch('/api/files');
      const data = await res.json();
      if (data && Array.isArray(data.files)) {
        setSharedFiles(data.files);
      }
    } catch (e) {
      console.warn('Failed to load shared files', e);
    }
  }, []);

  // Resize Draw Overlay Canvas to Match Rendered Video
  const resizeDrawOverlay = useCallback(() => {
    if (!drawOverlayCanvasRef.current || !previewRef.current) return;
    const canvas = drawOverlayCanvasRef.current;
    const video = previewRef.current;
    const rect = video.getBoundingClientRect();
    canvas.width = rect.width;
    canvas.height = rect.height;
  }, []);

  useEffect(() => {
    window.addEventListener('resize', resizeDrawOverlay);
    return () => window.removeEventListener('resize', resizeDrawOverlay);
  }, [resizeDrawOverlay]);

  // Peer Cleanup
  const cleanupPeer = useCallback((id: string) => {
    const peer = peersRef.current.get(id);
    if (peer) {
      try {
        peer.pc.close();
      } catch (e) {}
      peersRef.current.delete(id);
    }
  }, []);

  // Connect to receiver with WebRTC Offer
  const connectToReceiver = useCallback(
    async (id: string) => {
      const stream = streamRef.current;
      if (!stream || !stream.active) return;

      const existing = peersRef.current.get(id);
      if (existing) {
        if (
          existing.pc.connectionState === 'failed' ||
          existing.pc.connectionState === 'closed'
        ) {
          cleanupPeer(id);
        } else {
          return;
        }
      }

      const iceServers = await fetchIceServers();
      const pc = new RTCPeerConnection({
        iceServers,
        iceTransportPolicy: 'all',
        bundlePolicy: 'max-bundle',
      });

      stream.getTracks().forEach((track) => pc.addTrack(track, stream));

      const peerInfo: PeerInfo = {
        pc,
        epoch: 0,
        epochConfirmed: false,
        connected: false,
      };
      peersRef.current.set(id, peerInfo);

      pc.onicecandidate = (e) => {
        if (e.candidate) {
          sendWs('candidate', {
            id,
            from: 'sender',
            candidate: e.candidate,
            epoch: peerInfo.epoch,
          });
        }
      };

      pc.onconnectionstatechange = () => {
        const state = pc.connectionState;
        peerInfo.connected = state === 'connected';

        setDevices((prev) =>
          prev.map((d) => (d.id === id ? { ...d, connected: peerInfo.connected } : d))
        );

        const connectedCount = [...peersRef.current.values()].filter((p) => p.connected).length;
        if (onStreamStateChange) {
          onStreamStateChange(true, connectedCount);
        }

        if (state === 'connected') {
          sendWs('connected', { id, connected: true });
          applyBitrateCap(pc, peersRef.current.size);
        } else if (state === 'failed' || state === 'closed') {
          cleanupPeer(id);
        }
      };

      try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        sendWs('offer', { id, offer });
      } catch (err) {
        console.error('Failed to connect peer:', err);
        cleanupPeer(id);
      }
    },
    [cleanupPeer, onStreamStateChange, sendWs]
  );

  // WebSocket Server Connection
  useEffect(() => {
    loadSharedFiles();

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/`;
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      ws.send(JSON.stringify({ type: 'sender-register' }));
    };

    ws.onmessage = (e) => {
      let msg: any;
      try {
        msg = JSON.parse(e.data);
      } catch (err) {
        return;
      }

      if (msg.type === 'device-list') {
        setDevices(msg.devices || []);
        const hands = (msg.devices || [])
          .filter((d: any) => d.handRaised)
          .map((d: any) => ({ id: d.id, name: d.name, canDraw: !!d.canDraw }));
        setRaisedHands(hands);

        if (streamRef.current && streamRef.current.active) {
          (msg.devices || []).forEach((d: any) => {
            if (d.approved) connectToReceiver(d.id);
          });
        }
      }

      if (msg.type === 'device-joined') {
        setDevices((prev) => [...prev.filter((d) => d.id !== msg.id), msg]);
        if (msg.handRaised) {
          setRaisedHands((prev) => [
            ...prev.filter((h) => h.id !== msg.id),
            { id: msg.id, name: msg.name, canDraw: !!msg.canDraw },
          ]);
        }
        if (msg.forceRenegotiate) {
          cleanupPeer(msg.id);
        }
        if (streamRef.current && streamRef.current.active && msg.approved) {
          connectToReceiver(msg.id);
        }
      }

      if (msg.type === 'device-left') {
        setDevices((prev) => prev.filter((d) => d.id !== msg.id));
        setRaisedHands((prev) => prev.filter((h) => h.id !== msg.id));
        cleanupPeer(msg.id);
      }

      if (msg.type === 'device-updated') {
        setDevices((prev) =>
          prev.map((d) => (d.id === msg.id ? { ...d, ...msg } : d))
        );
        setRaisedHands((prev) =>
          prev.map((h) => (h.id === msg.id ? { ...h, canDraw: msg.canDraw ?? h.canDraw } : h))
        );
      }

      if (msg.type === 'offer-ack') {
        const peer = peersRef.current.get(msg.id);
        if (peer) {
          peer.epoch = msg.epoch;
          peer.epochConfirmed = true;
        }
      }

      if (msg.type === 'answer') {
        const peer = peersRef.current.get(msg.id);
        if (peer && peer.pc.signalingState === 'have-local-offer') {
          peer.pc.setRemoteDescription(new RTCSessionDescription(msg.answer)).catch(() => {});
        }
      }

      if (msg.type === 'candidate') {
        const peer = peersRef.current.get(msg.id);
        if (peer && peer.pc.remoteDescription) {
          peer.pc.addIceCandidate(msg.candidate).catch(() => {});
        }
      }

      if (msg.type === 'hand-updated') {
        if (msg.raised) {
          setRaisedHands((prev) => [
            ...prev.filter((h) => h.id !== msg.id),
            { id: msg.id, name: msg.name, canDraw: false },
          ]);
        } else {
          setRaisedHands((prev) => prev.filter((h) => h.id !== msg.id));
        }
      }

      if (msg.type === 'draw-stroke') {
        renderIncomingStroke(msg);
      }

      if (msg.type === 'draw-clear') {
        if (drawOverlayCanvasRef.current) {
          const ctx = drawOverlayCanvasRef.current.getContext('2d');
          if (ctx) ctx.clearRect(0, 0, drawOverlayCanvasRef.current.width, drawOverlayCanvasRef.current.height);
        }
      }

      if (msg.type === 'chat-message') {
        setChatMessages((prev) => [...prev, msg]);
        setUnreadChatCount((prev) => prev + 1);
        if (!chatReplyTo) {
          setChatReplyTo({ id: msg.id, name: msg.name });
        }
      }

      if (msg.type === 'file-shared') {
        setSharedFiles((prev) => [msg, ...prev.filter((f) => f.id !== msg.id)]);
      }

      if (msg.type === 'file-removed') {
        setSharedFiles((prev) => prev.filter((f) => f.id !== msg.id));
      }
    };

    return () => {
      ws.close();
    };
  }, [cleanupPeer, connectToReceiver, loadSharedFiles]);

  // Render Student / Incoming Doodle Stroke onto Video Overlay
  const renderIncomingStroke = useCallback((msg: DoodleStroke & { name?: string; tool?: string; opacity?: number }) => {
    const canvas = drawOverlayCanvasRef.current;
    const video = previewRef.current;
    if (!canvas || !video) return;

    if (canvas.width === 0) resizeDrawOverlay();
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    if (msg.name && msg.name !== 'Presenter') {
      setDrawLabel(`✏️ ${msg.name} is drawing`);
      if (drawLabelTimerRef.current) clearTimeout(drawLabelTimerRef.current);
      drawLabelTimerRef.current = setTimeout(() => setDrawLabel(null), 2500);
    }

    const rect = canvas.getBoundingClientRect();
    const metrics = getLetterboxMetrics(
      rect.width,
      rect.height,
      video.videoWidth || rect.width,
      video.videoHeight || rect.height
    );

    const pts = msg.points || [];
    if (!pts.length) return;

    ctx.save();
    if (msg.tool === 'eraser') {
      ctx.globalCompositeOperation = 'destination-out';
      ctx.lineWidth = (msg.lineWidth || 3) * 2.5;
    } else {
      ctx.globalCompositeOperation = 'source-over';
      ctx.strokeStyle = msg.color || '#ef4444';
      ctx.lineWidth = msg.lineWidth || 3;
      if (msg.tool === 'highlighter') {
        ctx.globalAlpha = msg.opacity || 0.35;
      } else {
        ctx.globalAlpha = 1;
      }
    }
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    ctx.beginPath();
    const p0 = normalizedToPixel(pts[0].x, pts[0].y, metrics);
    ctx.moveTo(p0.x, p0.y);

    for (let i = 1; i < pts.length; i++) {
      const p = normalizedToPixel(pts[i].x, pts[i].y, metrics);
      ctx.lineTo(p.x, p.y);
    }
    ctx.stroke();
    ctx.restore();
  }, [resizeDrawOverlay]);

  // Save Canvas State for Undo
  const saveHistoryState = useCallback(() => {
    const canvas = drawOverlayCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    try {
      const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      setHistoryStack((prev) => [...prev.slice(-15), imgData]);
    } catch (e) {}
  }, []);

  // Undo Last Doodle Action
  const undoLastStroke = useCallback(() => {
    const canvas = drawOverlayCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    if (historyStack.length === 0) {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      sendWs('presenter-draw-clear', {});
      return;
    }

    const previousState = historyStack[historyStack.length - 1];
    setHistoryStack((prev) => prev.slice(0, -1));
    ctx.putImageData(previousState, 0, 0);
  }, [historyStack, sendWs]);

  // Clear All Doodles
  const clearAllDoodles = useCallback(() => {
    saveHistoryState();
    const canvas = drawOverlayCanvasRef.current;
    if (canvas) {
      const ctx = canvas.getContext('2d');
      if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
    }
    sendWs('presenter-draw-clear', {});
  }, [saveHistoryState, sendWs]);

  // Capture Annotated Frame as PNG
  const captureAnnotatedFrame = useCallback(() => {
    const video = previewRef.current;
    const canvas = drawOverlayCanvasRef.current;
    if (!canvas) return;

    const exportCanvas = document.createElement('canvas');
    const w = video && video.videoWidth ? video.videoWidth : canvas.width;
    const h = video && video.videoHeight ? video.videoHeight : canvas.height;
    exportCanvas.width = w;
    exportCanvas.height = h;
    const ctx = exportCanvas.getContext('2d');
    if (!ctx) return;

    if (video && isSharing) {
      try {
        ctx.drawImage(video, 0, 0, w, h);
      } catch (e) {}
    } else {
      ctx.fillStyle = '#09090b';
      ctx.fillRect(0, 0, w, h);
    }

    ctx.drawImage(canvas, 0, 0, w, h);

    const link = document.createElement('a');
    link.download = `screen-annotation-${Date.now()}.png`;
    link.href = exportCanvas.toDataURL('image/png');
    link.click();
  }, [isSharing]);

  // Flush Presenter Drawing Stroke over WebSocket
  const flushPresenterStroke = useCallback(
    (phase: 'start' | 'draw' | 'end') => {
      if (!currentStrokeRef.current.length && phase === 'draw') return;
      sendWs('presenter-draw-stroke', {
        points: currentStrokeRef.current,
        color: doodleColor,
        lineWidth: doodleSize,
        tool: doodleTool,
        opacity: doodleTool === 'highlighter' ? 0.35 : 1.0,
        phase,
      });
      currentStrokeRef.current = [];
    },
    [doodleColor, doodleSize, doodleTool, sendWs]
  );

  // Presenter Canvas Pointer Handlers
  const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!isDoodleMode || !drawOverlayCanvasRef.current) return;
    saveHistoryState();
    isDrawingRef.current = true;

    const canvas = drawOverlayCanvasRef.current;
    const video = previewRef.current;
    const rect = canvas.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;

    const vw = video && video.videoWidth ? video.videoWidth : rect.width;
    const vh = video && video.videoHeight ? video.videoHeight : rect.height;
    const metrics = getLetterboxMetrics(rect.width, rect.height, vw, vh);

    const norm = pixelToNormalized(px, py, metrics);
    currentStrokeRef.current = [norm];

    const ctx = canvas.getContext('2d');
    if (ctx) {
      ctx.save();
      if (doodleTool === 'eraser') {
        ctx.globalCompositeOperation = 'destination-out';
        ctx.lineWidth = doodleSize * 2.5;
      } else {
        ctx.globalCompositeOperation = 'source-over';
        ctx.strokeStyle = doodleColor;
        ctx.lineWidth = doodleSize;
        ctx.globalAlpha = doodleTool === 'highlighter' ? 0.35 : 1.0;
      }
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.beginPath();
      ctx.moveTo(px, py);
    }
    flushPresenterStroke('start');
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!isDrawingRef.current || !isDoodleMode || !drawOverlayCanvasRef.current) return;

    const canvas = drawOverlayCanvasRef.current;
    const video = previewRef.current;
    const rect = canvas.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;

    const vw = video && video.videoWidth ? video.videoWidth : rect.width;
    const vh = video && video.videoHeight ? video.videoHeight : rect.height;
    const metrics = getLetterboxMetrics(rect.width, rect.height, vw, vh);

    const norm = pixelToNormalized(px, py, metrics);
    currentStrokeRef.current.push(norm);

    const ctx = canvas.getContext('2d');
    if (ctx) {
      ctx.lineTo(px, py);
      ctx.stroke();
    }

    if (currentStrokeRef.current.length >= 8) {
      flushPresenterStroke('draw');
    }
  };

  const handlePointerUp = () => {
    if (!isDrawingRef.current) return;
    isDrawingRef.current = false;
    const canvas = drawOverlayCanvasRef.current;
    if (canvas) {
      const ctx = canvas.getContext('2d');
      if (ctx) ctx.restore();
    }
    flushPresenterStroke('end');
  };

  // Keyboard shortcut Ctrl+Z / Cmd+Z for Undo
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        const tag = (document.activeElement?.tagName || '').toUpperCase();
        if (tag === 'INPUT' || tag === 'TEXTAREA') return;
        e.preventDefault();
        undoLastStroke();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [undoLastStroke]);

  // Screen Share Start / Stop
  const startSharing = async () => {
    setStatusText('Requesting screen capture...');
    setStatusType('info');

    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: {
          frameRate: { ideal: 30, max: 60 },
          width: { ideal: 1920 },
          height: { ideal: 1080 },
        },
        audio: false,
      });

      streamRef.current = stream;
      if (previewRef.current) {
        previewRef.current.srcObject = stream;
      }

      setIsSharing(true);
      setStatusText('Screen sharing active. Approve receivers below to start streaming.');
      setStatusType('success');
      shareStartTimeRef.current = Date.now();

      // Uptime & FPS Monitoring
      if (uptimeTimerRef.current) clearInterval(uptimeTimerRef.current);
      uptimeTimerRef.current = setInterval(() => {
        if (!shareStartTimeRef.current) return;
        const sec = Math.floor((Date.now() - shareStartTimeRef.current) / 1000);
        const m = Math.floor(sec / 60).toString().padStart(2, '0');
        const s = (sec % 60).toString().padStart(2, '0');
        setUptime(`${m}:${s}`);

        if (streamRef.current) {
          const track = streamRef.current.getVideoTracks()[0];
          if (track) {
            const settings = track.getSettings();
            setFpsResText(`${settings.frameRate || '?'} fps / ${settings.width || '?'}×${settings.height || '?'}`);
          }
        }
      }, 1000);

      // Auto connect approved devices
      devices.forEach((d) => {
        if (d.approved) connectToReceiver(d.id);
      });

      stream.getVideoTracks()[0].onended = () => {
        stopSharing();
      };
    } catch (err: any) {
      const isDenied = err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError';
      const msg = isDenied
        ? 'Screen capture permission denied (or blocked by browser iframe).'
        : err.message || 'Could not start screen sharing';
      setStatusText(msg);
      setStatusType('error');
      if (isDenied) {
        setShowPermissionHelp(true);
      }
    }
  };

  // Fallback Interactive Test Slide Stream (for sandbox/iframe testing when screen capture is restricted)
  const startDemoStream = () => {
    setStatusText('Starting Interactive Test Board Stream...');
    setStatusType('info');
    setShowPermissionHelp(false);

    const canvas = document.createElement('canvas');
    canvas.width = 1280;
    canvas.height = 720;
    const ctx = canvas.getContext('2d');

    let frame = 0;
    const interval = setInterval(() => {
      if (!ctx) return;
      frame++;
      ctx.fillStyle = '#09090b';
      ctx.fillRect(0, 0, 1280, 720);

      // Grid background
      ctx.strokeStyle = '#18181b';
      ctx.lineWidth = 1;
      for (let x = 0; x < 1280; x += 40) {
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, 720);
        ctx.stroke();
      }
      for (let y = 0; y < 720; y += 40) {
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(1280, y);
        ctx.stroke();
      }

      // Title & Slide Header
      ctx.fillStyle = '#38bdf8';
      ctx.font = 'bold 36px system-ui, sans-serif';
      ctx.fillText('Live Classroom & Presentation Studio (Demo Feed)', 80, 110);

      ctx.fillStyle = '#a1a1aa';
      ctx.font = '500 22px system-ui, sans-serif';
      ctx.fillText('1. Interactive Test Board stream active (30 FPS WebRTC)', 80, 190);
      ctx.fillText('2. Use the top doodle bar to draw with colors, highlighter, and eraser', 80, 240);
      ctx.fillText('3. Open TV Receiver on phone or new tab to watch live mirror & annotations', 80, 290);

      // Live Pulse Badge
      const pulse = 24 + Math.sin(frame * 0.08) * 4;
      ctx.beginPath();
      ctx.arc(1140, 100, pulse, 0, Math.PI * 2);
      ctx.fillStyle = '#10b981';
      ctx.fill();

      ctx.fillStyle = '#000000';
      ctx.font = 'bold 14px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('LIVE', 1140, 105);
      ctx.textAlign = 'left';
    }, 1000 / 30);

    const stream = canvas.captureStream(30);
    streamRef.current = stream;

    if (previewRef.current) {
      previewRef.current.srcObject = stream;
    }

    setIsSharing(true);
    setStatusText('Test Slide Stream active! You can doodle and stream to TV receivers.');
    setStatusType('success');
    shareStartTimeRef.current = Date.now();

    if (uptimeTimerRef.current) clearInterval(uptimeTimerRef.current);
    uptimeTimerRef.current = setInterval(() => {
      if (!shareStartTimeRef.current) return;
      const sec = Math.floor((Date.now() - shareStartTimeRef.current) / 1000);
      const m = Math.floor(sec / 60).toString().padStart(2, '0');
      const s = (sec % 60).toString().padStart(2, '0');
      setUptime(`${m}:${s}`);
      setFpsResText('30 fps / 1280×720');
    }, 1000);

    devices.forEach((d) => {
      if (d.approved) connectToReceiver(d.id);
    });

    stream.getVideoTracks()[0].onended = () => {
      clearInterval(interval);
      stopSharing();
    };
  };

  const stopSharing = () => {
    if (recState !== 'idle') {
      finishRecording();
    }

    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }

    if (previewRef.current) {
      previewRef.current.srcObject = null;
    }

    if (uptimeTimerRef.current) {
      clearInterval(uptimeTimerRef.current);
      uptimeTimerRef.current = null;
    }

    peersRef.current.forEach((_, id) => cleanupPeer(id));
    peersRef.current.clear();

    setIsSharing(false);
    setStatusText('Screen sharing stopped.');
    setStatusType('info');

    if (onStreamStateChange) {
      onStreamStateChange(false, 0);
    }
  };

  // Class Recorder
  const startRecording = () => {
    if (!streamRef.current || !streamRef.current.active) {
      setStatusText('Start screen sharing first before recording');
      setStatusType('warn');
      return;
    }

    recChunksRef.current = [];
    try {
      const recorder = new MediaRecorder(streamRef.current, { mimeType: 'video/webm' });
      mediaRecorderRef.current = recorder;

      recorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) recChunksRef.current.push(e.data);
      };

      recorder.onstop = saveRecording;
      recorder.start(1000);

      setRecState('recording');
      setRecSeconds(0);

      if (recTimerRef.current) clearInterval(recTimerRef.current);
      recTimerRef.current = setInterval(() => {
        setRecSeconds((s) => s + 1);
      }, 1000);
    } catch (e: any) {
      setStatusText('Recording failed: ' + e.message);
      setStatusType('error');
    }
  };

  const pauseRecording = () => {
    if (!mediaRecorderRef.current) return;
    if (recState === 'recording') {
      mediaRecorderRef.current.pause();
      setRecState('paused');
    } else if (recState === 'paused') {
      mediaRecorderRef.current.resume();
      setRecState('recording');
    }
  };

  const finishRecording = () => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      mediaRecorderRef.current.stop();
    }
  };

  const saveRecording = () => {
    if (recTimerRef.current) clearInterval(recTimerRef.current);
    const blob = new Blob(recChunksRef.current, { type: 'video/webm' });
    recChunksRef.current = [];

    const ts = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    const fname = `class-recording-${ts.getFullYear()}${pad(ts.getMonth() + 1)}${pad(ts.getDate())}-${pad(
      ts.getHours()
    )}${pad(ts.getMinutes())}.webm`;

    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fname;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);

    setRecState('idle');
    setRecSeconds(0);
    setStatusText(`Recording saved: ${fname}`);
    setStatusType('success');
  };

  // Device Management Actions
  const approveDevice = (id: string, approved: boolean) => {
    sendWs('approve', { id, approved });
    setDevices((prev) => prev.map((d) => (d.id === id ? { ...d, approved } : d)));
    if (isSharing && approved) {
      connectToReceiver(id);
    } else if (!approved) {
      cleanupPeer(id);
    }
  };

  const kickDevice = (id: string) => {
    sendWs('kick', { id });
    cleanupPeer(id);
    setDevices((prev) => prev.map((d) => (d.id === id ? { ...d, connected: false } : d)));
  };

  const toggleDrawAccess = (id: string, approved: boolean) => {
    sendWs('draw-approve', { id, approved });
    setDevices((prev) => prev.map((d) => (d.id === id ? { ...d, canDraw: approved } : d)));
    setRaisedHands((prev) => prev.map((h) => (h.id === id ? { ...h, canDraw: approved } : h)));
  };

  // File Upload Handlers
  const handleFileUpload = (files: FileList | null) => {
    if (!files || !files.length) return;
    Array.from(files).forEach((file) => {
      setUploadProgress({ name: file.name, progress: 0 });

      const xhr = new XMLHttpRequest();
      xhr.open('POST', '/api/files/upload');
      xhr.setRequestHeader('X-File-Name', encodeURIComponent(file.name));
      xhr.setRequestHeader('Content-Type', 'application/octet-stream');

      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) {
          setUploadProgress({ name: file.name, progress: Math.round((e.loaded / e.total) * 100) });
        }
      };

      xhr.onload = () => {
        setUploadProgress(null);
        if (xhr.status === 200) {
          try {
            const data = JSON.parse(xhr.responseText);
            setSharedFiles((prev) => [data.file, ...prev]);
          } catch (e) {}
        }
      };

      xhr.onerror = () => setUploadProgress(null);
      xhr.send(file);
    });
  };

  const deleteFile = async (id: string) => {
    try {
      await fetch(`/api/files/${id}`, { method: 'DELETE' });
      setSharedFiles((prev) => prev.filter((f) => f.id !== id));
    } catch (e) {}
  };

  // Send Chat Reply
  const sendReply = () => {
    if (!chatInput.trim() || !chatReplyTo) return;
    sendWs('chat-reply', { id: chatReplyTo.id, text: chatInput.trim() });
    setChatInput('');
  };

  return (
    <div className="mx-auto max-w-7xl p-4 sm:p-6 space-y-6 text-zinc-100">
      {/* Top Banner Control Bar */}
      <div className="flex flex-col lg:flex-row items-start lg:items-center justify-between gap-4 rounded-2xl bg-zinc-900 border border-zinc-800 p-5 shadow-xl">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <h2 className="text-xl font-extrabold text-white">Presenter Studio</h2>
            <span
              className={`rounded-full px-2.5 py-0.5 text-xs font-bold ${
                isSharing ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20' : 'bg-zinc-800 text-zinc-400'
              }`}
            >
              {isSharing ? 'Sharing Active' : 'Idle'}
            </span>
          </div>
          <p className="text-xs text-zinc-400">{statusText}</p>
        </div>

        {/* Action Controls */}
        <div className="flex flex-wrap items-center gap-3 w-full lg:w-auto">
          {!isSharing ? (
            <button
              onClick={startSharing}
              className="flex-1 lg:flex-none flex items-center justify-center gap-2 rounded-xl bg-blue-600 px-5 py-2.5 text-xs font-bold text-white hover:bg-blue-500 shadow-lg shadow-blue-600/30 transition-all"
            >
              <Play className="w-4 h-4 fill-white" /> Start Sharing Screen
            </button>
          ) : (
            <button
              onClick={stopSharing}
              className="flex-1 lg:flex-none flex items-center justify-center gap-2 rounded-xl bg-red-600 px-5 py-2.5 text-xs font-bold text-white hover:bg-red-500 shadow-lg shadow-red-600/30 transition-all"
            >
              <Square className="w-4 h-4 fill-white" /> Stop Sharing
            </button>
          )}

          {/* Recorder Controls */}
          {recState === 'idle' ? (
            <button
              onClick={startRecording}
              disabled={!isSharing}
              className="flex items-center gap-2 rounded-xl bg-zinc-800 border border-zinc-700 px-4 py-2.5 text-xs font-bold text-zinc-200 hover:bg-zinc-700 hover:text-white disabled:opacity-40 disabled:cursor-not-allowed transition-all"
            >
              <Video className="w-4 h-4 text-red-500" /> Record Class
            </button>
          ) : (
            <div className="flex items-center gap-2 bg-zinc-950 p-1 rounded-xl border border-zinc-800">
              <span className="flex items-center gap-1.5 px-3 text-xs font-mono font-bold text-red-400">
                <Circle className="w-2.5 h-2.5 fill-red-500 animate-pulse text-red-500" />
                {Math.floor(recSeconds / 60)
                  .toString()
                  .padStart(2, '0')}
                :{(recSeconds % 60).toString().padStart(2, '0')}
              </span>
              <button
                onClick={pauseRecording}
                className="rounded-lg bg-zinc-800 px-2.5 py-1 text-xs font-semibold text-zinc-200 hover:bg-zinc-700"
              >
                {recState === 'paused' ? 'Resume' : 'Pause'}
              </button>
              <button
                onClick={finishRecording}
                className="rounded-lg bg-red-600 px-2.5 py-1 text-xs font-bold text-white hover:bg-red-500"
              >
                Save
              </button>
            </div>
          )}

          <button
            onClick={onOpenShareModal}
            className="flex items-center gap-2 rounded-xl bg-zinc-800 border border-zinc-700 px-4 py-2.5 text-xs font-bold text-zinc-200 hover:bg-zinc-700 hover:text-white transition-all"
          >
            <Share2 className="w-4 h-4 text-blue-400" /> Connect Devices
          </button>
        </div>
      </div>

      {/* Screen Capture Permission Helper Banner */}
      {showPermissionHelp && (
        <div className="rounded-2xl bg-amber-950/40 border border-amber-500/40 p-4 text-amber-200 shadow-xl flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
          <div className="space-y-1">
            <div className="flex items-center gap-2 font-bold text-amber-300 text-sm">
              <Sparkles className="w-4 h-4 text-amber-400" /> Screen Sharing Restricted in iFrame Preview
            </div>
            <p className="text-xs text-amber-200/80 max-w-2xl">
              Browsers restrict OS screen picker permissions inside embedded preview frames. You can either open the app in a full browser tab for standard OS screen selection or launch an interactive test board feed.
            </p>
          </div>
          <div className="flex items-center gap-2 w-full md:w-auto">
            <a
              href={window.location.href}
              target="_blank"
              rel="noreferrer"
              className="flex-1 md:flex-none flex items-center justify-center gap-1.5 rounded-xl bg-amber-500 px-4 py-2 text-xs font-bold text-black hover:bg-amber-400 transition-all shadow-md"
            >
              <ExternalLink className="w-3.5 h-3.5" /> Open in New Tab
            </a>
            <button
              onClick={startDemoStream}
              className="flex-1 md:flex-none flex items-center justify-center gap-1.5 rounded-xl bg-zinc-800 border border-amber-500/40 px-4 py-2 text-xs font-bold text-amber-200 hover:bg-zinc-700 transition-all"
            >
              <Play className="w-3.5 h-3.5 text-emerald-400 fill-emerald-400" /> Launch Test Stream
            </button>
          </div>
        </div>
      )}

      {/* Main Grid: Video Preview + Classroom Interactivity */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left Column (2 Cols): Live Preview Video & Telemetry */}
        <div className="lg:col-span-2 space-y-4">
          {/* Presenter Studio Doodle Toolbar - Floating Always On Top */}
          <div className="sticky top-2 z-30 flex flex-wrap items-center justify-between gap-3 rounded-2xl bg-zinc-950/95 p-3 border border-zinc-700/80 shadow-2xl backdrop-blur-xl ring-1 ring-white/10">
            {/* Left: Mode toggle & Tools */}
            <div className="flex items-center gap-2 flex-wrap">
              <button
                onClick={() => setIsDoodleMode(!isDoodleMode)}
                className={`flex items-center gap-2 rounded-xl px-3.5 py-2 text-xs font-bold transition-all ${
                  isDoodleMode
                    ? 'bg-emerald-500 text-black shadow-lg shadow-emerald-500/30 ring-2 ring-emerald-400/50'
                    : 'bg-zinc-800/90 text-zinc-300 hover:bg-zinc-700'
                }`}
                title={isDoodleMode ? 'Doodle Mode Active (Draw on screen overlay)' : 'Pointer Mode Active (Click through screen)'}
              >
                {isDoodleMode ? <Pencil className="w-4 h-4 animate-pulse" /> : <MousePointer className="w-4 h-4" />}
                {isDoodleMode ? 'Doodle Mode ON' : 'Pointer Mode'}
              </button>

              <div className="h-4 w-px bg-zinc-800 my-auto hidden sm:block" />

              {/* Tool selector */}
              <div className="flex items-center gap-1 bg-zinc-900/90 p-1 rounded-xl border border-zinc-800">
                <button
                  onClick={() => setDoodleTool('pen')}
                  className={`flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-xs font-semibold transition-colors ${
                    doodleTool === 'pen' ? 'bg-zinc-700 text-white shadow' : 'text-zinc-400 hover:text-zinc-200'
                  }`}
                  title="Pen Tool"
                >
                  <Pencil className="w-3.5 h-3.5" /> Pen
                </button>
                <button
                  onClick={() => setDoodleTool('highlighter')}
                  className={`flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-xs font-semibold transition-colors ${
                    doodleTool === 'highlighter'
                      ? 'bg-zinc-700 text-amber-300 shadow'
                      : 'text-zinc-400 hover:text-zinc-200'
                  }`}
                  title="Highlighter Tool"
                >
                  <Highlighter className="w-3.5 h-3.5" /> Highlight
                </button>
                <button
                  onClick={() => setDoodleTool('eraser')}
                  className={`flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-xs font-semibold transition-colors ${
                    doodleTool === 'eraser' ? 'bg-zinc-700 text-red-400 shadow' : 'text-zinc-400 hover:text-zinc-200'
                  }`}
                  title="Eraser Tool"
                >
                  <Eraser className="w-3.5 h-3.5" /> Eraser
                </button>
              </div>

              {/* Color Presets & Picker */}
              {doodleTool !== 'eraser' && (
                <div className="flex items-center gap-1.5 bg-zinc-900/90 p-1 px-2 rounded-xl border border-zinc-800">
                  {COLOR_PRESETS.map((c) => (
                    <button
                      key={c.hex}
                      onClick={() => setDoodleColor(c.hex)}
                      className={`h-5 w-5 rounded-full border transition-transform ${
                        doodleColor === c.hex
                          ? 'scale-125 border-white ring-2 ring-emerald-500/50'
                          : 'border-zinc-700 hover:scale-110'
                      }`}
                      style={{ backgroundColor: c.hex }}
                      title={c.name}
                    />
                  ))}
                  <label
                    className="relative cursor-pointer flex items-center justify-center h-5 w-5 rounded-full border border-zinc-700 bg-gradient-to-tr from-indigo-500 via-purple-500 to-pink-500 hover:scale-110 transition-transform"
                    title="Custom Color"
                  >
                    <input
                      type="color"
                      value={doodleColor}
                      onChange={(e) => setDoodleColor(e.target.value)}
                      className="opacity-0 absolute inset-0 w-full h-full cursor-pointer"
                    />
                  </label>
                </div>
              )}

              {/* Line Thickness */}
              <div className="flex items-center gap-1.5 bg-zinc-900/90 px-2.5 py-1 rounded-xl border border-zinc-800 text-xs text-zinc-300">
                <span className="text-[10px] uppercase font-bold text-zinc-500 hidden xl:inline">Size</span>
                <div className="flex items-center gap-1">
                  {SIZE_PRESETS.map((s) => (
                    <button
                      key={s.value}
                      onClick={() => setDoodleSize(s.value)}
                      className={`px-2 py-0.5 rounded text-[11px] font-bold transition-colors ${
                        doodleSize === s.value
                          ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/40'
                          : 'text-zinc-400 hover:text-zinc-200'
                      }`}
                    >
                      {s.label}
                    </button>
                  ))}
                </div>
                <input
                  type="range"
                  min="1"
                  max="35"
                  value={doodleSize}
                  onChange={(e) => setDoodleSize(Number(e.target.value))}
                  className="w-16 accent-emerald-500 cursor-pointer hidden sm:block"
                />
                <span className="font-mono text-[11px] text-zinc-400 w-5 text-right">{doodleSize}px</span>
              </div>
            </div>

            {/* Right: Actions (Undo, Clear All, Snapshot) */}
            <div className="flex items-center gap-1.5">
              <button
                onClick={undoLastStroke}
                disabled={historyStack.length === 0}
                className="flex items-center gap-1 rounded-xl bg-zinc-800 px-3 py-1.5 text-xs font-semibold text-zinc-200 hover:bg-zinc-700 disabled:opacity-40 disabled:cursor-not-allowed transition-all"
                title="Undo Last Stroke (Ctrl+Z)"
              >
                <Undo className="w-3.5 h-3.5 text-amber-400" /> Undo
              </button>
              <button
                onClick={clearAllDoodles}
                className="flex items-center gap-1.5 rounded-xl bg-red-950/80 border border-red-500/40 px-3.5 py-1.5 text-xs font-bold text-red-200 hover:bg-red-900 hover:text-white transition-all shadow-md shadow-red-950/50"
                title="Clear All Canvas Annotations"
              >
                <Trash2 className="w-3.5 h-3.5 text-red-400" /> Clear All
              </button>
              <button
                onClick={captureAnnotatedFrame}
                className="flex items-center gap-1 rounded-xl bg-blue-950/60 border border-blue-500/30 px-3 py-1.5 text-xs font-semibold text-blue-300 hover:bg-blue-900/80 transition-all"
                title="Save Annotated Screenshot"
              >
                <Camera className="w-3.5 h-3.5" /> Snapshot
              </button>
            </div>
          </div>

          <div className="relative aspect-video w-full rounded-2xl bg-zinc-950 border border-zinc-800 overflow-hidden shadow-2xl flex items-center justify-center">
            <video
              ref={previewRef}
              autoPlay
              muted
              playsInline
              onLoadedMetadata={resizeDrawOverlay}
              className={`h-full w-full object-contain ${isSharing ? 'block' : 'hidden'}`}
            />

            {/* Doodle Overlay Canvas */}
            <canvas
              ref={drawOverlayCanvasRef}
              onPointerDown={handlePointerDown}
              onPointerMove={handlePointerMove}
              onPointerUp={handlePointerUp}
              onPointerLeave={handlePointerUp}
              className={`absolute inset-0 h-full w-full touch-none z-10 ${
                isDoodleMode ? 'cursor-crosshair pointer-events-auto' : 'pointer-events-none'
              }`}
            />

            {/* Draw Label */}
            {drawLabel && (
              <div className="absolute top-4 left-4 z-20 rounded-xl bg-black/80 px-3 py-1.5 text-xs font-bold text-emerald-400 border border-emerald-500/30 backdrop-blur-md animate-fade-in">
                {drawLabel}
              </div>
            )}

            {!isSharing && (
              <div className="flex flex-col items-center justify-center text-center p-8 space-y-3">
                <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-zinc-900 border border-zinc-800 text-zinc-500">
                  <Tv className="w-8 h-8" />
                </div>
                <div>
                  <h3 className="text-base font-bold text-zinc-300">No Active Screen Stream</h3>
                  <p className="text-xs text-zinc-500 max-w-sm mt-1">
                    Click "Start Sharing Screen" above to mirror your laptop screen, slides, or app to all TV receivers.
                  </p>
                </div>
              </div>
            )}
          </div>

          {/* Telemetry Bar */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
            <div className="rounded-xl bg-zinc-900 border border-zinc-800 p-3 flex flex-col justify-center">
              <span className="text-[10px] text-zinc-500 font-medium uppercase tracking-wider">Stream Status</span>
              <span className="font-bold text-zinc-200 mt-0.5 flex items-center gap-1.5">
                <Circle className={`w-2 h-2 fill-current ${isSharing ? 'text-emerald-400 animate-pulse' : 'text-zinc-600'}`} />
                {isSharing ? 'Live Broadcast' : 'Offline'}
              </span>
            </div>

            <div className="rounded-xl bg-zinc-900 border border-zinc-800 p-3 flex flex-col justify-center">
              <span className="text-[10px] text-zinc-500 font-medium uppercase tracking-wider">FPS & Resolution</span>
              <span className="font-bold text-zinc-200 mt-0.5 font-mono">{fpsResText}</span>
            </div>

            <div className="rounded-xl bg-zinc-900 border border-zinc-800 p-3 flex flex-col justify-center">
              <span className="text-[10px] text-zinc-500 font-medium uppercase tracking-wider">Stream Uptime</span>
              <span className="font-bold text-zinc-200 mt-0.5 font-mono">{uptime}</span>
            </div>

            <div className="rounded-xl bg-zinc-900 border border-zinc-800 p-3 flex flex-col justify-center">
              <span className="text-[10px] text-zinc-500 font-medium uppercase tracking-wider">Connected TV Devices</span>
              <span className="font-bold text-blue-400 mt-0.5">
                {devices.filter((d) => d.approved && d.connected).length} / {devices.length} Devices
              </span>
            </div>
          </div>
        </div>

        {/* Right Column (1 Col): Devices & Classroom Management */}
        <div className="space-y-6">
          {/* Devices Approval List */}
          <div className="rounded-2xl bg-zinc-900 border border-zinc-800 p-4 space-y-3 shadow-xl">
            <div className="flex items-center justify-between border-b border-zinc-800 pb-3">
              <div className="flex items-center gap-2 font-bold text-xs text-white">
                <Users className="w-4 h-4 text-blue-400" /> Connected Devices ({devices.length})
              </div>
              <button
                onClick={onOpenShareModal}
                className="text-[11px] font-semibold text-blue-400 hover:underline"
              >
                + Add Device
              </button>
            </div>

            <div className="space-y-2 max-h-56 overflow-y-auto pr-1">
              {devices.length === 0 ? (
                <p className="text-center text-xs text-zinc-500 py-6">
                  No TV devices connected yet. Open the TV URL on any device to join.
                </p>
              ) : (
                devices.map((d) => (
                  <div
                    key={d.id}
                    className="flex items-center justify-between rounded-xl bg-zinc-950 p-2.5 border border-zinc-800/80 text-xs"
                  >
                    <div className="min-w-0 flex-1 pr-2">
                      <div className="flex items-center gap-2">
                        <span className="font-bold text-zinc-200 truncate">{d.name || d.id.slice(-8)}</span>
                        <span
                          className={`rounded-full px-1.5 py-0.2 text-[9px] font-bold ${
                            d.connected
                              ? 'bg-emerald-500/20 text-emerald-400'
                              : d.approved
                              ? 'bg-amber-500/20 text-amber-400'
                              : 'bg-zinc-800 text-zinc-500'
                          }`}
                        >
                          {d.connected ? 'Live' : d.approved ? 'Approved' : 'Pending'}
                        </span>
                      </div>
                      <span className="text-[10px] text-zinc-500 font-mono">{d.id.slice(-8)}</span>
                    </div>

                    <div className="flex items-center gap-1.5">
                      {!d.approved ? (
                        <button
                          onClick={() => approveDevice(d.id, true)}
                          className="rounded-lg bg-emerald-600 px-2.5 py-1 text-[11px] font-bold text-white hover:bg-emerald-500"
                        >
                          Allow
                        </button>
                      ) : (
                        <button
                          onClick={() => approveDevice(d.id, false)}
                          className="rounded-lg bg-zinc-800 px-2 py-1 text-[11px] font-semibold text-zinc-400 hover:bg-zinc-700 hover:text-white"
                        >
                          Revoke
                        </button>
                      )}

                      {d.canDraw ? (
                        <button
                          onClick={() => toggleDrawAccess(d.id, false)}
                          className="rounded-lg bg-emerald-600/20 border border-emerald-500/40 px-2 py-1 text-[11px] font-bold text-emerald-400 hover:bg-red-950 hover:text-red-400"
                          title="Revoke Drawing Permission"
                        >
                          Drawing On
                        </button>
                      ) : (
                        <button
                          onClick={() => toggleDrawAccess(d.id, true)}
                          className="rounded-lg bg-zinc-800 px-2 py-1 text-[11px] font-semibold text-zinc-400 hover:bg-zinc-700 hover:text-white"
                          title="Grant Drawing Permission"
                        >
                          Allow Draw
                        </button>
                      )}

                      <button
                        onClick={() => kickDevice(d.id)}
                        className="rounded-lg p-1 text-zinc-500 hover:bg-red-950 hover:text-red-400 transition-colors"
                        title="Kick Device"
                      >
                        <X className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>

          {/* Raised Hands Panel */}
          {raisedHands.length > 0 && (
            <div className="rounded-2xl bg-amber-950/20 border border-amber-500/30 p-4 space-y-3 shadow-xl">
              <div className="flex items-center justify-between border-b border-amber-500/20 pb-2">
                <div className="flex items-center gap-2 font-bold text-xs text-amber-400">
                  <Hand className="w-4 h-4" /> Raised Hands Queue ({raisedHands.length})
                </div>
              </div>

              <div className="space-y-2">
                {raisedHands.map((h) => (
                  <div
                    key={h.id}
                    className="flex items-center justify-between rounded-xl bg-zinc-950 p-2.5 border border-amber-500/20 text-xs"
                  >
                    <span className="font-bold text-amber-200">{h.name}</span>
                    <div className="flex items-center gap-1.5">
                      {!h.canDraw ? (
                        <button
                          onClick={() => toggleDrawAccess(h.id, true)}
                          className="flex items-center gap-1 rounded-lg bg-emerald-600 px-2.5 py-1 text-[11px] font-bold text-white hover:bg-emerald-500"
                        >
                          <Pencil className="w-3 h-3" /> Let Them Draw
                        </button>
                      ) : (
                        <span className="text-[11px] font-bold text-emerald-400">Can Draw</span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Student Chat Panel */}
          <div className="rounded-2xl bg-zinc-900 border border-zinc-800 p-4 space-y-3 shadow-xl">
            <div className="flex items-center justify-between border-b border-zinc-800 pb-3">
              <div className="flex items-center gap-2 font-bold text-xs text-white">
                <MessageSquare className="w-4 h-4 text-blue-400" /> Student Chat ({chatMessages.length})
              </div>
            </div>

            <div className="space-y-2 max-h-44 overflow-y-auto p-1">
              {chatMessages.length === 0 ? (
                <p className="text-center text-xs text-zinc-500 py-4">No student messages yet.</p>
              ) : (
                chatMessages.map((m, idx) => (
                  <div
                    key={idx}
                    onClick={() => setChatReplyTo({ id: m.id, name: m.name })}
                    className="cursor-pointer rounded-xl bg-zinc-950 p-2.5 border border-zinc-800 hover:border-blue-500/50 transition-colors text-xs space-y-1"
                  >
                    <div className="flex items-center justify-between text-[10px]">
                      <span className="font-bold text-blue-400">{m.name}</span>
                      <span className="text-zinc-500">{new Date(m.t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                    </div>
                    <p className="text-zinc-200">{m.text}</p>
                  </div>
                ))
              )}
            </div>

            {/* Chat Reply Box */}
            <div className="space-y-1.5 border-t border-zinc-800 pt-2.5">
              {chatReplyTo && (
                <div className="flex items-center justify-between text-[10px] text-zinc-400">
                  <span>Replying to: <strong className="text-blue-400">{chatReplyTo.name}</strong></span>
                  <button onClick={() => setChatReplyTo(null)} className="hover:text-white">✕ Clear</button>
                </div>
              )}
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  value={chatInput}
                  onChange={(e) => setChatInput(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && sendReply()}
                  placeholder={chatReplyTo ? `Reply to ${chatReplyTo.name}...` : 'Select a message above to reply...'}
                  disabled={!chatReplyTo}
                  className="flex-1 rounded-xl bg-zinc-950 border border-zinc-800 px-3 py-1.5 text-xs text-zinc-100 focus:border-blue-500 focus:outline-none disabled:opacity-50"
                />
                <button
                  onClick={sendReply}
                  disabled={!chatReplyTo}
                  className="rounded-xl bg-blue-600 p-2 text-white hover:bg-blue-500 disabled:opacity-40 transition-colors"
                >
                  <Send className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          </div>

          {/* File Sharing Hub */}
          <div className="rounded-2xl bg-zinc-900 border border-zinc-800 p-4 space-y-3 shadow-xl">
            <div className="flex items-center justify-between border-b border-zinc-800 pb-3">
              <div className="flex items-center gap-2 font-bold text-xs text-white">
                <UploadCloud className="w-4 h-4 text-indigo-400" /> File Sharing Hub ({sharedFiles.length})
              </div>
            </div>

            {/* Drop Zone */}
            <label className="flex flex-col items-center justify-center rounded-xl border-2 border-dashed border-zinc-800 bg-zinc-950 p-4 text-center cursor-pointer hover:border-blue-500/50 transition-colors">
              <UploadCloud className="w-6 h-6 text-zinc-500 mb-1" />
              <span className="text-xs font-semibold text-zinc-300">Click or drag files to share with TV receivers</span>
              <span className="text-[10px] text-zinc-500 mt-0.5">PDF, DOCX, Images, Video, Audio, ZIP up to 500MB</span>
              <input
                type="file"
                multiple
                onChange={(e) => handleFileUpload(e.target.files)}
                className="hidden"
              />
            </label>

            {uploadProgress && (
              <div className="rounded-xl bg-zinc-950 p-2.5 border border-zinc-800 text-xs space-y-1">
                <div className="flex justify-between font-medium text-zinc-300">
                  <span className="truncate">{uploadProgress.name}</span>
                  <span>{uploadProgress.progress}%</span>
                </div>
                <div className="h-1.5 w-full bg-zinc-800 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-blue-600 transition-all duration-150"
                    style={{ width: `${uploadProgress.progress}%` }}
                  />
                </div>
              </div>
            )}

            {/* File List */}
            <div className="space-y-2 max-h-40 overflow-y-auto pr-1">
              {sharedFiles.map((f) => (
                <div
                  key={f.id}
                  className="flex items-center justify-between rounded-xl bg-zinc-950 p-2.5 border border-zinc-800 text-xs"
                >
                  <div className="min-w-0 flex-1 pr-2">
                    <p className="font-semibold text-zinc-200 truncate">{f.name}</p>
                    <p className="text-[10px] text-zinc-500">{formatBytes(f.size)}</p>
                  </div>
                  <div className="flex items-center gap-1">
                    <a
                      href={`/api/files/${f.id}`}
                      download
                      className="rounded-lg p-1 text-zinc-400 hover:text-white"
                    >
                      <Download className="w-3.5 h-3.5" />
                    </a>
                    <button
                      onClick={() => deleteFile(f.id)}
                      className="rounded-lg p-1 text-zinc-500 hover:text-red-400"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
