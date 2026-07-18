const getStableColor = (name: string): string => {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  const h = Math.abs(hash % 360);
  return `hsl(${h}, 75%, 65%)`;
};

export interface YoutubeChatPart {
  type: 'text' | 'emote';
  content: string;
  url?: string;
}

export interface YoutubeChatMessage {
  id: string;
  username: string;
  displayName: string;
  avatarUrl?: string;
  message: string;
  parts: YoutubeChatPart[];
  timestamp: string;
  badges: { name: string; url?: string }[];
  isOwner: boolean;
  isModerator: boolean;
  color: string;
}

const fetchWithProxy = async (targetUrl: string, options?: RequestInit): Promise<Response> => {
  if (import.meta.env.DEV) {
    let localUrl = '';
    if (targetUrl.includes('/live_chat/get_live_chat')) {
      const apiKey = new URL(targetUrl).searchParams.get('key');
      localUrl = `/youtubei-api/live_chat/get_live_chat?key=${apiKey}`;
    } else if (targetUrl.includes('/live_chat?v=')) {
      const videoId = new URL(targetUrl).searchParams.get('v');
      localUrl = `/youtube-live-chat?v=${videoId}`;
    } else if (targetUrl.includes('youtube.com/@')) {
      const handle = targetUrl.split('youtube.com/')[1];
      localUrl = `/youtube-channel/${handle}`;
    }

    if (localUrl) {
      try {
        const res = await fetch(localUrl, options);
        if (res.ok) return res;
      } catch (e) {
        console.warn(`Local proxy dev failed for ${targetUrl}, trying public fallback...`, e);
      }
    }

    try {
      const res = await fetch(`https://corsproxy.io/?${targetUrl}`, options);
      if (res.ok) return res;
    } catch (e) {
      console.warn('corsproxy.io failed, trying allorigins...', e);
    }

    if (!options || options.method === 'GET') {
      const res = await fetch(`https://api.allorigins.win/raw?url=${encodeURIComponent(targetUrl)}`);
      if (res.ok) return res;
    }

    throw new Error(`Failed to fetch in dev: ${targetUrl}`);
  }

  // Production: use our own Cloudflare Worker API proxy
  const proxyUrl = `/bams/chat/api-proxy?url=${encodeURIComponent(targetUrl)}`;
  const res = await fetch(proxyUrl, options);
  if (res.ok) {
    return res;
  }
  throw new Error(`Failed to fetch via Cloudflare proxy: ${targetUrl}`);
};

export const resolveYoutubeChannelToVideoId = async (handle: string): Promise<string> => {
  const handleName = handle.trim().replace(/^@/, '');
  const targetUrl = `https://www.youtube.com/@${handleName}/live`;
  
  let html = '';
  try {
    const res = await fetchWithProxy(targetUrl);
    html = await res.text();
  } catch (e) {
    throw new Error('No active live stream found for this channel. Make sure they are currently live on YouTube!');
  }

  // 1. Try to find the canonical watch URL (sometimes it exists if not blocked)
  const canonicalMatch = html.match(/<link rel="canonical" href="https:\/\/www\.youtube\.com\/watch\?v=([a-zA-Z0-9_-]{11})"/);
  if (canonicalMatch && canonicalMatch[1] && canonicalMatch[1] !== 'undefined') {
    return canonicalMatch[1];
  }

  // 2. Scan for video IDs that have a live badge or overlay near them in the HTML
  const videoIdMatches = [...html.matchAll(/"videoId":"([a-zA-Z0-9_-]{11})"/g)];
  for (const m of videoIdMatches) {
    const videoId = m[1];
    const index = m.index;
    if (index === undefined) continue;
    
    const start = Math.max(0, index - 500);
    const end = Math.min(html.length, index + 1000);
    const context = html.slice(start, end);
    
    const isLive = context.includes('"style":"LIVE"') || 
                   context.includes('PLAYBACK_STYLE_LIVE') || 
                   context.includes('BADGE_STYLE_TYPE_LIVE_NOW') ||
                   context.includes('"label":"LIVE"');
                   
    if (isLive) {
      return videoId;
    }
  }

  // 3. Fallback: first video ID matched
  const videoIdMatch = html.match(/"videoId":"([a-zA-Z0-9_-]{11})"/);
  if (videoIdMatch && videoIdMatch[1]) return videoIdMatch[1];
  
  const watchMatch = html.match(/watch\?v=([a-zA-Z0-9_-]{11})/);
  if (watchMatch && watchMatch[1]) return watchMatch[1];

  throw new Error('No active live stream found for this channel. Make sure they are currently live on YouTube!');
};

