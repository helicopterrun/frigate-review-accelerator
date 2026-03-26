import { useState, useEffect, useRef } from 'react';
import { io } from 'socket.io-client';

const CORE_SERVER_URL = 'http://localhost:4010';

export function useSocket() {
  const [status, setStatus] = useState('disconnected');
  const socketRef = useRef(null);

  useEffect(() => {
    const socket = io(CORE_SERVER_URL, {
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionAttempts: Infinity,
    });

    socketRef.current = socket;

    socket.on('connect', () => setStatus('connected'));
    socket.on('disconnect', () => setStatus('disconnected'));
    socket.on('connect_error', () => setStatus('error'));

    return () => {
      socket.disconnect();
      socketRef.current = null;
    };
  }, []);

  return { socket: socketRef.current, status };
}
