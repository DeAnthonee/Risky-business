import { useEffect, useMemo, useRef, useState } from 'react';

/** The bits of the Web Speech API's SpeechRecognition this hook uses (not in every TypeScript DOM lib). */
interface Recognition {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}
type RecognitionCtor = new () => Recognition;

function recognitionCtor(): RecognitionCtor | null {
  if (typeof window === 'undefined' || !window.isSecureContext) return null;
  const w = window as unknown as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

/** Is speech-to-text available here (the browser has it, on a secure page)? Where not, the mic is not shown. */
export function speechSupported(): boolean {
  return recognitionCtor() !== null;
}

const ERRORS: Record<string, string> = {
  'not-allowed': 'The browser did not allow the microphone.',
  'service-not-allowed': 'Speech-to-text is turned off in this browser.',
  'no-speech': 'No speech heard: try again.',
  'audio-capture': 'No microphone found.',
  network: "The browser's speech service could not be reached.",
  aborted: '',
};

/**
 * Speech-to-text with the browser's own Web Speech API (no server, no dependency): one phrase per press, stopping on
 * silence or a second press. `onText` gets the final transcript; the caller decides what to do with it (the coach box
 * puts it in the text field for review, never sends it). The microphone is used only while listening.
 */
export function useSpeech(onText: (text: string) => void) {
  const supported = useMemo(speechSupported, []);
  const [listening, setListening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const rec = useRef<Recognition | null>(null);
  const handler = useRef(onText);
  handler.current = onText;

  useEffect(() => () => rec.current?.abort(), []);

  const start = () => {
    const Ctor = recognitionCtor();
    if (!Ctor || rec.current) return;
    const r = new Ctor();
    r.lang = navigator.language || 'en-US';
    r.continuous = false;
    r.interimResults = false;
    r.maxAlternatives = 1;
    r.onresult = (e) => {
      const text = Array.from(e.results)
        .map((alts) => alts[0]?.transcript ?? '')
        .join(' ')
        .trim();
      if (text) handler.current(text);
    };
    r.onerror = (e) => setError(ERRORS[e.error] ?? `Speech-to-text failed (${e.error}).`);
    r.onend = () => {
      rec.current = null;
      setListening(false);
    };
    rec.current = r;
    setError(null);
    setListening(true);
    try {
      r.start();
    } catch {
      rec.current = null;
      setListening(false);
      setError('Speech-to-text could not start.');
    }
  };
  const stop = () => rec.current?.stop();

  return { supported, listening, error: error || null, toggle: () => (listening ? stop() : start()) };
}
