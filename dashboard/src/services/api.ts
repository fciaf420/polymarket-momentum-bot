import type { DashboardState, TradeRecord } from '../types';

const API_BASE = '/api';

async function fetchJSON<T>(endpoint: string): Promise<T> {
  const response = await fetch(`${API_BASE}${endpoint}`);
  if (!response.ok) {
    throw new Error(`API error: ${response.status} ${response.statusText}`);
  }
  return response.json();
}

async function postJSON<T>(endpoint: string, body?: Record<string, unknown>): Promise<T> {
  const response = await fetch(`${API_BASE}${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!response.ok) {
    throw new Error(`API error: ${response.status} ${response.statusText}`);
  }
  return response.json();
}

export const api = {
  // Health check
  health: () => fetchJSON<{ status: string; timestamp: number }>('/health'),

  // Get full state
  getState: () => fetchJSON<DashboardState>('/state'),

  // Get bot status
  getStatus: () => fetchJSON<DashboardState['status']>('/status'),

  // Get account info
  getAccount: () => fetchJSON<DashboardState['account']>('/account'),

  // Get positions
  getPositions: () => fetchJSON<DashboardState['positions']>('/positions'),

  // Get signals
  getSignals: (limit = 50) => fetchJSON<DashboardState['signals']>(`/signals?limit=${limit}`),

  // Get trade history
  getTrades: (limit = 100) =>
    fetchJSON<{ trades: TradeRecord[]; total: number }>(`/trades?limit=${limit}`),

  // Get trade summary
  getTradeSummary: () => fetchJSON<DashboardState['trades']['summary']>('/trades/summary'),

  // Get risk metrics
  getRiskMetrics: () => fetchJSON<DashboardState['risk']['metrics']>('/risk/metrics'),

  // Get risk limits
  getRiskLimits: () => fetchJSON<DashboardState['risk']['limits']>('/risk/limits'),

  // Get prices
  getPrices: () => fetchJSON<DashboardState['prices']>('/prices'),

  // Get markets
  getMarkets: () => fetchJSON<DashboardState['markets']>('/markets'),

  // Get config (sanitized)
  getConfig: () => fetchJSON<Record<string, unknown>>('/config'),

  // Pause bot
  pause: (reason?: string) =>
    postJSON<{ success: boolean; paused: boolean }>('/control/pause', reason ? { reason } : undefined),

  // Resume bot
  resume: () => postJSON<{ success: boolean; paused: boolean }>('/control/resume'),
};

export default api;