export const resolveInitialChatData = async (videoId: string) => {
  const targetUrl = `https://www.youtube.com/live_chat?v=${videoId}`;
  
  let html = '';
  try {
    const res = await fetchWithProxy(targetUrl);
    html = await res.text();
  } catch (e) {
    throw new Error('Failed to load initial YouTube chat page.');
  }
  
  const apiKeyMatch = html.match(/"INNERTUBE_API_KEY":"([^"]+)"/) || html.match(/"apiKey":"([^"]+)"/);
  if (!apiKeyMatch) throw new Error('Could not find YouTube InnerTube API Key.');
  const apiKey = apiKeyMatch[1];
  
  let initialContinuation = '';
  const ytDataMatch = html.match(/window\["ytInitialData"\]\s*=\s*({.+?});/) || 
                       html.match(/ytInitialData\s*=\s*({.+?});/) || 
                       html.match(/window\['ytInitialData'\]\s*=\s*({.+?});/);
  
  if (ytDataMatch) {
    try {
      const ytInitialData = JSON.parse(ytDataMatch[1]);
      const subMenuItems = ytInitialData?.contents?.liveChatRenderer?.header?.liveChatHeaderRenderer?.viewSelector?.sortFilterSubMenuRenderer?.subMenuItems;
      if (Array.isArray(subMenuItems)) {
        const liveChatItem = subMenuItems.find((item: any) => {
          const title = (item?.title || item?.menuItemRenderer?.title || '').toLowerCase();
          return title.includes('live');
        });
        const renderer = liveChatItem?.menuItemRenderer || liveChatItem;
        const token = renderer?.continuation?.reloadContinuationData?.continuation;
        if (token) initialContinuation = token;
      }
      
      if (!initialContinuation) {
        const continuations = ytInitialData?.contents?.liveChatRenderer?.continuations;
        if (Array.isArray(continuations) && continuations[0]) {
          initialContinuation = continuations[0]?.reloadContinuationData?.continuation || 
                                continuations[0]?.timedContinuationData?.continuation || '';
        }
      }
    } catch (e) {
      console.warn('Could not parse ytInitialData JSON, falling back to regex...', e);
    }
  }

  if (!initialContinuation) {
    const continuationMatch = html.match(/"continuation":"([^"]+)"/);
    if (!continuationMatch) throw new Error('Could not find initial chat continuation token.');
    initialContinuation = continuationMatch[1];
  }

  const visitorDataMatch = html.match(/"visitorData":"([^"]+)"/) || html.match(/"VISITOR_DATA":"([^"]+)"/);
  const visitorData = visitorDataMatch ? visitorDataMatch[1] : '';
  
  return { apiKey, initialContinuation, visitorData };
};

export const pollYoutubeChat = async (apiKey: string, continuationToken: string, visitorData?: string) => {
  const requestBody = {
    context: {
      client: {
        clientName: 'WEB',
        clientVersion: '2.20240101'
      }
    },
    continuation: continuationToken
  };

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Youtube-Client-Name': '1',
    'X-Youtube-Client-Version': '2.20240101'
  };
  if (visitorData) {
    headers['X-Goog-Visitor-Id'] = visitorData;
  }

  const targetUrl = `https://www.youtube.com/youtubei/v1/live_chat/get_live_chat?key=${apiKey}`;
  const res = await fetchWithProxy(targetUrl, {
    method: 'POST',
    headers: headers,
    body: JSON.stringify(requestBody)
  });
  
  if (!res.ok) {
    throw new Error('Failed to reach YouTube live chat API.');
  }

  return await res.json();
};

