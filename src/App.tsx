import React, { useState, useEffect } from 'react';
import { Navbar } from './components/Navbar';
import { PresenterStudio } from './components/PresenterStudio';
import { TvReceiver } from './components/TvReceiver';
import { ShareModal } from './components/ShareModal';
import { AppConfig } from './types';

export default function App() {
  const [mode, setMode] = useState<'presenter' | 'receiver'>(() => {
    if (window.location.pathname.startsWith('/tv')) {
      return 'receiver';
    }
    return 'presenter';
  });

  const [isShareModalOpen, setIsShareModalOpen] = useState(false);
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [isStreaming, setIsStreaming] = useState(false);
  const [connectedCount, setConnectedCount] = useState(0);

  // Fetch configuration
  useEffect(() => {
    fetch('/api/config')
      .then((res) => res.json())
      .then((data) => setConfig(data))
      .catch((err) => console.warn('Could not fetch app config', err));
  }, []);

  const handleModeChange = (newMode: 'presenter' | 'receiver') => {
    setMode(newMode);
    if (newMode === 'receiver') {
      window.history.pushState({}, '', '/tv');
    } else {
      window.history.pushState({}, '', '/');
    }
  };

  const tvUrl = config?.tvUrl || `${window.location.origin}/tv`;

  return (
    <div className="min-h-screen bg-zinc-950 font-sans text-zinc-100 antialiased selection:bg-blue-600 selection:text-white">
      <Navbar
        mode={mode}
        onModeChange={handleModeChange}
        onOpenShare={() => setIsShareModalOpen(true)}
        isStreaming={isStreaming}
        connectedCount={connectedCount}
      />

      <main className="w-full">
        {mode === 'presenter' ? (
          <PresenterStudio
            onOpenShareModal={() => setIsShareModalOpen(true)}
            onStreamStateChange={(streaming, count) => {
              setIsStreaming(streaming);
              setConnectedCount(count);
            }}
          />
        ) : (
          <TvReceiver onOpenShareModal={() => setIsShareModalOpen(true)} />
        )}
      </main>

      <ShareModal
        tvUrl={tvUrl}
        isOpen={isShareModalOpen}
        onClose={() => setIsShareModalOpen(false)}
      />
    </div>
  );
}
