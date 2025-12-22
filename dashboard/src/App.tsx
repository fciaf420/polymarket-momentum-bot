import { useCallback } from 'react';
import { useWebSocket } from './hooks/useWebSocket';
import { api } from './services/api';
import {
  Header,
  AccountStats,
  LivePositions,
  RecentSignals,
  RiskMetrics,
  PriceMonitor,
  TradeHistory,
} from './components';
import { Loader2 } from 'lucide-react';

function App() {
  const { state, isConnected, error, reconnect } = useWebSocket('/ws');

  const handlePause = useCallback(async () => {
    try {
      await api.pause('User paused from dashboard');
    } catch (e) {
      console.error('Failed to pause:', e);
    }
  }, []);

  const handleResume = useCallback(async () => {
    try {
      await api.resume();
    } catch (e) {
      console.error('Failed to resume:', e);
    }
  }, []);

  // Loading state
  if (!state) {
    return (
      <div className="min-h-screen bg-slate-900 flex items-center justify-center">
        <div className="text-center">
          <Loader2 className="h-12 w-12 text-emerald-500 animate-spin mx-auto mb-4" />
          <p className="text-slate-400">Connecting to dashboard...</p>
          {error && (
            <div className="mt-4">
              <p className="text-red-400 mb-2">{error}</p>
              <button
                onClick={reconnect}
                className="px-4 py-2 bg-emerald-500/20 text-emerald-400 rounded hover:bg-emerald-500/30"
              >
                Retry Connection
              </button>
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-900">
      {/* Header */}
      <Header
        state={state}
        isConnected={isConnected}
        onPause={handlePause}
        onResume={handleResume}
      />

      {/* Main Content */}
      <main className="p-6">
        {/* Account Stats Row */}
        <section className="mb-6">
          <AccountStats state={state} />
        </section>

        {/* Main Grid */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Left Column - Positions, Signals, Trades, Risk */}
          <div className="lg:col-span-2 space-y-6">
            <LivePositions positions={state.positions} />
            <RecentSignals signals={state.signals} />
            <TradeHistory summary={state.trades.summary} />
            <RiskMetrics risk={state.risk} />
          </div>

          {/* Right Column - Price Monitor (sticky) */}
          <div className="lg:sticky lg:top-6 lg:self-start">
            <PriceMonitor prices={state.prices} markets={state.markets} />
          </div>
        </div>
      </main>

      {/* Footer */}
      <footer className="border-t border-slate-800 p-4 text-center text-sm text-slate-500">
        <p>Polymarket Momentum Bot Dashboard v1.0.0</p>
        <p className="text-xs mt-1">
          {isConnected ? 'Real-time updates active' : 'Attempting to reconnect...'}
        </p>
      </footer>
    </div>
  );
}

export default App;