export const parseYoutubeActions = (data: any): { messages: YoutubeChatMessage[], nextContinuation?: string, timeoutMs?: number } => {
  const messages: YoutubeChatMessage[] = [];
  
  const liveChatContinuation = data?.continuationContents?.liveChatContinuation;
  if (!liveChatContinuation) return { messages };
  
  const actions = liveChatContinuation.actions || [];
  for (const action of actions) {
    const item = action?.addChatItemAction?.item;
    if (!item) continue;
    
    const renderer = item.liveChatTextMessageRenderer || item.liveChatPaidMessageRenderer;
    if (!renderer) continue;
    
    const id = renderer.id;
    const authorName = renderer.authorName?.simpleText || 'Anonymous';
    const avatarUrl = renderer.authorPhoto?.thumbnails?.[0]?.url;
    
    const runs = renderer.message?.runs || [];
    const parts: YoutubeChatPart[] = [];
    let fullText = '';
    
    for (const run of runs) {
      if (run.text) {
        parts.push({ type: 'text', content: run.text });
        fullText += run.text;
      } else if (run.emoji) {
        const emojiUrl = run.emoji.image?.thumbnails?.[0]?.url;
        const emojiName = run.emoji.shortcuts?.[0] || run.emoji.emojiId || 'emote';
        parts.push({ type: 'emote', content: emojiName, url: emojiUrl });
        fullText += ` ${emojiName} `;
      }
    }
    
    let isOwner = false;
    let isModerator = false;
    const badges: { name: string; url?: string }[] = [];
    
    const authorBadges = renderer.authorBadges || [];
    for (const b of authorBadges) {
      const badgeRenderer = b.liveChatAuthorBadgeRenderer;
      if (!badgeRenderer) continue;
      
      const tooltip = badgeRenderer.tooltip || '';
      const iconType = badgeRenderer.icon?.iconType;
      
      if (iconType === 'MODERATOR' || tooltip.toLowerCase().includes('moderator')) {
        isModerator = true;
        badges.push({ name: 'moderator' });
      } else if (iconType === 'OWNER' || tooltip.toLowerCase().includes('owner') || tooltip.toLowerCase().includes('broadcaster')) {
        isOwner = true;
        badges.push({ name: 'broadcaster' });
      } else if (badgeRenderer.customThumbnail?.thumbnails?.[0]?.url) {
        badges.push({ 
          name: 'subscriber', 
          url: badgeRenderer.customThumbnail.thumbnails[0].url 
        });
      }
    }
    
    const usec = parseInt(renderer.timestampUsec || '0');
    const date = usec ? new Date(usec / 1000) : new Date();
    const timestampStr = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
    
    messages.push({
      id,
      username: authorName.toLowerCase().replace(/\s+/g, ''),
      displayName: authorName,
      avatarUrl,
      message: fullText,
      parts,
      timestamp: timestampStr,
      badges,
      isOwner,
      isModerator,
      color: getStableColor(authorName)
    });
  }

  let nextContinuation: string | undefined;
  let timeoutMs: number = 1000;
  const continuations = liveChatContinuation.continuations || [];
  for (const c of continuations) {
    const data = c.invalidationContinuationData || c.timedContinuationData;
    if (data && data.continuation) {
      nextContinuation = data.continuation;
      if (data.timeoutMs) {
        timeoutMs = data.timeoutMs;
      }
      break;
    }
  }
  
  return { messages, nextContinuation, timeoutMs };
};
