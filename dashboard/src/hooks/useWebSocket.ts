import { useEffect, useRef, useState, useCallback } from 'react';
import type { DashboardState, WSMessage, PriceUpdate, Position, Signal } from '../types';

interface UseWebSocketReturn {
  state: DashboardState | null;
  isConnected: boolean;
  error: string | null;
  reconnect: () => void;
}

export function useWebSocket(url: string = '/ws'): UseWebSocketReturn {
  const [state, setState] = useState<DashboardState | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const reconnectAttempts = useRef(0);

  const connect = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      return;
    }

    // Build WebSocket URL
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = url.startsWith('/')
      ? `${protocol}//${window.location.host}${url}`
      : url;

    try {
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        setIsConnected(true);
        setError(null);
        reconnectAttempts.current = 0;
      };

      ws.onmessage = (event) => {
        try {
          const message: WSMessage = JSON.parse(event.data);
          handleMessage(message);
        } catch (e) {
          console.error('Failed to parse WebSocket message:', e);
        }
      };

      ws.onclose = () => {
        setIsConnected(false);
        // Auto-reconnect with exponential backoff
        const delay = Math.min(1000 * Math.pow(2, reconnectAttempts.current), 30000);
        reconnectAttempts.current++;
        reconnectTimeoutRef.current = setTimeout(connect, delay);
      };

      ws.onerror = () => {
        setError('WebSocket connection error');
      };
    } catch (e) {
      setError(`Failed to connect: ${(e as Error).message}`);
    }
  }, [url]);

  const handleMessage = useCallback((message: WSMessage) => {
    switch (message.type) {
      case 'initial_state':
      case 'state':
        setState(message.data as DashboardState);
        break;

      case 'price_update':
        setState((prev) => {
          if (!prev) return prev;
          const update = message.data as PriceUpdate;

          // Update positions with new prices
          const updatedPositions = prev.positions.map((pos) => {
            const priceUpdate = update.positions.find((p) => p.id === pos.id);
            if (priceUpdate) {
              return {
                ...pos,
                currentPrice: priceUpdate.currentPrice,
                currentValue: priceUpdate.currentValue,
                unrealizedPnl: priceUpdate.unrealizedPnl,
                unrealizedPnlPercent: priceUpdate.unrealizedPnlPercent,
              };
            }
            return pos;
          });

          return {
            ...prev,
            status: update.status,
            connections: update.connections,
            prices: {
              crypto: { ...prev.prices.crypto, ...update.crypto },
              markets: { ...prev.prices.markets, ...update.markets },
            },
            markets: update.activeMarkets || prev.markets, // Update active markets list
            positions: updatedPositions,
            account: {
              ...prev.account,
              balance: update.account.balance,
              totalPnl: update.account.totalPnl,
              currentDrawdown: update.account.drawdown,
            },
          };
        });
        break;

      case 'position_opened':
        setState((prev) => {
          if (!prev) return prev;
          return {
            ...prev,
            positions: [...prev.positions, message.data as Position],
          };
        });
        break;

      case 'position_closed':
        setState((prev) => {
          if (!prev) return prev;
          const closedPos = message.data as Position;
          return {
            ...prev,
            positions: prev.positions.filter((p) => p.id !== closedPos.id),
          };
        });
        break;

      case 'signal_detected':
        setState((prev) => {
          if (!prev) return prev;
          const newSignal = message.data as Signal;
          return {
            ...prev,
            signals: [newSignal, ...prev.signals.slice(0, 49)],
          };
        });
        break;

      case 'pong':
        // Heartbeat response
        break;
    }
  }, []);

  const reconnect = useCallback(() => {
    if (wsRef.current) {
      wsRef.current.close();
    }
    reconnectAttempts.current = 0;
    connect();
  }, [connect]);

  useEffect(() => {
    connect();

    // Send ping every 30 seconds
    const pingInterval = setInterval(() => {
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ type: 'ping', timestamp: Date.now() }));
      }
    }, 30000);

    return () => {
      clearInterval(pingInterval);
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
      }
      if (wsRef.current) {
        wsRef.current.close();
      }
    };
  }, [connect]);

  return { state, isConnected, error, reconnect };
}

export default useWebSocket;
