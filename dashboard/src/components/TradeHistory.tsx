import { useEffect, useState } from 'react';
import { History, TrendingUp, TrendingDown, Clock, ChevronLeft, ChevronRight } from 'lucide-react';
import { clsx } from 'clsx';
import { api } from '../services/api';
import type { TradeRecord, TradeSummary } from '../types';

interface TradeHistoryProps {
  summary: TradeSummary;
}

function formatCurrency(value: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
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
    // Refresh every 30 seconds
    const interval = setInterval(fetchTrades, 30000);
    return () => clearInterval(interval);
  }, []);

  const totalPages = Math.ceil(trades.length / pageSize);
  const paginatedTrades = trades.slice((page - 1) * pageSize, page * pageSize);

  return (
    <div className="card">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-semibold text-white flex items-center gap-2">
          <History className="h-5 w-5 text-purple-400" />
          Trade History
        </h2>
        <div className="flex items-center gap-4 text-sm">
          <span className="text-slate-400">
            {summary.totalTrades} trades | Win Rate: {(summary.winRate * 100).toFixed(1)}%
          </span>
        </div>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-4 gap-3 mb-4">
        <div className="bg-slate-700/30 rounded-lg p-2 text-center">
          <p className="text-xs text-slate-400">Total P&L</p>
          <p className={clsx('font-bold', summary.totalPnl >= 0 ? 'text-emerald-400' : 'text-red-400')}>
            {formatCurrency(summary.totalPnl)}
          </p>
        </div>
        <div className="bg-slate-700/30 rounded-lg p-2 text-center">
          <p className="text-xs text-slate-400">Avg P&L</p>
          <p className={clsx('font-bold', summary.averagePnl >= 0 ? 'text-emerald-400' : 'text-red-400')}>
            {formatCurrency(summary.averagePnl)}
          </p>
        </div>
        <div className="bg-slate-700/30 rounded-lg p-2 text-center">
          <p className="text-xs text-slate-400">Best Trade</p>
          <p className="font-bold text-emerald-400">{formatCurrency(summary.bestTrade)}</p>
        </div>
        <div className="bg-slate-700/30 rounded-lg p-2 text-center">
          <p className="text-xs text-slate-400">Worst Trade</p>
          <p className="font-bold text-red-400">{formatCurrency(summary.worstTrade)}</p>
        </div>
      </div>

      {/* Trades Table */}
      {loading ? (
        <div className="text-center py-8 text-slate-400">Loading trades...</div>
      ) : trades.length === 0 ? (
        <div className="text-center py-8 text-slate-400">
          <History className="h-12 w-12 mx-auto mb-2 opacity-50" />
          <p>No trades yet</p>
        </div>
      ) : (
        <>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-slate-400 border-b border-slate-700">
                  <th className="pb-2 font-medium">Asset</th>
                  <th className="pb-2 font-medium">Direction</th>
                  <th className="pb-2 font-medium">Side</th>
                  <th className="pb-2 font-medium">Entry</th>
                  <th className="pb-2 font-medium">Exit</th>
                  <th className="pb-2 font-medium text-right">P&L</th>
                  <th className="pb-2 font-medium text-right">Hold Time</th>
                  <th className="pb-2 font-medium">Reason</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-700/50">
                {paginatedTrades.map((trade) => (
                  <tr key={trade.id} className="hover:bg-slate-700/20">
                    <td className="py-2 font-medium text-white">{trade.asset}</td>
                    <td className="py-2">
                      <span className={clsx('badge', trade.direction === 'up' ? 'badge-green' : 'badge-red')}>
                        {trade.direction === 'up' ? <TrendingUp className="h-3 w-3" /> : <TrendingDown className="h-3 w-3" />}
                      </span>
                    </td>
                    <td className="py-2">
                      <span className={clsx('badge', trade.side === 'YES' ? 'badge-blue' : 'badge-yellow')}>
                        {trade.side}
                      </span>
                    </td>
                    <td className="py-2 text-slate-300">{trade.entryPrice.toFixed(4)}</td>
                    <td className="py-2 text-slate-300">{trade.exitPrice.toFixed(4)}</td>
                    <td className={clsx('py-2 text-right font-medium', trade.pnl >= 0 ? 'text-emerald-400' : 'text-red-400')}>
                      {formatCurrency(trade.pnl)}
                      <span className="text-xs ml-1">({formatPercent(trade.pnlPercent)})</span>
                    </td>
                    <td className="py-2 text-right text-slate-400">
                      <Clock className="h-3 w-3 inline mr-1" />
                      {Math.round(trade.holdDuration)}m
                    </td>
                    <td className="py-2">
                      <span className="badge badge-gray text-xs">{trade.exitReason}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Pagination */}
          {totalPages > 1 && (
            <div className="flex items-center justify-between mt-4 pt-4 border-t border-slate-700">
              <span className="text-sm text-slate-400">
                Showing {(page - 1) * pageSize + 1}-{Math.min(page * pageSize, trades.length)} of {trades.length}
              </span>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  disabled={page === 1}
                  className="p-1 rounded hover:bg-slate-700 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <ChevronLeft className="h-5 w-5" />
                </button>
                <span className="text-sm text-slate-300">
                  {page} / {totalPages}
                </span>
                <button
                  onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                  disabled={page === totalPages}
                  className="p-1 rounded hover:bg-slate-700 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <ChevronRight className="h-5 w-5" />
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
