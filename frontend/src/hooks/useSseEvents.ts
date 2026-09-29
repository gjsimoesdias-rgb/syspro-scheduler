import { useState, useEffect } from 'react';
import { API_BASE_URL } from '../services/api';

export interface SseEventsResult {
  replanBanner: string | null;
  setReplanBanner: (banner: string | null) => void;
  sseConnected: boolean;
}

/**
 * Connects to the SSE /schedule/events stream and surfaces real-time
 * replan signals to the caller.
 */
export function useSseEvents(): SseEventsResult {
  const [replanBanner, setReplanBanner] = useState<string | null>(null);
  const [sseConnected, setSseConnected] = useState(false);

  useEffect(() => {
    const evtSource = new EventSource(`${API_BASE_URL}/schedule/events`);

    evtSource.addEventListener('open', () => setSseConnected(true));
    evtSource.addEventListener('error', () => setSseConnected(false));
    evtSource.addEventListener('replan', (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data);
        const reason = data?.reason ?? 'Job data changed in SYSPRO';
        setReplanBanner(`Schedule data changed: ${reason}. Consider regenerating the schedule.`);
      } catch {
        setReplanBanner('SYSPRO data has changed. Consider regenerating the schedule.');
      }
    });

    return () => {
      evtSource.close();
      setSseConnected(false);
    };
    // Run once on mount — API_BASE_URL is a module-level constant.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { replanBanner, setReplanBanner, sseConnected };
}
