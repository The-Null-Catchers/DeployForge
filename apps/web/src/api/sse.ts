import { useEffect, useRef, useState } from 'react';

export type StreamState = 'connecting' | 'open' | 'reconnecting' | 'ended' | 'error';

export interface StreamHandlers {
  [event: string]: (data: unknown, id: string | null) => void;
}

/**
 * Subscribe to an authenticated SSE endpoint. EventSource resends
 * Last-Event-ID automatically when it reconnects, so the server resumes
 * exactly after the last event received. The stream is closed when the
 * server sends `end` (or `stream-error` with a code), instead of letting the
 * browser reconnect forever.
 */
export function useEventStream(url: string | null, handlers: StreamHandlers): { state: StreamState; errorCode: string | null; reconnect: () => void } {
  const [state, setState] = useState<StreamState>('connecting');
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  useEffect(() => {
    if (!url) return;
    setState('connecting');
    setErrorCode(null);
    const es = new EventSource(url, { withCredentials: true });
    let closed = false;
    es.onopen = () => setState('open');
    es.onerror = () => {
      if (closed) return;
      // CONNECTING means the browser is retrying; CLOSED means it gave up
      // (for example the session expired and the server answered 401).
      setState(es.readyState === EventSource.CLOSED ? 'error' : 'reconnecting');
    };
    const listen = (name: string) =>
      es.addEventListener(name, (ev) => {
        const me = ev as MessageEvent<string>;
        let data: unknown = null;
        try {
          data = JSON.parse(me.data);
        } catch {
          return;
        }
        if (name === 'end') {
          closed = true;
          es.close();
          setState('ended');
        }
        if (name === 'stream-error' && data && typeof data === 'object' && 'code' in data) {
          closed = true;
          es.close();
          setErrorCode(String((data as { code: string }).code));
          setState('error');
        }
        handlersRef.current[name]?.(data, me.lastEventId || null);
      });
    for (const name of new Set([...Object.keys(handlersRef.current), 'end', 'stream-error'])) listen(name);
    return () => {
      closed = true;
      es.close();
    };
  }, [url, nonce]);

  return { state, errorCode, reconnect: () => setNonce((n) => n + 1) };
}
