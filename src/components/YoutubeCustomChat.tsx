import React, { useState, useEffect, useRef, useMemo } from 'react';
import { AlertCircle } from 'lucide-react';
import type { UserSettings } from '../types/chat';
import { 
  resolveYoutubeChannelToVideoId, 
  resolveInitialChatData, 
  pollYoutubeChat, 
  parseYoutubeActions 
} from '../services/youtubeChat';
import type { YoutubeChatMessage } from '../services/youtubeChat';

interface YoutubeCustomChatProps {
  channel: string;
  settings: UserSettings;
}

export const YoutubeCustomChat: React.FC<YoutubeCustomChatProps> = ({ channel, settings }) => {
  const [messages, setMessages] = useState<YoutubeChatMessage[]>([]);
  const [channelStatus, setChannelStatus] = useState<'connecting' | 'connected' | 'error'>('connecting');
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const dripQueueRef = useRef<YoutubeChatMessage[]>([]);
  const dripActiveRef = useRef(false);
  const dripTimeoutRef = useRef<number>(0);
  const seenIdsRef = useRef<Set<string>>(new Set());
  const maxMessagesRef = useRef(settings.maxMessages);
  const ignoredUsersRef = useRef<string[]>((settings.ignoredUsers || []).map(u => u.toLowerCase()));
  const connectionStartTimeRef = useRef<number>(0);

  useEffect(() => { maxMessagesRef.current = settings.maxMessages; }, [settings.maxMessages]);
  useEffect(() => { ignoredUsersRef.current = (settings.ignoredUsers || []).map(u => u.toLowerCase()); }, [settings.ignoredUsers]);

  const cleanChannel = useMemo(() => channel.trim(), [channel]);

  // Drip processor: pops one message from the queue and adds it to state
  const processDripRef = useRef<() => void>(() => {});
  processDripRef.current = () => {
    if (dripQueueRef.current.length === 0) {
      dripActiveRef.current = false;
      return;
    }
    dripActiveRef.current = true;
    const msg = dripQueueRef.current.shift()!;
    setMessages(prev => {
      const combined = [...prev, msg];
      if (combined.length > maxMessagesRef.current) {
        return combined.slice(combined.length - maxMessagesRef.current);
      }
      return combined;
    });
    // Random delay 50-350ms for natural feel
    const delay = 50 + Math.random() * 300;
    dripTimeoutRef.current = window.setTimeout(() => processDripRef.current(), delay);
  };

  // Handle YouTube chat connection & polling
  useEffect(() => {
    if (!cleanChannel) return;

    connectionStartTimeRef.current = 0;

    setMessages([]);
    seenIdsRef.current = new Set();
    dripQueueRef.current = [];
    dripActiveRef.current = false;
    clearTimeout(dripTimeoutRef.current);
    setChannelStatus('connecting');
    setError(null);

    let active = true;
    let pollTimeout: any = null;

    const startChatResolving = async () => {
      try {
        let videoId = cleanChannel;
        const isHandle = cleanChannel.startsWith('@') || 
                         (cleanChannel.length !== 11 && 
                          !cleanChannel.includes('youtube.com') && 
                          !cleanChannel.includes('youtu.be'));
        
        if (isHandle) {
          videoId = await resolveYoutubeChannelToVideoId(cleanChannel);
        } else {
          const regExp = /^.*(youtu.be\/|v\/|u\/\w\/|embed\/|watch\?v=|\&v=)([^#\&\?]*).*/;
          const match = cleanChannel.match(regExp);
          videoId = (match && match[2].length === 11) ? match[2] : cleanChannel.trim();
        }

        if (!active) return;

        const { apiKey, initialContinuation, visitorData } = await resolveInitialChatData(videoId);
        
        if (!active) return;
        setChannelStatus('connected');

        let currentContinuation = initialContinuation;
        let isFirstPoll = true;

        const pollNext = async () => {
          if (!active) return;
          try {
            const data = await pollYoutubeChat(apiKey, currentContinuation, visitorData);
            if (!active) return;

            const { messages: newMsgs, nextContinuation, timeoutMs } = parseYoutubeActions(data);
            
            if (newMsgs.length > 0) {
              if (isFirstPoll) {
                // Find the latest timestamp of the history messages to establish our local epoch
                const maxTime = Math.max(...newMsgs.map(m => m.timestampRaw));
                connectionStartTimeRef.current = maxTime;
                
                // Add all history messages to seenIdsRef
                for (const msg of newMsgs) {
                  seenIdsRef.current.add(msg.id);
                }
              } else {
                const filteredNew = newMsgs.filter(m => {
                  if (seenIdsRef.current.has(m.id)) return false;
                  if (ignoredUsersRef.current.some(u => u === m.displayName.toLowerCase() || u === m.username.toLowerCase())) return false;
                  // Discard any message that is historically older than or equal to the initial load threshold
                  if (connectionStartTimeRef.current > 0 && m.timestampRaw <= connectionStartTimeRef.current) return false;
                  return true;
                });
                for (const msg of filteredNew) {
                  seenIdsRef.current.add(msg.id);
                  dripQueueRef.current.push(msg);
                }
                // Cap seen IDs so the set doesn't grow forever
                if (seenIdsRef.current.size > 2000) {
                  const arr = Array.from(seenIdsRef.current);
                  seenIdsRef.current = new Set(arr.slice(arr.length - 1000));
                }
                // Kick off drip processor if not already running
                if (!dripActiveRef.current && filteredNew.length > 0) {
                  processDripRef.current();
                }
              }
            }

            isFirstPoll = false;

            if (nextContinuation) {
              currentContinuation = nextContinuation;
            }

            const delay = timeoutMs !== undefined ? timeoutMs : 1000;
            pollTimeout = setTimeout(pollNext, delay);
          } catch (e: any) {
            console.error('YouTube chat poll error:', e);
            if (active) {
              setChannelStatus('error');
              setError('Lost connection to YouTube Live Chat API.');
            }
          }
        };

        pollNext();
      } catch (err: any) {
        console.error('YouTube initial resolution failed:', err);
        if (active) {
          setChannelStatus('error');
          setError((err.message || 'Could not connect to YouTube Chat.') + ' — retrying in 1 min...');
          // Retry every 60 seconds in case they go live
          pollTimeout = setTimeout(() => {
            if (active) {
              setChannelStatus('connecting');
              setError(null);
              startChatResolving();
            }
          }, 60000);
        }
      }
    };

    startChatResolving();

    return () => {
      active = false;
      if (pollTimeout) clearTimeout(pollTimeout);
      clearTimeout(dripTimeoutRef.current);
      dripQueueRef.current = [];
      dripActiveRef.current = false;
    };
  }, [cleanChannel]);

  // Auto-scroll to bottom on every new message (same as Twitch)
  useEffect(() => {
    const container = scrollRef.current;
    if (container) {
      container.scrollTop = container.scrollHeight;
    }
  }, [messages]);

  // Window focus listener to snap to bottom on return
  useEffect(() => {
    const container = scrollRef.current;
    if (!container) return;
    
    const handleFocus = () => {
      container.scrollTop = container.scrollHeight;
    };
    window.addEventListener('focus', handleFocus);
    document.addEventListener('visibilitychange', handleFocus);
    return () => {
      window.removeEventListener('focus', handleFocus);
      document.removeEventListener('visibilitychange', handleFocus);
    };
  }, []);



  if (!channel) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-slate-500 bg-slate-950/20 p-4">
        <AlertCircle className="w-8 h-8 text-slate-600 mb-2" />
        <p className="text-sm">Please set a YouTube handle/video URL in the split header.</p>
      </div>
    );
  }

  if (channelStatus === 'error') {
    return (
      <div className="flex flex-col items-center justify-center h-full text-slate-400 bg-slate-950 p-6 text-center">
        <div className="w-8 h-8 rounded-full bg-red-950/30 flex items-center justify-center text-red-500 mb-3 border border-red-900/20">
          ⚠️
        </div>
        <p className="text-xs font-semibold text-white mb-1">Could Not Load YouTube Chat</p>
        <p className="text-[11px] text-slate-500 max-w-[280px] leading-relaxed mb-4">
          {error}
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full bg-slate-950 text-slate-200 overflow-hidden">

      {/* Messages list */}
      <div 
        ref={scrollRef}
        className="flex-1 overflow-y-auto px-4 py-2 space-y-1.5 select-text scrollbar-thin scrollbar-thumb-slate-800 hover:scrollbar-thumb-slate-700 min-h-0"
        style={{ fontSize: `${settings.fontSize}px` }}
      >
        {messages.map((msg) => (
          <div 
            key={msg.id}
            className="group py-0.5 px-1.5 rounded transition-colors hover:bg-slate-900/30"
          >
            {/* Timestamp */}
            {settings.showTimestamps && (
              <span className="text-slate-500 text-[10px] font-mono mr-2.5 select-none align-middle">
                {msg.timestamp}
              </span>
            )}

            {/* Avatar image */}
            {msg.avatarUrl && (
              <img 
                src={msg.avatarUrl} 
                alt="" 
                className="w-4 h-4 rounded-full inline-block align-middle mr-2 select-none"
                style={{ width: '1.1em', height: '1.1em' }}
                onError={(e) => {
                  e.currentTarget.style.display = 'none';
                }}
              />
            )}

            {/* Badges */}
            {settings.showBadges && msg.badges.length > 0 && (
              <span className="inline-flex gap-1 mr-2 align-middle select-none">
                {msg.badges.map((badge, idx) => (
                  <img 
                    key={`${badge.name}-${idx}`} 
                    src={badge.url || (
                      badge.name === 'moderator' 
                        ? 'https://static-cdn.jtvnw.net/badges/v1/3267646d-33f0-4b17-b3df-f923a41db1d0/1' 
                        : 'https://static-cdn.jtvnw.net/badges/v1/552730c2-4d27-4a2d-a1ac-7cfbd421c501/1'
                    )} 
                    alt={badge.name}
                    title={badge.name}
                    style={{
                      width: '1.1em',
                      height: '1.1em',
                      borderRadius: '2px',
                      objectFit: 'contain',
                      display: 'inline-block',
                      verticalAlign: 'middle'
                    }}
                    onError={(e) => {
                      e.currentTarget.style.display = 'none';
                    }}
                  />
                ))}
              </span>
            )}

            {/* Username */}
            <span 
              className="font-semibold mr-2 align-middle cursor-pointer hover:underline text-[1.05em]"
              style={{ color: msg.color }}
              title={`Click to copy username: ${msg.username}`}
              onClick={() => {
                navigator.clipboard.writeText(msg.username);
              }}
            >
              {msg.displayName}
              {':'}
            </span>

            {/* Parsed Message Parts */}
            <span className="align-middle leading-[1.4] break-all text-slate-100">
              {msg.parts.map((part, idx) => {
                if (part.type === 'emote') {
                  return (
                    <img 
                      key={idx} 
                      src={part.url} 
                      alt={part.content} 
                      title={part.content}
                      style={{
                        height: '1.6em',
                        display: 'inline-block',
                        verticalAlign: 'middle',
                        marginTop: '-0.3em',
                        marginBottom: '-0.3em',
                        marginLeft: '0.1em',
                        marginRight: '0.1em'
                      }}
                      onError={(e) => {
                        e.currentTarget.replaceWith(part.content);
                      }}
                    />
                  );
                } else {
                  return <span key={idx}>{part.content}</span>;
                }
              })}
            </span>
          </div>
        ))}
      </div>

      {/* Footer Info Bar */}
      <div className="flex items-center px-3 py-1 bg-slate-950/80 border-t border-slate-900 text-[10px] text-slate-500 select-none">
        <div 
          className={`w-2 h-2 rounded-full ${
            channelStatus === 'connected' ? 'bg-emerald-500' :
            channelStatus === 'connecting' ? 'bg-amber-500 animate-pulse' : 'bg-rose-500'
          }`}
          title={`Connection status: ${channelStatus}`}
        />
      </div>
    </div>
  );
};
