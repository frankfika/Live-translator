import React from 'react';
import { SubtitleMessage } from '../types';

interface Props {
  message: SubtitleMessage;
  isRecent: boolean;
}

const SubtitleCard: React.FC<Props> = ({ message, isRecent }) => {
  // If we only have original or translated so far, show what we have.
  // We want to highlight the most recent message.
  
  return (
    <div className={`mb-6 transition-all duration-500 ease-out ${isRecent ? 'opacity-100 scale-100' : 'opacity-60 scale-95'}`}>
      <div className="flex flex-col gap-2">
        {/* Original Language */}
        {message.original && (
          <div className="text-gray-400 text-lg font-medium tracking-wide">
            {message.original}
          </div>
        )}
        
        {/* Translated Language - The Hero */}
        <div className={`font-bold leading-tight transition-colors duration-300 ${isRecent ? 'text-white text-3xl md:text-4xl' : 'text-gray-300 text-2xl md:text-3xl'}`}>
           {message.translated || <span className="animate-pulse text-gray-600">...</span>}
        </div>
      </div>
    </div>
  );
};

export default SubtitleCard;