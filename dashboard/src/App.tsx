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
  MoveProgress,
} from './components';
import { ConfigBanner } from './components/ConfigBanner';
import { ValidationChain } from './components/ValidationChain';

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
      <div className="min-h-screen bg-term-bg flex items-center justify-center">
        <div className="text-center font-mono">
          <div className="text-cyber-cyan text-2xl mb-4 animate-pulse">
            [ CONNECTING ]
          </div>
          <div className="text-term-muted text-sm">
            Establishing connection to dashboard...
          </div>
          <div className="mt-4 text-term-dim text-xs">
            <span className="animate-blink">_</span>
          </div>
          {error && (
            <div className="mt-6">
              <p className="text-hot-pink mb-3">{error}</p>
              <button
                onClick={reconnect}
                className="terminal-btn"
              >
                [RETRY CONNECTION]
              </button>
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-term-bg">
      {/* Header */}
      <Header
        state={state}
        isConnected={isConnected}
        onPause={handlePause}
        onResume={handleResume}
      />

      {/* Config Banner - Editable settings */}
      <ConfigBanner config={state.config} />

      {/* Main Content */}
      <main className="p-4">
        {/* Account Stats Row */}
        <section className="mb-4">
          <AccountStats state={state} />
        </section>

        {/* Main Grid - 3 columns */}
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
          {/* Left Column - Validation & Move Progress */}
          <div className="lg:col-span-3 space-y-4">
            <ValidationChain validation={state.validation} />
            <MoveProgress moveProgress={state.moveProgress} />
            <RiskMetrics risk={state.risk} accountBalance={state.account.balance} />
          </div>

          {/* Center Column - Positions, Signals, Trades */}
          <div className="lg:col-span-5 space-y-4">
            <LivePositions positions={state.positions} />
            <RecentSignals signals={state.signals} />
            <TradeHistory summary={state.trades.summary} />
          </div>

          {/* Right Column - Price Monitor (sticky) */}
          <div className="lg:col-span-4 lg:sticky lg:top-4 lg:self-start">
            <PriceMonitor prices={state.prices} markets={state.markets} />
          </div>
        </div>
      </main>

      {/* Footer */}
      <footer className="border-t border-term-border p-3 text-center font-mono text-xs">
        <div className="flex items-center justify-center gap-4">
          <span className="text-term-dim">POLYMARKET MOMENTUM v1.0.0</span>
          <span className="text-term-border">|</span>
          <span className={isConnected ? 'text-matrix-green' : 'text-hot-pink'}>
            {isConnected ? '● LIVE' : '○ RECONNECTING'}
          </span>
        </div>
      </footer>
    </div>
  );
}

export default App;
