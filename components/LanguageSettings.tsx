import React from 'react';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  langA: string;
  setLangA: (lang: string) => void;
  langB: string;
  setLangB: (lang: string) => void;
  disabled: boolean;
}

const LANGUAGES = [
  'English',
  'Chinese',
  'Spanish',
  'French',
  'German',
  'Japanese',
  'Korean',
  'Russian',
  'Portuguese',
  'Italian',
  'Hindi',
  'Arabic',
  'Turkish',
  'Vietnamese'
];

const LanguageSettings: React.FC<Props> = ({ 
  isOpen, 
  onClose, 
  langA, 
  setLangA, 
  langB, 
  setLangB,
  disabled
}) => {
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 backdrop-blur-sm animate-in fade-in duration-200">
      <div className="bg-gray-900 border border-gray-700 rounded-2xl p-6 w-full max-w-md shadow-2xl scale-100 animate-in zoom-in-95 duration-200">
        <div className="flex justify-between items-center mb-6">
          <h2 className="text-xl font-bold text-white">Conversation Settings</h2>
          <button 
            onClick={onClose}
            className="text-gray-400 hover:text-white transition-colors"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
          </button>
        </div>

        <div className="space-y-6">
          <div className="bg-blue-900/20 border border-blue-800/50 rounded-lg p-4 mb-4">
             <p className="text-sm text-blue-200">
               Select the two languages being spoken. The AI will automatically detect and translate between them.
             </p>
          </div>

          <div className="space-y-2">
            <label className="block text-sm font-medium text-gray-300">Language 1</label>
            <div className="relative">
              <select
                value={langA}
                onChange={(e) => setLangA(e.target.value)}
                disabled={disabled}
                className="w-full bg-gray-800 border border-gray-700 text-white rounded-lg px-4 py-3 appearance-none focus:ring-2 focus:ring-blue-500 focus:outline-none disabled:opacity-50"
              >
                {LANGUAGES.map(lang => (
                  <option key={`a-${lang}`} value={lang} disabled={lang === langB}>
                    {lang}
                  </option>
                ))}
              </select>
              <div className="absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none text-gray-400">
                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m6 9 6 6 6-6"/></svg>
              </div>
            </div>
          </div>

          <div className="flex justify-center">
            <div className="p-2 rounded-full bg-gray-800 text-gray-400">
              <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M7.5 21 3 16.5m0 0L7.5 12M3 16.5h13.5m0-13.5L21 7.5m0 0L16.5 12M21 7.5H7.5"/></svg>
            </div>
          </div>

          <div className="space-y-2">
            <label className="block text-sm font-medium text-gray-300">Language 2</label>
            <div className="relative">
              <select
                value={langB}
                onChange={(e) => setLangB(e.target.value)}
                disabled={disabled}
                className="w-full bg-gray-800 border border-gray-700 text-white rounded-lg px-4 py-3 appearance-none focus:ring-2 focus:ring-blue-500 focus:outline-none disabled:opacity-50"
              >
                {LANGUAGES.map(lang => (
                  <option key={`b-${lang}`} value={lang} disabled={lang === langA}>
                    {lang}
                  </option>
                ))}
              </select>
              <div className="absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none text-gray-400">
                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m6 9 6 6 6-6"/></svg>
              </div>
            </div>
          </div>
        </div>

        <div className="mt-8">
          <button
            onClick={onClose}
            className="w-full bg-blue-600 hover:bg-blue-700 text-white font-semibold py-3 rounded-lg transition-colors"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
};

export default LanguageSettings;