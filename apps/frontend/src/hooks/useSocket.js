import { useState, useEffect } from 'react';
import { io } from 'socket.io-client';

// When VITE_CORE_URL is set (local dev), connect directly to the core server.
// When unset (production through nginx), connect to the same origin so nginx
// can proxy /socket.io/ over the existing HTTPS connection — no mixed content.
const CORE_SERVER_URL = import.meta.env.VITE_CORE_URL ?? window.location.origin;

export function useSocket() {
  const [status, setStatus] = useState('disconnected');
  const [socket, setSocket] = useState(null);

  useEffect(() => {
    const s = io(CORE_SERVER_URL, {
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionAttempts: Infinity,
    });

    setSocket(s);

    s.on('connect', () => setStatus('connected'));
    s.on('disconnect', () => setStatus('disconnected'));
    s.on('connect_error', () => setStatus('error'));

    return () => {
      s.disconnect();
      setSocket(null);
    };
  }, []);

  return { socket, status };
}
