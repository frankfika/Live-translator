import React, { useState, useEffect, useRef } from 'react';
import { ConnectionStatus, SubtitleMessage } from '@/types';
import { LiveClient } from '@/services/liveClient';
import AudioVisualizer from '@/components/AudioVisualizer';
import SubtitleCard from '@/components/SubtitleCard';
import LanguageSettings from '@/components/LanguageSettings';

const API_KEY = import.meta.env.VITE_GEMINI_API_KEY || '';

const App: React.FC = () => {
  const [status, setStatus] = useState<ConnectionStatus>(ConnectionStatus.DISCONNECTED);
  const [messages, setMessages] = useState<SubtitleMessage[]>([]);
  const [currentOriginal, setCurrentOriginal] = useState('');
  const [currentTranslated, setCurrentTranslated] = useState('');
  const [stream, setStream] = useState<MediaStream | null>(null);
  
  // Language State
  const [langA, setLangA] = useState('English');
  const [langB, setLangB] = useState('Chinese');
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  
  // Refs to hold streaming data to avoid stale closures in callbacks
  const currentOriginalRef = useRef('');
  const currentTranslatedRef = useRef('');
  const liveClientRef = useRef<LiveClient | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  
  // Auto-scroll to bottom
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, currentOriginal, currentTranslated]);

  const handleStart = async () => {
    if (!API_KEY) {
      alert("Please provide a valid API KEY in the environment variables.");
      return;
    }
    
    setStatus(ConnectionStatus.CONNECTING);
    const client = new LiveClient(API_KEY);
    liveClientRef.current = client;

    // Construct the system instruction based on selected languages
    const systemInstruction = `你是一名专业同声传译。请在两种语言之间互译：如果输入是${langA}，则译为${langB}；如果输入是${langB}，则译为${langA}。直接输出翻译结果，不要添加任何解释。`;

    await client.connect(
      { systemInstruction }, 
      {
        onOpen: () => {
          setStatus(ConnectionStatus.CONNECTED);
          setStream(client.getStream());
        },
        onClose: () => {
          setStatus(ConnectionStatus.DISCONNECTED);
          setStream(null);
          resetBuffers();
        },
        onError: (err) => {
          console.error(err);
          setStatus(ConnectionStatus.ERROR);
          setStream(null);
          resetBuffers();
        },
        onInputTranscription: (text) => {
          currentOriginalRef.current += text;
          setCurrentOriginal(currentOriginalRef.current);
        },
        onOutputTranscription: (text) => {
          currentTranslatedRef.current += text;
          setCurrentTranslated(currentTranslatedRef.current);
        },
        onTurnComplete: () => {
          const originalText = currentOriginalRef.current;
          const translatedText = currentTranslatedRef.current;

          if (originalText.trim() || translatedText.trim()) {
            setMessages(prev => [
              ...prev, 
              {
                id: Date.now().toString(),
                original: originalText,
                translated: translatedText,
                isFinal: true,
                timestamp: Date.now()
              }
            ]);
          }

          resetBuffers();
        },
        onAudioData: () => {} // Visualizer handles its own stream
      }
    );
  };

  const resetBuffers = () => {
    currentOriginalRef.current = '';
    currentTranslatedRef.current = '';
    setCurrentOriginal('');
    setCurrentTranslated('');
  };

  const handleStop = async () => {
    if (liveClientRef.current) {
      await liveClientRef.current.disconnect();
      liveClientRef.current = null;
    }
    setStatus(ConnectionStatus.DISCONNECTED);
    resetBuffers();
  };

  const handleReset = () => {
    setMessages([]);
    resetBuffers();
  };
  
  return (
    <div className="relative min-h-screen bg-gray-950 flex flex-col items-center">
      
      {/* Top Bar / Controls */}
      <div className="fixed top-0 left-0 right-0 z-50 p-4 flex justify-between items-center glass-panel border-b border-gray-800">
        <div className="flex items-center gap-3">
            <div className={`w-3 h-3 rounded-full ${status === ConnectionStatus.CONNECTED ? 'bg-green-500 animate-pulse' : 'bg-red-500'}`} />
            <h1 className="text-xl font-bold bg-clip-text text-transparent bg-gradient-to-r from-blue-400 to-purple-500 hidden sm:block">
                Gemini Live Subtitles
            </h1>
            <h1 className="text-xl font-bold text-white sm:hidden">
                Live Subtitles
            </h1>
        </div>
        
        <div className="flex items-center gap-2 sm:gap-4">
             {/* Settings Button */}
             <button 
                onClick={() => setIsSettingsOpen(true)}
                disabled={status === ConnectionStatus.CONNECTED || status === ConnectionStatus.CONNECTING}
                className="p-2 rounded-full text-gray-400 hover:text-white hover:bg-gray-800 transition-all disabled:opacity-30 disabled:cursor-not-allowed"
                title="Language Settings"
             >
                <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.09a2 2 0 0 1-1-1.74v-.47a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.39a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"></path><circle cx="12" cy="12" r="3"></circle></svg>
             </button>

             {/* Reset/Clear Button */}
             <button 
                onClick={handleReset}
                className="p-2 rounded-full text-gray-400 hover:text-white hover:bg-gray-800 transition-all"
                title="Clear History"
             >
                <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg>
             </button>

             <div className="h-6 w-px bg-gray-700 mx-1"></div>

             {status === ConnectionStatus.CONNECTED ? (
                 <button 
                    onClick={handleStop}
                    className="px-6 py-2 rounded-full bg-red-600 hover:bg-red-700 text-white font-semibold transition-all shadow-lg hover:shadow-red-900/50"
                 >
                    Stop
                 </button>
             ) : (
                 <button 
                    onClick={handleStart}
                    disabled={status === ConnectionStatus.CONNECTING}
                    className="px-6 py-2 rounded-full bg-blue-600 hover:bg-blue-700 text-white font-semibold transition-all shadow-lg hover:shadow-blue-900/50 disabled:opacity-50"
                 >
                    {status === ConnectionStatus.CONNECTING ? 'Connecting...' : 'Start'}
                 </button>
             )}
        </div>
      </div>

      {/* Main Subtitle Area */}
      <div className="flex-1 w-full max-w-4xl px-6 pt-24 pb-40 flex flex-col justify-end min-h-screen">
        
        {/* Welcome Message */}
        {messages.length === 0 && !currentOriginal && !currentTranslated && (
             <div className="text-center text-gray-500 my-auto animate-in fade-in duration-700">
                 <div className="mb-6 flex justify-center gap-4 text-4xl opacity-30">
                    <span>🗣️</span>
                    <span>⇄</span>
                    <span>🎧</span>
                 </div>
                 <p className="text-2xl mb-2 font-light">Real-time Interpretation</p>
                 <p className="text-sm mb-6">Press "Start" to begin interpreting between <span className="text-blue-400 font-semibold">{langA}</span> and <span className="text-purple-400 font-semibold">{langB}</span>.</p>
                 
                 <div className="inline-block px-4 py-2 rounded-lg bg-gray-900 border border-gray-800 text-xs text-gray-400">
                    Tip: Click the gear icon ⚙️ to change languages.
                 </div>
             </div>
        )}

        {/* History */}
        {messages.map((msg, idx) => (
            <SubtitleCard 
                key={msg.id} 
                message={msg} 
                isRecent={false} // History items fade back slightly
            />
        ))}

        {/* Current Active Turn */}
        {(currentOriginal || currentTranslated) && (
            <div className="animate-in fade-in slide-in-from-bottom-4 duration-300">
                <SubtitleCard 
                    message={{
                        id: 'current',
                        original: currentOriginal,
                        translated: currentTranslated,
                        isFinal: false,
                        timestamp: Date.now()
                    }}
                    isRecent={true}
                />
            </div>
        )}
        
        <div ref={bottomRef} />
      </div>

      {/* Bottom Visualizer Overlay */}
      <div className="fixed bottom-0 left-0 right-0 h-32 bg-gradient-to-t from-black via-gray-900/90 to-transparent pointer-events-none flex flex-col justify-end pb-6 px-4">
          <div className="w-full max-w-4xl mx-auto">
             <AudioVisualizer stream={stream} isActive={status === ConnectionStatus.CONNECTED} />
          </div>
      </div>

      {/* Language Settings Modal */}
      <LanguageSettings 
        isOpen={isSettingsOpen}
        onClose={() => setIsSettingsOpen(false)}
        langA={langA}
        setLangA={setLangA}
        langB={langB}
        setLangB={setLangB}
        disabled={status === ConnectionStatus.CONNECTED || status === ConnectionStatus.CONNECTING}
      />

    </div>
  );
};

export default App;
