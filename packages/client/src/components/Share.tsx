import { useState } from 'react';

/**
 * Share a link to this game or tournament. On a touch device with the system share sheet (navigator.share) it opens
 * that; elsewhere it copies the link. The page behind the link carries a preview (title, status, board picture).
 */
export function ShareButton({ url, title, label = 'Share' }: { url: string; title: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  const share = async () => {
    const touch = typeof window !== 'undefined' && window.matchMedia?.('(pointer: coarse)').matches;
    if (touch && typeof navigator.share === 'function') {
      try {
        await navigator.share({ title, url });
        return;
      } catch {
        /* dismissed or refused: fall back to copying */
      }
    }
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* no clipboard (an insecure page): nothing to do */
    }
  };
  return (
    <button className="small" onClick={share} title="Share a link (with a preview of the board)">
      {copied ? 'Link copied!' : `🔗 ${label}`}
    </button>
  );
}
