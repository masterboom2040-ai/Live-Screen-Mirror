import React, { useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { Copy, Check, Tv, ExternalLink, X, Smartphone, Monitor } from 'lucide-react';

interface ShareModalProps {
  tvUrl: string;
  isOpen: boolean;
  onClose: () => void;
}

export const ShareModal: React.FC<ShareModalProps> = ({ tvUrl, isOpen, onClose }) => {
  const [copied, setCopied] = useState(false);

  if (!isOpen) return null;

  const handleCopy = () => {
    navigator.clipboard.writeText(tvUrl).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4">
      <div className="relative w-full max-w-lg rounded-2xl bg-zinc-900 border border-zinc-800 p-6 text-zinc-100 shadow-2xl">
        <button
          onClick={onClose}
          className="absolute top-4 right-4 rounded-full p-2 text-zinc-400 hover:bg-zinc-800 hover:text-white transition-colors"
        >
          <X className="w-5 h-5" />
        </button>

        <div className="flex items-center gap-3 mb-4">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-blue-600/20 text-blue-400 border border-blue-500/30">
            <Tv className="w-5 h-5" />
          </div>
          <div>
            <h3 className="text-lg font-bold text-white">Connect TV / Receiver Device</h3>
            <p className="text-xs text-zinc-400">Scan or open link on TV, phone, or second display</p>
          </div>
        </div>

        <div className="flex flex-col items-center justify-center p-6 bg-zinc-950 rounded-xl border border-zinc-800/80 mb-5">
          <div className="p-3 bg-white rounded-xl shadow-lg">
            <QRCodeSVG value={tvUrl || window.location.href} size={160} level="M" />
          </div>
          <p className="mt-3 text-xs text-zinc-400 flex items-center gap-1.5">
            <Smartphone className="w-3.5 h-3.5 text-blue-400" />
            Scan QR code with phone or TV camera
          </p>
        </div>

        <div className="space-y-3">
          <label className="text-xs font-medium text-zinc-400">Direct Receiver URL</label>
          <div className="flex items-center gap-2 rounded-xl bg-zinc-950 border border-zinc-800 p-2 pl-3">
            <span className="flex-1 font-mono text-xs text-blue-400 truncate">{tvUrl}</span>
            <button
              onClick={handleCopy}
              className="flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-blue-500 transition-colors shadow-sm"
            >
              {copied ? (
                <>
                  <Check className="w-3.5 h-3.5" /> Copied!
                </>
              ) : (
                <>
                  <Copy className="w-3.5 h-3.5" /> Copy
                </>
              )}
            </button>
            <a
              href={tvUrl}
              target="_blank"
              rel="noreferrer"
              className="rounded-lg bg-zinc-800 p-1.5 text-zinc-300 hover:bg-zinc-700 hover:text-white transition-colors"
              title="Open Receiver in new tab"
            >
              <ExternalLink className="w-4 h-4" />
            </a>
          </div>
        </div>

        <div className="mt-5 rounded-xl bg-zinc-950/60 p-3.5 border border-zinc-800/60 text-xs text-zinc-400 space-y-1.5">
          <div className="flex items-center gap-2 font-medium text-zinc-300">
            <Monitor className="w-4 h-4 text-emerald-400" /> Quick Instructions
          </div>
          <ol className="list-decimal list-inside space-y-1 text-zinc-400 pl-1">
            <td>Open the TV URL on any browser (Smart TV, tablet, phone, PC)</td>
            <td>Click "Allow / Approve" in your Presenter dashboard below</td>
            <td>Enjoy zero-latency live screen mirroring & interaction</td>
          </ol>
        </div>
      </div>
    </div>
  );
};
