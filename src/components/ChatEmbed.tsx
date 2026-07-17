import React, { useState, useEffect } from 'react';
import { ExternalLink } from 'lucide-react';

const TwitchIcon: React.FC<{ className?: string }> = ({ className }) => (
  <svg viewBox="0 0 24 24" fill="currentColor" className={className}>
    <path d="M11.571 4.714h1.715v5.143H11.57zm4.715 0H18v5.143h-1.714zM6 0L1.714 4.286v15.428h5.143V24l4.286-4.286h3.428L22.286 12V0zm14.571 11.143l-3.428 3.428h-3.429l-3 3v-3H6.857V1.714h13.714Z"/>
  </svg>
);

const YoutubeIcon: React.FC<{ className?: string }> = ({ className }) => (
  <svg viewBox="0 0 24 24" fill="currentColor" className={className}>
    <path d="M23.498 6.163a3.003 3.003 0 0 0-2.11-2.108C19.524 3.545 12 3.545 12 3.545s-7.525 0-9.388.51a3.002 3.002 0 0 0-2.11 2.108C0 8.029 0 12 0 12s0 3.971.502 5.837a3.003 3.003 0 0 0 2.11 2.108c1.863.51 9.388.51 9.388.51s7.524 0 9.388-.51a3.003 3.003 0 0 0 2.11-2.108C24 15.971 24 12 24 12s0-3.971-.502-5.837zM9.545 15.568V8.432L15.818 12l-6.273 3.568z"/>
  </svg>
);

interface ChatEmbedProps {
  type: 'twitch-embed' | 'youtube-embed' | 'youtube-custom' | 'twitch-video' | 'youtube-video';
  channel: string;
}

const fetchWithProxy = async (target: string): Promise<string> => {
  if (import.meta.env.DEV) {
    try {
      let localUrl = '';
      if (target.includes('/live_chat?v=')) {
        const videoId = new URL(target).searchParams.get('v');
        localUrl = `/youtube-live-chat?v=${videoId}`;
      } else if (target.includes('youtube.com/@')) {
        const handle = target.split('youtube.com/')[1];
        localUrl = `/youtube-channel/${handle}`;
      }
      
      if (localUrl) {
        const res = await fetch(localUrl);
        if (res.ok) return await res.text();
      }
    } catch (e) {
      console.warn('Vite server proxy failed, trying public CORS proxies...', e);
    }

    try {
      const res = await fetch(`https://corsproxy.io/?${target}`);
      if (res.ok) {
        return await res.text();
      }
    } catch (e) {
      console.warn('corsproxy.io failed, trying allorigins...', e);
    }
    
    const res = await fetch(`https://api.allorigins.win/raw?url=${encodeURIComponent(target)}`);
    if (res.ok) {
      return await res.text();
    }
    
    throw new Error('Could not contact proxy servers. Please try again.');
  }

  // Production: use our own Cloudflare Worker API proxy
  const proxyUrl = `/bams/chat/api-proxy?url=${encodeURIComponent(target)}`;
  const res = await fetch(proxyUrl);
  if (res.ok) {
    return await res.text();
  }
  
  throw new Error('Could not contact Cloudflare proxy. Please try again.');
};

