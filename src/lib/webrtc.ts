import { IceServerConfig } from '../types';

export const STUN_SERVERS: IceServerConfig[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
];

export async function fetchIceServers(): Promise<IceServerConfig[]> {
  try {
    const res = await fetch('/api/turn-credentials');
    const data = await res.json();
    if (data && data.enabled && Array.isArray(data.iceServers)) {
      return [...STUN_SERVERS, ...data.iceServers];
    }
  } catch (e) {
    console.warn('Could not fetch TURN credentials, using STUN default', e);
  }
  return STUN_SERVERS;
}

export function targetEncodingFor(peerCount: number) {
  if (peerCount <= 1) return { maxBitrate: 4_000_000, maxFramerate: 30 };
  if (peerCount === 2) return { maxBitrate: 2_500_000, maxFramerate: 30 };
  if (peerCount <= 4) return { maxBitrate: 1_400_000, maxFramerate: 24 };
  return { maxBitrate: 900_000, maxFramerate: 20 };
}

export async function applyBitrateCap(pc: RTCPeerConnection, peerCount: number) {
  if (!pc) return;
  const sender = pc.getSenders?.().find((s) => s.track && s.track.kind === 'video');
  if (!sender) return;
  try {
    const params = sender.getParameters();
    if (!params.encodings || !params.encodings.length) {
      params.encodings = [{}];
    }
    const target = targetEncodingFor(peerCount);
    params.encodings[0].maxBitrate = target.maxBitrate;
    params.encodings[0].maxFramerate = target.maxFramerate;
    await sender.setParameters(params);
  } catch (e) {
    // Ignore parameter application race conditions before first negotiation
  }
}

/**
 * Calculates the exact rendered dimensions of a video inside an element with object-fit: contain.
 * Maps normalized coordinates (x: 0..1, y: 0..1 relative to video content) to canvas pixels.
 */
export function getLetterboxMetrics(
  containerWidth: number,
  containerHeight: number,
  videoWidth: number,
  videoHeight: number
) {
  if (!videoWidth || !videoHeight || !containerWidth || !containerHeight) {
    return {
      offsetX: 0,
      offsetY: 0,
      renderWidth: containerWidth,
      renderHeight: containerHeight,
    };
  }

  const containerRatio = containerWidth / containerHeight;
  const videoRatio = videoWidth / videoHeight;

  let renderWidth: number;
  let renderHeight: number;

  if (videoRatio > containerRatio) {
    renderWidth = containerWidth;
    renderHeight = containerWidth / videoRatio;
  } else {
    renderHeight = containerHeight;
    renderWidth = containerHeight * videoRatio;
  }

  const offsetX = (containerWidth - renderWidth) / 2;
  const offsetY = (containerHeight - renderHeight) / 2;

  return { offsetX, offsetY, renderWidth, renderHeight };
}

export function normalizedToPixel(
  normX: number,
  normY: number,
  metrics: { offsetX: number; offsetY: number; renderWidth: number; renderHeight: number }
) {
  return {
    x: metrics.offsetX + normX * metrics.renderWidth,
    y: metrics.offsetY + normY * metrics.renderHeight,
  };
}

export function pixelToNormalized(
  px: number,
  py: number,
  metrics: { offsetX: number; offsetY: number; renderWidth: number; renderHeight: number }
) {
  const normX = (px - metrics.offsetX) / metrics.renderWidth;
  const normY = (py - metrics.offsetY) / metrics.renderHeight;
  return {
    x: Math.max(0, Math.min(1, normX)),
    y: Math.max(0, Math.min(1, normY)),
  };
}

export function formatBytes(n: number) {
  if (n < 1024) return n + ' B';
  const units = ['KB', 'MB', 'GB'];
  let i = -1;
  do {
    n /= 1024;
    i++;
  } while (n >= 1024 && i < units.length - 1);
  return n.toFixed(1) + ' ' + units[i];
}
