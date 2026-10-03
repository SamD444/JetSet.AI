import React from 'react';
import { JettyState } from '../../store/copilotStore';
import './JettyMascot.css';

interface JettyMascotProps {
  state: JettyState;
  size?: 'small' | 'medium' | 'large';
  onClick?: () => void;
  onMouseEnter?: () => void;
  onMouseLeave?: () => void;
  className?: string;
}

export const JettyMascot: React.FC<JettyMascotProps> = ({
  state,
  size = 'medium',
  onClick,
  onMouseEnter,
  onMouseLeave,
  className = ''
}) => {
  const sizeClasses = {
    small: 'w-10 h-10',
    medium: 'w-16 h-16 md:w-20 md:h-20',
    large: 'w-24 h-24 md:w-32 md:h-32'
  };

  const getMascotSrc = (st: JettyState): string => {
    switch (st) {
      case 'greeting':
        return '/mascot/jetty-wave.png';
      case 'hover':
        return '/mascot/jetty-happy.png';
      case 'thinking':
        return '/mascot/jetty-thinking.png';
      case 'talking':
        return '/mascot/jetty-talking.png';
      case 'listening':
        return '/mascot/jetty-listening.png';
      case 'happy':
        return '/mascot/jetty-happy.png';
      case 'excited':
        return '/mascot/jetty-excited.png';
      case 'confused':
        return '/mascot/jetty-confused.png';
      case 'error':
        return '/mascot/jetty-error.png';
      case 'sleepy':
        return '/mascot/jetty-sleepy.png';
      case 'idle':
      default:
        return '/mascot/jetty-idle.png';
    }
  };

  return (
    <div 
      className={`relative inline-block ${sizeClasses[size]} ${className}`}
      onClick={onClick}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      role={onClick ? 'button' : 'img'}
      tabIndex={onClick ? 0 : undefined}
      onKeyDown={(e) => {
        if (onClick && (e.key === 'Enter' || e.key === ' ')) {
          e.preventDefault();
          onClick();
        }
      }}
      aria-label="Jetty - JetSet.AI's Personal Travel Copilot"
    >
      <div className={`w-full h-full relative jetty-${state} transition-opacity duration-300`}>
        {/* Render the specific mascot state image */}
        <img 
          src={getMascotSrc(state)} 
          alt={`Jetty is ${state}`}
          className="w-full h-full object-contain drop-shadow-2xl"
          onError={(e) => {
            const target = e.target as HTMLImageElement;
            if (!target.src.endsWith('/mascot/jetty-idle.png')) {
              target.src = '/mascot/jetty-idle.png';
            }
          }}
        />

        {/* State-specific decorations */}
        {state === 'thinking' && (
          <div className="absolute -top-1 left-1/2 -translate-x-1/2 jetty-dots">
            <span></span><span></span><span></span>
          </div>
        )}
        
        {state === 'excited' && (
          <>
            <div className="jetty-sparkle"></div>
            <div className="jetty-sparkle"></div>
            <div className="jetty-sparkle"></div>
          </>
        )}
        
        {state === 'sleepy' && (
          <div className="absolute -top-2 right-0 text-sky-300 font-bold text-xs opacity-70 animate-pulse">
            Zzz
          </div>
        )}
      </div>
    </div>
  );
};
