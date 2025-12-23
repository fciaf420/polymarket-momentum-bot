import { useEffect, useState } from 'react';
import { clsx } from 'clsx';
import { api } from '../services/api';
import type { TradeRecord, TradeSummary } from '../types';

interface TradeHistoryProps {
  summary: TradeSummary;
}

function formatCurrency(value: number): string {
  return value.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function formatPercent(value: number): string {
  return `${value >= 0 ? '+' : ''}${(value * 100).toFixed(2)}%`;
}

export function TradeHistory({ summary }: TradeHistoryProps) {
  const [trades, setTrades] = useState<TradeRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const pageSize = 10;

  useEffect(() => {
    async function fetchTrades() {
      try {
        const result = await api.getTrades(100);
        setTrades(result.trades);
      } catch (error) {
        console.error('Failed to fetch trades:', error);
      } finally {
        setLoading(false);
      }
    }

    fetchTrades();
    const interval = setInterval(fetchTrades, 30000);
    return () => clearInterval(interval);
  }, []);

  const totalPages = Math.ceil(trades.length / pageSize);
  const paginatedTrades = trades.slice((page - 1) * pageSize, page * pageSize);

  return (
    <div className="terminal-panel">
      <div className="terminal-header">TRADE LOG</div>

      {/* Summary Stats */}
      <div className="grid grid-cols-4 gap-3 mb-4 text-xs font-mono">
        <div className="border-l-2 border-term-border pl-2">
          <div className="text-term-muted">TOTAL P&L</div>
          <div className={clsx('font-semibold', summary.totalPnl >= 0 ? 'text-profit' : 'text-loss')}>
            ${formatCurrency(summary.totalPnl)}
          </div>
        </div>
        <div className="border-l-2 border-term-border pl-2">
          <div className="text-term-muted">AVG P&L</div>
          <div className={clsx('font-semibold', summary.averagePnl >= 0 ? 'text-profit' : 'text-loss')}>
            ${formatCurrency(summary.averagePnl)}
          </div>
        </div>
        <div className="border-l-2 border-term-border pl-2">
          <div className="text-term-muted">BEST</div>
          <div className="text-profit font-semibold">${formatCurrency(summary.bestTrade)}</div>
        </div>
        <div className="border-l-2 border-term-border pl-2">
          <div className="text-term-muted">WORST</div>
          <div className="text-loss font-semibold">${formatCurrency(summary.worstTrade)}</div>
        </div>
      </div>

      {/* Trades Table */}
      {loading ? (
        <div className="text-center py-6 text-term-dim">Loading trades...</div>
      ) : trades.length === 0 ? (
        <div className="text-center py-6">
          <div className="text-term-dim text-sm">[ NO TRADES RECORDED ]</div>
        </div>
      ) : (
        <>
          <div className="overflow-x-auto">
            <table className="terminal-table text-xs">
              <thead>
                <tr>
                  <th>ASSET</th>
                  <th>DIR</th>
                  <th>SIDE</th>
                  <th className="text-right">ENTRY</th>
                  <th className="text-right">EXIT</th>
                  <th className="text-right">P&L</th>
                  <th className="text-right">%</th>
                  <th className="text-right">HOLD</th>
                  <th>REASON</th>
                </tr>
              </thead>
              <tbody>
                {paginatedTrades.map((trade) => (
                  <tr key={trade.id}>
                    <td className="text-term-text font-semibold">{trade.asset}</td>
                    <td>
                      <span className={trade.direction === 'up' ? 'text-matrix-green' : 'text-hot-pink'}>
                        {trade.direction === 'up' ? '▲' : '▼'}
                      </span>
                    </td>
                    <td>
                      <span className={clsx('badge text-xs', trade.side === 'YES' ? 'badge-cyan' : 'badge-amber')}>
                        {trade.side}
                      </span>
                    </td>
                    <td className="text-right num-fixed text-term-muted">{trade.entryPrice.toFixed(4)}</td>
                    <td className="text-right num-fixed text-term-muted">{trade.exitPrice.toFixed(4)}</td>
                    <td className={clsx('text-right num-fixed font-semibold', trade.pnl >= 0 ? 'text-profit' : 'text-loss')}>
                      {trade.pnl >= 0 ? '+' : ''}${formatCurrency(trade.pnl)}
                    </td>
                    <td className={clsx('text-right num-fixed', trade.pnl >= 0 ? 'text-profit' : 'text-loss')}>
                      {formatPercent(trade.pnlPercent)}
                    </td>
                    <td className="text-right num-fixed text-term-dim">{Math.round(trade.holdDuration)}m</td>
                    <td className="text-term-dim text-xs">{trade.exitReason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Pagination */}
          {totalPages > 1 && (
            <div className="flex items-center justify-between mt-3 pt-3 border-t border-term-border text-xs font-mono">
              <span className="text-term-dim">
                [{(page - 1) * pageSize + 1}-{Math.min(page * pageSize, trades.length)}/{trades.length}]
              </span>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  disabled={page === 1}
                  className={clsx(
                    'px-2 py-0.5 border border-term-border',
                    page === 1 ? 'text-term-dim cursor-not-allowed' : 'text-cyber-cyan hover:bg-cyber-cyan/10'
                  )}
                >
                  {'<'}
                </button>
                <span className="text-term-text">{page}/{totalPages}</span>
                <button
                  onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                  disabled={page === totalPages}
                  className={clsx(
                    'px-2 py-0.5 border border-term-border',
                    page === totalPages ? 'text-term-dim cursor-not-allowed' : 'text-cyber-cyan hover:bg-cyber-cyan/10'
                  )}
                >
                  {'>'}
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

export default TradeHistory;