export const ChatEmbed: React.FC<ChatEmbedProps> = ({ type, channel }) => {
  const host = window.location.hostname || 'localhost';
  const [resolvedVideoId, setResolvedVideoId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Helper to extract YouTube video ID from URL or return the raw string
  const getYoutubeId = (input: string): string => {
    if (!input) return '';
    const regExp = /^.*(youtu.be\/|v\/|u\/\w\/|embed\/|watch\?v=|\&v=)([^#\&\?]*).*/;
    const match = input.match(regExp);
    return (match && match[2].length === 11) ? match[2] : input.trim();
  };

  useEffect(() => {
    const cleanChan = channel.trim();
    if (!cleanChan) {
      setResolvedVideoId(null);
      setIsLoading(false);
      setError(null);
      return;
    }

    const isYoutubeType = type === 'youtube-embed' || type === 'youtube-custom' || type === 'youtube-video';
    if (!isYoutubeType) {
      setResolvedVideoId(null);
      setIsLoading(false);
      setError(null);
      return;
    }

    // Check if it is a handle: starts with @ or is not a video ID and doesn't contain youtube watch link formats
    const isHandle = cleanChan.startsWith('@') || 
                     (cleanChan.length !== 11 && 
                      !cleanChan.includes('youtube.com') && 
                      !cleanChan.includes('youtu.be'));

    if (!isHandle) {
      // Direct video ID or direct watch link
      const id = getYoutubeId(cleanChan);
      setResolvedVideoId(id);
      setIsLoading(false);
      setError(null);
    } else {
      // Resolve username handle to current live stream video ID
      setIsLoading(true);
      setError(null);
      const handleName = cleanChan.replace(/^@/, '');
      const targetUrl = `https://www.youtube.com/@${handleName}/live`;

      console.log(`Resolving live stream for YouTube handle: @${handleName}`);
      
      let isSubscribed = true;

      fetchWithProxy(targetUrl)
        .then(html => {
          if (!isSubscribed) return;

          // Match patterns:
          // 1. Canonical links pointing to the watch URL
          const canonicalMatch = html.match(/<link rel="canonical" href="https:\/\/www\.youtube\.com\/watch\?v=([a-zA-Z0-9_-]{11})"/);
          if (canonicalMatch && canonicalMatch[1]) {
            setResolvedVideoId(canonicalMatch[1]);
            setIsLoading(false);
            return;
          }

          // 2. videoId inside ytInitialPlayerResponse JSON payload
          const videoIdMatch = html.match(/"videoId":"([a-zA-Z0-9_-]{11})"/);
          if (videoIdMatch && videoIdMatch[1]) {
            setResolvedVideoId(videoIdMatch[1]);
            setIsLoading(false);
            return;
          }

          // 3. Simple fallback match for watch links in raw scripts
          const watchMatch = html.match(/watch\?v=([a-zA-Z0-9_-]{11})/);
          if (watchMatch && watchMatch[1]) {
            setResolvedVideoId(watchMatch[1]);
            setIsLoading(false);
            return;
          }

          throw new Error('No active live stream found. Make sure the channel is currently live, or paste a direct stream URL/Video ID.');
        })
        .catch(err => {
          if (!isSubscribed) return;
          console.warn('YouTube handle resolution error:', err);
          setError(err.message || 'Error resolving YouTube channel.');
          setIsLoading(false);
        });

      return () => {
        isSubscribed = false;
      };
    }
  }, [channel, type]);

  const getEmbedUrl = () => {
    const cleanChan = channel.toLowerCase().trim();
    if (!cleanChan) return '';

    switch (type) {
      case 'twitch-embed':
        return `https://www.twitch.tv/embed/${cleanChan}/chat?parent=${host}&darkpopout`;
      
      case 'twitch-video':
        return `https://player.twitch.tv/?channel=${cleanChan}&parent=${host}&autoplay=true&muted=true`;
      
      case 'youtube-custom':
      case 'youtube-embed': {
        if (!resolvedVideoId) return '';
        return `https://www.youtube.com/live_chat?v=${resolvedVideoId}&embed_domain=${host}&dark_theme=1`;
      }
      
      case 'youtube-video': {
        if (!resolvedVideoId) return '';
        return `https://www.youtube.com/embed/${resolvedVideoId}?autoplay=1&mute=1`;
      }
      
      default:
        return '';
    }
  };

  if (!channel) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-slate-500 bg-slate-950/20 p-4">
        <p className="text-sm">Please set a channel or video ID/URL/handle in the split header.</p>
      </div>
    );
  }

  const isYoutubeType = type.startsWith('youtube');
  const embedUrl = getEmbedUrl();

  // If YouTube is resolving
  if (isYoutubeType && isLoading) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-slate-400 bg-slate-950 p-4">
        <div className="w-6 h-6 border-2 border-slate-700 border-t-indigo-500 rounded-full animate-spin mb-3"></div>
        <p className="text-xs">Resolving live stream for YouTube handle...</p>
      </div>
    );
  }

  // If YouTube resolution failed
  if (isYoutubeType && error) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-slate-400 bg-slate-950 p-6 text-center">
        <div className="w-8 h-8 rounded-full bg-red-950/30 flex items-center justify-center text-red-500 mb-3 border border-red-900/20">
          ⚠️
        </div>
        <p className="text-xs font-semibold text-white mb-1">Could Not Resolve Live Stream</p>
        <p className="text-[11px] text-slate-500 max-w-[280px] leading-relaxed mb-4">
          {error}
        </p>
        <button 
          onClick={() => {
            // Trigger refresh by forcing a re-run of effect
            const original = channel;
            // Simply re-trigger loading
            setIsLoading(true);
            setError(null);
            const handleName = original.replace(/^@/, '');
            const targetUrl = `https://www.youtube.com/@${handleName}/live`;
            fetchWithProxy(targetUrl)
              .then(html => {
                const canonicalMatch = html.match(/<link rel="canonical" href="https:\/\/www\.youtube\.com\/watch\?v=([a-zA-Z0-9_-]{11})"/);
                if (canonicalMatch && canonicalMatch[1]) {
                  setResolvedVideoId(canonicalMatch[1]);
                  setIsLoading(false);
                  return;
                }
                const videoIdMatch = html.match(/"videoId":"([a-zA-Z0-9_-]{11})"/);
                if (videoIdMatch && videoIdMatch[1]) {
                  setResolvedVideoId(videoIdMatch[1]);
                  setIsLoading(false);
                  return;
                }
                throw new Error('Offline or not live. Try direct link or video ID.');
              })
              .catch(err => {
                setError(err.message || 'Offline or not live.');
                setIsLoading(false);
              });
          }}
          className="px-3 py-1 bg-slate-800 hover:bg-slate-700 text-white rounded text-[10px] font-bold uppercase transition-colors"
        >
          Try Again
        </button>
      </div>
    );
  }

  const isYoutubeChat = type === 'youtube-embed' || type === 'youtube-custom';
  const ytPopoutUrl = isYoutubeChat && resolvedVideoId 
    ? `https://www.youtube.com/live_chat?v=${resolvedVideoId}` 
    : '';

  return (
    <div className="relative w-full h-full flex flex-col bg-slate-950 overflow-hidden">
      {isYoutubeChat && (
        <div className="flex items-center justify-between px-3 py-1 bg-red-950/20 border-b border-red-900/10 text-[11px] text-slate-400">
          <div className="flex items-center gap-1.5">
            <YoutubeIcon className="w-3 h-3 text-red-500" />
            <span>{type === 'youtube-custom' ? 'YouTube Custom Chat (Embed)' : 'YouTube Chat Embed'}</span>
          </div>
          {ytPopoutUrl && (
            <a
              href={ytPopoutUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-0.5 hover:text-white transition-colors"
              title="Open Live Chat in a separate window"
            >
              <span>Popout Chat</span>
              <ExternalLink className="w-2.5 h-2.5" />
            </a>
          )}
        </div>
      )}

      {type === 'twitch-embed' && (
        <div className="flex items-center justify-between px-3 py-1 bg-purple-950/20 border-b border-purple-900/10 text-[11px] text-slate-400">
          <div className="flex items-center gap-1.5">
            <TwitchIcon className="w-3 h-3 text-purple-500" />
            <span>Twitch Chat Embed</span>
          </div>
          <a
            href={`https://www.twitch.tv/popout/${channel.toLowerCase().trim()}/chat`}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-0.5 hover:text-white transition-colors"
          >
            <span>Popout Chat</span>
            <ExternalLink className="w-2.5 h-2.5" />
          </a>
        </div>
      )}

      <div className="flex-1 w-full h-full relative">
        {embedUrl ? (
          <iframe
            src={embedUrl}
            title={`${type}-${channel}`}
            className="w-full h-full border-0 bg-transparent"
            allow="autoplay; encrypted-media; picture-in-picture"
            allowFullScreen
          />
        ) : (
          <div className="flex items-center justify-center h-full text-slate-500">
            <span>Invalid Embed URL</span>
          </div>
        )}
      </div>
    </div>
  );
};
