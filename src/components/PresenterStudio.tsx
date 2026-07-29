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
} from 'lucide-react';
import { Device, SharedFile, ChatMessage, DoodleStroke } from '../types';
import {
  fetchIceServers,
  applyBitrateCap,
  getLetterboxMetrics,
  normalizedToPixel,
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

  // Render Student Doodle Stroke onto Video Overlay
  const renderIncomingStroke = useCallback((msg: DoodleStroke & { name?: string }) => {
    const canvas = drawOverlayCanvasRef.current;
    const video = previewRef.current;
    if (!canvas || !video) return;

    if (canvas.width === 0) resizeDrawOverlay();
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    if (msg.name) {
      setDrawLabel(`✏️ ${msg.name} is drawing`);
      if (drawLabelTimerRef.current) clearTimeout(drawLabelTimerRef.current);
      drawLabelTimerRef.current = setTimeout(() => setDrawLabel(null), 2500);
    }

    const rect = canvas.getBoundingClientRect();
    const metrics = getLetterboxMetrics(rect.width, rect.height, video.videoWidth, video.videoHeight);

    const pts = msg.points || [];
    if (!pts.length) return;

    ctx.strokeStyle = msg.color || '#ef4444';
    ctx.lineWidth = msg.lineWidth || 3;
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
  }, [resizeDrawOverlay]);

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
      const msg =
        err.name === 'NotAllowedError'
          ? 'Screen capture permission denied.'
          : err.message || 'Could not start screen sharing';
      setStatusText(msg);
      setStatusType('error');
    }
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

      {/* Main Grid: Video Preview + Classroom Interactivity */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left Column (2 Cols): Live Preview Video & Telemetry */}
        <div className="lg:col-span-2 space-y-4">
          <div className="relative aspect-video w-full rounded-2xl bg-zinc-950 border border-zinc-800 overflow-hidden shadow-2xl flex items-center justify-center">
            <video
              ref={previewRef}
              autoPlay
              muted
              playsInline
              onLoadedMetadata={resizeDrawOverlay}
              className={`h-full w-full object-contain ${isSharing ? 'block' : 'hidden'}`}
            />

            {/* Doodle Overlay */}
            <canvas
              ref={drawOverlayCanvasRef}
              className="absolute inset-0 h-full w-full pointer-events-none z-10"
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
