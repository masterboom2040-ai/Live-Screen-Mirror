import React, { useEffect, useRef, useState, useCallback } from 'react';
import {
  Tv,
  Hand,
  Pencil,
  MessageSquare,
  FolderDown,
  Maximize,
  Minimize,
  RefreshCw,
  Play,
  X,
  Send,
  Download,
  AlertCircle,
  Wifi,
  Sparkles,
  Monitor,
  Share2,
} from 'lucide-react';
import { SharedFile, ChatMessage, Point, IceServerConfig } from '../types';
import {
  fetchIceServers,
  getLetterboxMetrics,
  normalizedToPixel,
  pixelToNormalized,
  formatBytes,
} from '../lib/webrtc';

interface TvReceiverProps {
  onOpenShareModal?: () => void;
}

export const TvReceiver: React.FC<TvReceiverProps> = ({ onOpenShareModal }) => {
  const [statusText, setStatusText] = useState('Waiting for approval from presenter...');
  const [connBadge, setConnBadge] = useState<{ text: string; type: 'live' | 'warn' | 'blocked' | 'waiting' }>({
    text: 'Waiting',
    type: 'waiting',
  });
  const [latencyText, setLatencyText] = useState('-- ms');
  const [needsTapToPlay, setNeedsTapToPlay] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);

  // Classroom features state
  const [handRaised, setHandRaised] = useState(false);
  const [canDraw, setCanDraw] = useState(false);
  const [drawColor, setDrawColor] = useState('#ef4444');
  const [drawSize, setDrawSize] = useState(3);

  // Drawers
  const [isChatOpen, setIsChatOpen] = useState(false);
  const [chatMessages, setChatMessages] = useState<{ who: 'me' | 'teacher'; text: string; label: string }[]>([]);
  const [chatInput, setChatInput] = useState('');
  const [hasNewChat, setHasNewChat] = useState(false);

  const [isFilesOpen, setIsFilesOpen] = useState(false);
  const [sharedFiles, setSharedFiles] = useState<SharedFile[]>([]);
  const [hasNewFile, setHasNewFile] = useState(false);

  // References
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const drawCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const candidateBufferRef = useRef<any[]>([]);
  const lastEpochRef = useRef<number>(0);
  const isFreshPageLoadRef = useRef<boolean>(true);
  const latencyTimerRef = useRef<NodeJS.Timeout | null>(null);

  // Stroke drawing buffer
  const isDrawingRef = useRef(false);
  const currentStrokeRef = useRef<Point[]>([]);

  // Unique Receiver ID
  const [myId] = useState(() => {
    let saved = localStorage.getItem('mirror-receiver-id');
    if (!saved) {
      saved = 'rx-' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
      localStorage.setItem('mirror-receiver-id', saved);
    }
    return saved;
  });

  const getDeviceName = () => {
    const ua = navigator.userAgent;
    if (ua.includes('SMART-TV') || ua.includes('Web0S') || ua.includes('Tizen')) return 'Smart TV';
    if (ua.includes('iPad')) return 'iPad';
    if (ua.includes('iPhone')) return 'iPhone';
    if (ua.includes('Android')) return 'Android';
    if (ua.includes('Windows')) return 'Windows PC';
    if (ua.includes('Mac')) return 'Mac';
    return 'TV Device';
  };

  const sendWs = useCallback((type: string, payload: Record<string, any> = {}) => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type, ...payload }));
    }
  }, []);

  const cleanupPc = useCallback(() => {
    if (pcRef.current) {
      try {
        pcRef.current.close();
      } catch (e) {}
      pcRef.current = null;
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
    candidateBufferRef.current = [];
    if (latencyTimerRef.current) {
      clearInterval(latencyTimerRef.current);
      latencyTimerRef.current = null;
    }
    setLatencyText('-- ms');
  }, []);

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

  // Latency monitoring with silent stall detection
  const startLatencyMonitor = useCallback(() => {
    if (latencyTimerRef.current) clearInterval(latencyTimerRef.current);
    let lastBytes = -1;
    let stallCount = 0;

    latencyTimerRef.current = setInterval(async () => {
      if (!pcRef.current) return;
      try {
        const stats = await pcRef.current.getStats();
        let jitterMs: number | null = null;
        let rttMs: number | null = null;
        let bytesReceived: number | null = null;

        stats.forEach((report) => {
          if (report.type === 'inbound-rtp' && report.kind === 'video') {
            if (report.jitterBufferDelay !== undefined && report.jitterBufferEmittedCount > 0) {
              jitterMs = (report.jitterBufferDelay / report.jitterBufferEmittedCount) * 1000;
            }
            bytesReceived = report.bytesReceived;
          }
          if (report.type === 'candidate-pair' && report.currentRoundTripTime !== undefined) {
            rttMs = report.currentRoundTripTime * 1000;
          }
        });

        const display =
          jitterMs !== null
            ? `${Math.round(jitterMs)}ms`
            : rttMs !== null
            ? `~${Math.round(rttMs / 2)}ms`
            : '--';
        setLatencyText(display);

        // Stall detection
        if (pcRef.current.connectionState === 'connected' && bytesReceived !== null) {
          if (bytesReceived === lastBytes) {
            stallCount++;
            if (stallCount >= 3) {
              stallCount = 0;
              setStatusText('Stream stalled. Reconnecting...');
              setConnBadge({ text: 'Reconnecting...', type: 'warn' });
              cleanupPc();
              sendWs('renegotiate', { id: myId });
            }
          } else {
            stallCount = 0;
            lastBytes = bytesReceived;
          }
        }
      } catch (e) {}
    }, 2000);
  }, [cleanupPc, myId, sendWs]);

  // Connect WebRTC Offer
  const connectOffer = useCallback(
    async (offer: RTCSessionDescriptionInit) => {
      cleanupPc();
      setStatusText('Connecting...');
      setConnBadge({ text: 'Connecting...', type: 'warn' });

      const iceServers = await fetchIceServers();
      const pc = new RTCPeerConnection({
        iceServers,
        iceTransportPolicy: 'all',
        bundlePolicy: 'max-bundle',
      });
      pcRef.current = pc;

      pc.ontrack = (e) => {
        const stream = e.streams[0];
        if (videoRef.current && stream) {
          videoRef.current.srcObject = stream;
          setStatusText('');
          setConnBadge({ text: 'Live', type: 'live' });

          // Sub-50ms Jitter Buffer Target
          const receivers = pc.getReceivers();
          for (const rx of receivers) {
            if (rx.track && rx.track.kind === 'video') {
              try {
                if ('jitterBufferTarget' in rx) {
                  (rx as any).jitterBufferTarget = 0;
                }
              } catch (e) {}
            }
          }

          videoRef.current.play().catch(() => {
            setNeedsTapToPlay(true);
          });

          startLatencyMonitor();
        }
      };

      pc.onicecandidate = (e) => {
        if (e.candidate) {
          sendWs('candidate', {
            id: myId,
            from: 'receiver',
            candidate: e.candidate,
            epoch: lastEpochRef.current,
          });
        }
      };

      pc.onconnectionstatechange = () => {
        const state = pc.connectionState;
        if (state === 'connected') {
          setConnBadge({ text: 'Live', type: 'live' });
          setStatusText('');
        } else if (state === 'disconnected') {
          setConnBadge({ text: 'Reconnecting...', type: 'warn' });
          setStatusText('Connection interrupted...');
        } else if (state === 'failed' || state === 'closed') {
          setConnBadge({ text: 'Disconnected', type: 'blocked' });
          setStatusText('Connection lost. Reconnecting...');
          cleanupPc();
          setTimeout(() => sendWs('renegotiate', { id: myId }), 1500);
        }
      };

      try {
        await pc.setRemoteDescription(new RTCSessionDescription(offer));

        while (candidateBufferRef.current.length > 0) {
          const cand = candidateBufferRef.current.shift();
          await pc.addIceCandidate(cand).catch(() => {});
        }

        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);

        sendWs('answer', { id: myId, answer });
      } catch (err) {
        console.error('Connection failed:', err);
        setStatusText('Failed to connect. Retrying...');
        cleanupPc();
      }
    },
    [cleanupPc, myId, sendWs, startLatencyMonitor]
  );

  // WebSocket Connection Lifecycle
  useEffect(() => {
    loadSharedFiles();

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/`;
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      ws.send(
        JSON.stringify({
          type: 'register',
          id: myId,
          name: getDeviceName(),
          fresh: isFreshPageLoadRef.current,
        })
      );
      isFreshPageLoadRef.current = false;
    };

    ws.onmessage = (e) => {
      let msg: any;
      try {
        msg = JSON.parse(e.data);
      } catch (err) {
        return;
      }

      if (msg.type === 'registered') {
        lastEpochRef.current = msg.epoch || 0;
        if (!msg.approved) {
          setStatusText('Waiting for approval from presenter...');
          setConnBadge({ text: 'Pending', type: 'blocked' });
        } else {
          setStatusText('Approved! Waiting for stream...');
          setConnBadge({ text: 'Approved', type: 'waiting' });
        }
      }

      if (msg.type === 'approved') {
        setStatusText('Approved! Waiting for stream...');
        setConnBadge({ text: 'Approved', type: 'waiting' });
      }

      if (msg.type === 'revoked') {
        setStatusText('Access revoked. Waiting for approval...');
        setConnBadge({ text: 'Blocked', type: 'blocked' });
        cleanupPc();
      }

      if (msg.type === 'kicked') {
        setStatusText('Kicked. Reconnecting...');
        setConnBadge({ text: 'Disconnected', type: 'blocked' });
        cleanupPc();
        setTimeout(() => sendWs('renegotiate', { id: myId }), 1000);
      }

      if (msg.type === 'offer') {
        lastEpochRef.current = msg.epoch;
        connectOffer(msg.offer);
      }

      if (msg.type === 'candidate') {
        if (pcRef.current && pcRef.current.remoteDescription) {
          pcRef.current.addIceCandidate(msg.candidate).catch(() => {});
        } else {
          candidateBufferRef.current.push(msg.candidate);
        }
      }

      if (msg.type === 'file-shared') {
        setSharedFiles((prev) => [msg, ...prev.filter((f) => f.id !== msg.id)]);
        setHasNewFile(true);
      }

      if (msg.type === 'file-removed') {
        setSharedFiles((prev) => prev.filter((f) => f.id !== msg.id));
      }

      if (msg.type === 'draw-approved') {
        setCanDraw(true);
      }

      if (msg.type === 'draw-revoked') {
        setCanDraw(false);
      }

      if (msg.type === 'draw-stroke') {
        renderIncomingStroke(msg);
      }

      if (msg.type === 'draw-clear') {
        if (drawCanvasRef.current) {
          const ctx = drawCanvasRef.current.getContext('2d');
          if (ctx) ctx.clearRect(0, 0, drawCanvasRef.current.width, drawCanvasRef.current.height);
        }
      }

      if (msg.type === 'chat-reply') {
        setChatMessages((prev) => [...prev, { who: 'teacher', text: msg.text, label: 'Presenter' }]);
        setHasNewChat(true);
      }
    };

    return () => {
      cleanupPc();
      ws.close();
    };
  }, [connectOffer, cleanupPc, loadSharedFiles, myId, sendWs]);

  // Resize Canvas to Match Letterboxed Video
  const resizeCanvas = useCallback(() => {
    if (!drawCanvasRef.current || !videoRef.current) return;
    const canvas = drawCanvasRef.current;
    const video = videoRef.current;
    const rect = video.getBoundingClientRect();
    canvas.width = rect.width;
    canvas.height = rect.height;
  }, []);

  const renderIncomingStroke = useCallback((msg: any) => {
    const canvas = drawCanvasRef.current;
    const video = videoRef.current;
    if (!canvas || !video) return;

    if (canvas.width === 0) resizeCanvas();
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const rect = canvas.getBoundingClientRect();
    const metrics = getLetterboxMetrics(rect.width, rect.height, video.videoWidth, video.videoHeight);

    const pts = msg.points || [];
    if (!pts.length) return;

    ctx.save();
    if (msg.tool === 'eraser') {
      ctx.globalCompositeOperation = 'destination-out';
      ctx.lineWidth = msg.lineWidth || 20;
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
  }, [resizeCanvas]);

  useEffect(() => {
    window.addEventListener('resize', resizeCanvas);
    return () => window.removeEventListener('resize', resizeCanvas);
  }, [resizeCanvas]);

  // Raise Hand Handler
  const toggleRaiseHand = () => {
    const next = !handRaised;
    setHandRaised(next);
    sendWs('raise-hand', { id: myId, raised: next });
  };

  // Keyboard Spacebar Shortcut for Raise Hand
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.code === 'Space') {
        const tag = (document.activeElement?.tagName || '').toUpperCase();
        if (tag === 'INPUT' || tag === 'TEXTAREA') return;
        e.preventDefault();
        toggleRaiseHand();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handRaised]);

  // Drawing Handlers
  const flushStroke = (phase: 'start' | 'draw' | 'end') => {
    if (!currentStrokeRef.current.length && phase === 'draw') return;
    sendWs('draw-stroke', {
      id: myId,
      points: currentStrokeRef.current,
      color: drawColor,
      lineWidth: drawSize,
      phase,
    });
    currentStrokeRef.current = [];
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!canDraw || !drawCanvasRef.current || !videoRef.current) return;
    isDrawingRef.current = true;
    const rect = drawCanvasRef.current.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;

    const metrics = getLetterboxMetrics(
      rect.width,
      rect.height,
      videoRef.current.videoWidth,
      videoRef.current.videoHeight
    );

    const norm = pixelToNormalized(px, py, metrics);
    currentStrokeRef.current = [norm];

    const ctx = drawCanvasRef.current.getContext('2d');
    if (ctx) {
      ctx.beginPath();
      ctx.moveTo(px, py);
      ctx.strokeStyle = drawColor;
      ctx.lineWidth = drawSize;
      ctx.lineCap = 'round';
    }
    flushStroke('start');
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!isDrawingRef.current || !canDraw || !drawCanvasRef.current || !videoRef.current) return;
    const rect = drawCanvasRef.current.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;

    const metrics = getLetterboxMetrics(
      rect.width,
      rect.height,
      videoRef.current.videoWidth,
      videoRef.current.videoHeight
    );

    const norm = pixelToNormalized(px, py, metrics);
    currentStrokeRef.current.push(norm);

    const ctx = drawCanvasRef.current.getContext('2d');
    if (ctx) {
      ctx.lineTo(px, py);
      ctx.stroke();
    }

    if (currentStrokeRef.current.length >= 8) {
      flushStroke('draw');
    }
  };

  const handlePointerUp = () => {
    if (!isDrawingRef.current) return;
    isDrawingRef.current = false;
    flushStroke('end');
  };

  const clearCanvas = () => {
    if (drawCanvasRef.current) {
      const ctx = drawCanvasRef.current.getContext('2d');
      if (ctx) ctx.clearRect(0, 0, drawCanvasRef.current.width, drawCanvasRef.current.height);
    }
    sendWs('draw-clear', { id: myId });
  };

  const handleSendChat = () => {
    if (!chatInput.trim()) return;
    sendWs('chat-message', { id: myId, text: chatInput.trim() });
    setChatMessages((prev) => [...prev, { who: 'me', text: chatInput.trim(), label: 'You' }]);
    setChatInput('');
  };

  const toggleFullscreen = async () => {
    if (!containerRef.current) return;
    try {
      if (!document.fullscreenElement) {
        await containerRef.current.requestFullscreen();
        setIsFullscreen(true);
      } else {
        await document.exitFullscreen();
        setIsFullscreen(false);
      }
    } catch (e) {}
  };

  return (
    <div
      ref={containerRef}
      className="relative flex h-screen w-full flex-col items-center justify-center bg-black overflow-hidden select-none"
    >
      {/* Video Container */}
      <div className="relative flex h-full w-full items-center justify-center bg-black">
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted
          onLoadedMetadata={resizeCanvas}
          className="h-full w-full object-contain"
        />

        {/* Doodle Overlay */}
        <canvas
          ref={drawCanvasRef}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          className={`absolute inset-0 h-full w-full touch-none z-10 ${
            canDraw ? 'cursor-crosshair pointer-events-auto' : 'pointer-events-none'
          }`}
        />

        {/* Dedicated TV Receiver Top Overlay Header */}
        <div className="absolute top-4 left-4 right-4 z-20 flex items-center justify-between gap-3 pointer-events-none">
          {/* Top Left: TV Status Badge */}
          <div className="flex items-center gap-2 pointer-events-auto">
            <div className="flex items-center gap-2 rounded-2xl bg-zinc-950/85 px-3.5 py-2 text-xs font-semibold text-zinc-200 backdrop-blur-xl border border-zinc-800/90 shadow-2xl">
              <div className="flex h-6 w-6 items-center justify-center rounded-lg bg-blue-600/30 text-blue-400 border border-blue-500/30">
                <Tv className="w-3.5 h-3.5" />
              </div>
              <div>
                <div className="flex items-center gap-1.5 font-bold text-white text-xs">
                  TV Receiver
                  <span className="rounded-full bg-emerald-500/20 px-2 py-0.2 text-[9px] font-bold text-emerald-400 border border-emerald-500/30">
                    /tv
                  </span>
                </div>
                {statusText ? (
                  <p className="text-[10px] text-zinc-400">{statusText}</p>
                ) : (
                  <p className="text-[10px] text-emerald-400 font-mono">Stream Active</p>
                )}
              </div>
            </div>
          </div>

          {/* Top Right: Actions & Latency */}
          <div className="flex items-center gap-2 pointer-events-auto">
            <div className="hidden sm:flex items-center gap-1.5 rounded-2xl bg-zinc-950/85 px-3 py-2 font-mono text-xs text-zinc-300 backdrop-blur-xl border border-zinc-800/90 shadow-2xl">
              <Wifi className="w-3.5 h-3.5 text-emerald-400" />
              <span>{latencyText}</span>
            </div>

            {onOpenShareModal && (
              <button
                onClick={onOpenShareModal}
                className="flex items-center gap-1.5 rounded-2xl bg-zinc-950/85 px-3 py-2 text-xs font-semibold text-zinc-300 hover:text-white backdrop-blur-xl border border-zinc-800/90 hover:bg-zinc-900 transition-all shadow-2xl"
                title="Share QR code / TV Link"
              >
                <Share2 className="w-3.5 h-3.5 text-blue-400" />
                <span className="hidden sm:inline">TV QR</span>
              </button>
            )}

            <a
              href="/"
              className="flex items-center gap-1.5 rounded-2xl bg-zinc-950/85 px-3 py-2 text-xs font-semibold text-zinc-300 hover:text-white backdrop-blur-xl border border-zinc-800/90 hover:bg-zinc-900 transition-all shadow-2xl"
              title="Open Presenter Studio dashboard"
            >
              <Monitor className="w-3.5 h-3.5 text-indigo-400" />
              <span className="hidden sm:inline">Presenter Studio</span>
            </a>
          </div>
        </div>

        {/* Connection Badge Bottom Left */}
        <div className="absolute bottom-4 left-4 z-20 flex items-center gap-2">
          <span
            className={`flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-bold border backdrop-blur-md ${
              connBadge.type === 'live'
                ? 'bg-emerald-950/80 text-emerald-400 border-emerald-500/30'
                : connBadge.type === 'warn'
                ? 'bg-amber-950/80 text-amber-400 border-amber-500/30'
                : 'bg-red-950/80 text-red-400 border-red-500/30'
            }`}
          >
            ● {connBadge.text}
          </span>
          <button
            onClick={() => sendWs('renegotiate', { id: myId })}
            className="flex items-center gap-1 rounded-full bg-zinc-900/80 px-2.5 py-1 text-xs font-medium text-zinc-300 hover:text-white border border-zinc-800 backdrop-blur-md transition-colors"
          >
            <RefreshCw className="w-3 h-3" /> Reconnect
          </button>
        </div>

        {/* Floating Interactivity Bar (Center Bottom) */}
        <div className="absolute bottom-4 z-30 flex items-center gap-2 rounded-2xl bg-zinc-950/90 p-2 border border-zinc-800/80 backdrop-blur-md shadow-2xl">
          {/* Raise Hand Button */}
          <button
            onClick={toggleRaiseHand}
            className={`flex items-center gap-2 rounded-xl px-4 py-2 text-xs font-bold transition-all ${
              handRaised
                ? 'bg-amber-500 text-black shadow-lg shadow-amber-500/30'
                : 'bg-zinc-800/80 text-zinc-200 hover:bg-zinc-700 hover:text-white'
            }`}
            title="Press Spacebar to Raise Hand"
          >
            <Hand className="w-4 h-4" />
            {handRaised ? 'Hand Raised' : 'Raise Hand'}
          </button>

          {/* Message Teacher Button */}
          <button
            onClick={() => {
              setIsChatOpen(!isChatOpen);
              setHasNewChat(false);
            }}
            className="relative flex items-center gap-2 rounded-xl bg-zinc-800/80 px-3.5 py-2 text-xs font-semibold text-zinc-200 hover:bg-zinc-700 hover:text-white transition-all"
          >
            <MessageSquare className="w-4 h-4 text-blue-400" />
            <span>Chat</span>
            {hasNewChat && (
              <span className="absolute -top-1 -right-1 flex h-3 w-3 rounded-full bg-blue-500 animate-ping" />
            )}
          </button>

          {/* Shared Files Button */}
          <button
            onClick={() => {
              setIsFilesOpen(!isFilesOpen);
              setHasNewFile(false);
            }}
            className="relative flex items-center gap-2 rounded-xl bg-zinc-800/80 px-3.5 py-2 text-xs font-semibold text-zinc-200 hover:bg-zinc-700 hover:text-white transition-all"
          >
            <FolderDown className="w-4 h-4 text-indigo-400" />
            <span>Files</span>
            {sharedFiles.length > 0 && (
              <span className="rounded-full bg-blue-600 px-1.5 py-0.5 text-[10px] font-bold text-white">
                {sharedFiles.length}
              </span>
            )}
            {hasNewFile && (
              <span className="absolute -top-1 -right-1 flex h-3 w-3 rounded-full bg-indigo-500 animate-ping" />
            )}
          </button>

          {/* Fullscreen Button */}
          <button
            onClick={toggleFullscreen}
            className="rounded-xl bg-zinc-800/80 p-2 text-zinc-300 hover:bg-zinc-700 hover:text-white transition-colors"
          >
            {isFullscreen ? <Minimize className="w-4 h-4" /> : <Maximize className="w-4 h-4" />}
          </button>
        </div>

        {/* Drawing Toolbar (When Drawing is Approved) */}
        {canDraw && (
          <div className="absolute top-4 z-30 flex items-center gap-2 rounded-2xl bg-zinc-950/90 p-2.5 border border-emerald-500/30 backdrop-blur-md shadow-2xl">
            <span className="flex items-center gap-1 text-xs font-bold text-emerald-400 px-2">
              <Pencil className="w-3.5 h-3.5" /> Drawing Active
            </span>
            <div className="flex items-center gap-1.5 border-l border-zinc-800 pl-2">
              {['#ef4444', '#3b82f6', '#22c55e', '#facc15', '#ffffff'].map((color) => (
                <button
                  key={color}
                  onClick={() => setDrawColor(color)}
                  style={{ backgroundColor: color }}
                  className={`h-5 w-5 rounded-full border-2 transition-transform ${
                    drawColor === color ? 'border-white scale-110 shadow-md' : 'border-transparent opacity-80'
                  }`}
                />
              ))}
            </div>
            <button
              onClick={clearCanvas}
              className="rounded-lg bg-zinc-800 px-2.5 py-1 text-xs font-semibold text-zinc-300 hover:bg-zinc-700 hover:text-white transition-colors ml-1"
            >
              Clear
            </button>
          </div>
        )}
      </div>

      {/* Chat Drawer */}
      {isChatOpen && (
        <div className="absolute bottom-16 right-4 z-40 flex h-80 w-80 flex-col rounded-2xl bg-zinc-900 border border-zinc-800 shadow-2xl overflow-hidden">
          <div className="flex items-center justify-between border-b border-zinc-800 px-4 py-3 bg-zinc-950">
            <div className="flex items-center gap-2 font-bold text-xs text-white">
              <MessageSquare className="w-4 h-4 text-blue-400" /> Message Presenter
            </div>
            <button
              onClick={() => setIsChatOpen(false)}
              className="rounded-lg p-1 text-zinc-400 hover:bg-zinc-800 hover:text-white"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          <div className="flex-1 overflow-y-auto p-3 space-y-2 text-xs">
            {chatMessages.length === 0 ? (
              <p className="text-center text-zinc-500 py-8">No messages yet. Ask your presenter a question!</p>
            ) : (
              chatMessages.map((m, idx) => (
                <div
                  key={idx}
                  className={`flex flex-col ${m.who === 'me' ? 'items-end' : 'items-start'}`}
                >
                  <span className="text-[10px] text-zinc-500 mb-0.5">{m.label}</span>
                  <div
                    className={`rounded-xl px-3 py-2 max-w-[85%] ${
                      m.who === 'me'
                        ? 'bg-blue-600 text-white rounded-br-none'
                        : 'bg-zinc-800 text-zinc-200 rounded-bl-none'
                    }`}
                  >
                    {m.text}
                  </div>
                </div>
              ))
            )}
          </div>

          <div className="flex items-center gap-2 border-t border-zinc-800 p-2.5 bg-zinc-950">
            <input
              type="text"
              value={chatInput}
              onChange={(e) => setChatInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleSendChat()}
              placeholder="Type a message..."
              className="flex-1 rounded-xl bg-zinc-900 border border-zinc-800 px-3 py-1.5 text-xs text-zinc-100 focus:border-blue-500 focus:outline-none"
            />
            <button
              onClick={handleSendChat}
              className="rounded-xl bg-blue-600 p-2 text-white hover:bg-blue-500 transition-colors"
            >
              <Send className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      )}

      {/* Files Drawer */}
      {isFilesOpen && (
        <div className="absolute bottom-16 right-4 z-40 flex h-80 w-80 flex-col rounded-2xl bg-zinc-900 border border-zinc-800 shadow-2xl overflow-hidden">
          <div className="flex items-center justify-between border-b border-zinc-800 px-4 py-3 bg-zinc-950">
            <div className="flex items-center gap-2 font-bold text-xs text-white">
              <FolderDown className="w-4 h-4 text-indigo-400" /> Files from Presenter
            </div>
            <button
              onClick={() => setIsFilesOpen(false)}
              className="rounded-lg p-1 text-zinc-400 hover:bg-zinc-800 hover:text-white"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          <div className="flex-1 overflow-y-auto p-3 space-y-2 text-xs">
            {sharedFiles.length === 0 ? (
              <p className="text-center text-zinc-500 py-8">No files shared yet by presenter.</p>
            ) : (
              sharedFiles.map((f) => (
                <div
                  key={f.id}
                  className="flex items-center justify-between rounded-xl bg-zinc-950 p-2.5 border border-zinc-800/80"
                >
                  <div className="flex-1 min-w-0 pr-2">
                    <p className="font-semibold text-zinc-200 truncate">{f.name}</p>
                    <p className="text-[10px] text-zinc-500">{formatBytes(f.size)}</p>
                  </div>
                  <a
                    href={`/api/files/${f.id}`}
                    download
                    className="flex items-center gap-1 rounded-lg bg-blue-600 px-2.5 py-1 text-[11px] font-bold text-white hover:bg-blue-500 transition-colors shadow-sm"
                  >
                    <Download className="w-3 h-3" /> Save
                  </a>
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
};
