import React from 'react';
import { Tv, Monitor, Share2, Sparkles, Circle } from 'lucide-react';

interface NavbarProps {
  mode: 'presenter' | 'receiver';
  onModeChange: (mode: 'presenter' | 'receiver') => void;
  onOpenShare: () => void;
  isStreaming?: boolean;
  connectedCount?: number;
}

export const Navbar: React.FC<NavbarProps> = ({
  mode,
  onModeChange,
  onOpenShare,
  isStreaming = false,
  connectedCount = 0,
}) => {
  return (
    <header className="sticky top-0 z-40 border-b border-zinc-800 bg-zinc-950/90 backdrop-blur-md px-4 py-3 text-zinc-100">
      <div className="mx-auto flex max-w-7xl items-center justify-between gap-4">
        {/* Logo & Title */}
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-tr from-blue-600 to-indigo-500 shadow-md shadow-blue-500/20 text-white font-bold">
            <Monitor className="w-5 h-5" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-base font-bold text-white tracking-tight">Live Screen Mirror</h1>
              <span className="rounded-full bg-blue-500/10 px-2 py-0.5 text-[10px] font-semibold text-blue-400 border border-blue-500/20">
                v5.0 Ultra
              </span>
            </div>
            <p className="text-[11px] text-zinc-400">Zero-latency WebRTC screen mirror & interactive studio</p>
          </div>
        </div>

        {/* Streaming Status Pill */}
        {isStreaming && (
          <div className="hidden sm:flex items-center gap-2 rounded-full bg-emerald-500/10 px-3 py-1 border border-emerald-500/20 text-xs text-emerald-400 font-medium">
            <Circle className="w-2.5 h-2.5 fill-emerald-500 animate-pulse text-emerald-500" />
            LIVE · {connectedCount} Viewers
          </div>
        )}

        {/* Mode Switcher & Share */}
        <div className="flex items-center gap-2">
          <div className="flex items-center rounded-xl bg-zinc-900 border border-zinc-800 p-1">
            <button
              onClick={() => onModeChange('presenter')}
              className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition-all ${
                mode === 'presenter'
                  ? 'bg-blue-600 text-white shadow-md shadow-blue-600/30'
                  : 'text-zinc-400 hover:text-white'
              }`}
            >
              <Monitor className="w-3.5 h-3.5" /> Presenter
            </button>
            <button
              onClick={() => onModeChange('receiver')}
              className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition-all ${
                mode === 'receiver'
                  ? 'bg-blue-600 text-white shadow-md shadow-blue-600/30'
                  : 'text-zinc-400 hover:text-white'
              }`}
            >
              <Tv className="w-3.5 h-3.5" /> TV Receiver
            </button>
          </div>

          <button
            onClick={onOpenShare}
            className="flex items-center gap-1.5 rounded-xl bg-zinc-800 border border-zinc-700/80 px-3 py-2 text-xs font-semibold text-zinc-200 hover:bg-zinc-700 hover:text-white transition-all shadow-sm"
          >
            <Share2 className="w-3.5 h-3.5 text-blue-400" /> Share TV Link
          </button>
        </div>
      </div>
    </header>
  );
};
