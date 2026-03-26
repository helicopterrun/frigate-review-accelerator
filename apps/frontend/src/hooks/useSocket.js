import { useState, useEffect } from 'react';
import { io } from 'socket.io-client';

const CORE_SERVER_URL = 'http://localhost:4010';

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
