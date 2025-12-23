import { useMemo } from 'react';
import { clsx } from 'clsx';
import type { CryptoAsset } from '../types';

interface OrderBookLevel {
  price: number;
  size: number;
  total: number;
}

interface MarketOrderBook {
  tokenId: string;
  asset: CryptoAsset;
  side: 'UP' | 'DOWN';
  bids: OrderBookLevel[];
  asks: OrderBookLevel[];
  spread: number;
  spreadPercent: number;
  midPrice: number;
  bidLiquidity: number;
  askLiquidity: number;
  lastUpdate: number;
}

interface OrderBookProps {
  orderbooks: MarketOrderBook[];
}

// Fixed asset order
const ASSETS: CryptoAsset[] = ['BTC', 'ETH', 'SOL', 'XRP'];
const SIDES: ('UP' | 'DOWN')[] = ['UP', 'DOWN'];

function formatPrice(price: number): string {
  return (price * 100).toFixed(1) + '%';
}

function formatSize(size: number): string {
  if (size >= 1000) {
    return (size / 1000).toFixed(1) + 'k';
  }
  return size.toFixed(0);
}

function formatUsd(value: number): string {
  if (value >= 1000) {
    return '$' + (value / 1000).toFixed(1) + 'k';
  }
  return '$' + value.toFixed(0);
}

function DepthBar({ value, max, side }: { value: number; max: number; side: 'bid' | 'ask' }) {
  const pct = max > 0 ? (value / max) * 100 : 0;
  return (
    <div className="absolute inset-0 pointer-events-none">
      <div
        className={clsx(
          'h-full transition-all duration-300',
          side === 'bid' ? 'bg-matrix-green/20 ml-auto' : 'bg-red-500/20'
        )}
        style={{ width: `${Math.min(pct, 100)}%` }}
      />
    </div>
  );
}

function SingleOrderBook({ book }: { book: MarketOrderBook | null; asset: CryptoAsset; side: 'UP' | 'DOWN' }) {
  if (!book) {
    return (
      <div className="bg-term-bg border border-term-border rounded p-3 opacity-50">
        <div className="flex justify-between items-center mb-2 pb-2 border-b border-term-border">
          <div className="flex items-center gap-2">
            <span className="font-bold text-term-dim">---</span>
            <span className="text-xs px-1.5 py-0.5 rounded bg-term-border/20 text-term-dim">
              --
            </span>
          </div>
          <div className="text-xs text-term-dim">
            Waiting...
          </div>
        </div>
        <div className="text-center text-term-dim text-xs py-4">
          No data
        </div>
      </div>
    );
  }

  const maxBidSize = Math.max(...book.bids.map(b => b.total), 1);
  const maxAskSize = Math.max(...book.asks.map(a => a.total), 1);

  return (
    <div className="bg-term-bg border border-term-border rounded p-3">
      {/* Header */}
      <div className="flex justify-between items-center mb-2 pb-2 border-b border-term-border">
        <div className="flex items-center gap-2">
          <span className="font-bold text-term-text">{book.asset}</span>
          <span className={clsx(
            'text-xs px-1.5 py-0.5 rounded',
            book.side === 'UP' ? 'bg-matrix-green/20 text-matrix-green' : 'bg-red-500/20 text-red-400'
          )}>
            {book.side}
          </span>
        </div>
        <div className="text-xs text-term-dim">
          {formatUsd(book.bidLiquidity + book.askLiquidity)} liq
        </div>
      </div>

      {/* Best Bid/Ask - what actually matters */}
      <div className="flex justify-between text-xs mb-2">
        <div className="text-center">
          <div className="text-term-dim">Best Bid</div>
          <div className="text-matrix-green font-bold">
            {book.bids[0] ? formatPrice(book.bids[0].price) : '--'}
          </div>
        </div>
        <div className="text-center">
          <div className="text-term-dim">Spread</div>
          <div className="text-term-yellow font-bold">
            {book.bids[0] && book.asks[0]
              ? ((book.asks[0].price - book.bids[0].price) * 100).toFixed(0) + 'pts'
              : '--'}
          </div>
        </div>
        <div className="text-center">
          <div className="text-term-dim">Best Ask</div>
          <div className="text-red-400 font-bold">
            {book.asks[0] ? formatPrice(book.asks[0].price) : '--'}
          </div>
        </div>
      </div>

      {/* Order Book Grid */}
      <div className="grid grid-cols-2 gap-2">
        {/* Bids */}
        <div>
          <div className="text-xs text-term-dim mb-1 grid grid-cols-2">
            <span>Bid</span>
            <span className="text-right">Size</span>
          </div>
          <div className="space-y-0.5">
            {book.bids.slice(0, 5).map((bid, i) => (
              <div key={`bid-${i}`} className="relative grid grid-cols-2 text-xs py-0.5 px-1 rounded">
                <DepthBar value={bid.total} max={maxBidSize} side="bid" />
                <span className="relative text-matrix-green">{formatPrice(bid.price)}</span>
                <span className="relative text-right text-term-text">{formatSize(bid.size)}</span>
              </div>
            ))}
            {book.bids.length === 0 && (
              <div className="text-xs text-term-dim italic text-center py-2">No bids</div>
            )}
          </div>
        </div>

        {/* Asks */}
        <div>
          <div className="text-xs text-term-dim mb-1 grid grid-cols-2">
            <span>Ask</span>
            <span className="text-right">Size</span>
          </div>
          <div className="space-y-0.5">
            {book.asks.slice(0, 5).map((ask, i) => (
              <div key={`ask-${i}`} className="relative grid grid-cols-2 text-xs py-0.5 px-1 rounded">
                <DepthBar value={ask.total} max={maxAskSize} side="ask" />
                <span className="relative text-red-400">{formatPrice(ask.price)}</span>
                <span className="relative text-right text-term-text">{formatSize(ask.size)}</span>
              </div>
            ))}
            {book.asks.length === 0 && (
              <div className="text-xs text-term-dim italic text-center py-2">No asks</div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export function OrderBook({ orderbooks }: OrderBookProps) {
  // Create a lookup map for quick access - keyed by "ASSET-SIDE"
  const bookMap = useMemo(() => {
    const map = new Map<string, MarketOrderBook>();
    for (const book of orderbooks) {
      map.set(`${book.asset}-${book.side}`, book);
    }
    return map;
  }, [orderbooks]);

  return (
    <div className="bg-term-panel border border-term-border rounded-lg p-4">
      <div className="flex justify-between items-center mb-3">
        <h2 className="text-lg font-bold text-term-text flex items-center gap-2">
          <span className="text-term-cyan">&gt;</span> Order Books
        </h2>
        <div className="text-xs text-term-dim">
          Live depth · Updates every 3s
        </div>
      </div>

      {/* Fixed 4x2 Grid: 4 assets × 2 sides (UP/DOWN) */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3">
        {ASSETS.map(asset => (
          <div key={asset} className="space-y-3">
            {SIDES.map(side => {
              const book = bookMap.get(`${asset}-${side}`) || null;
              return (
                <SingleOrderBook
                  key={`${asset}-${side}`}
                  book={book}
                  asset={asset}
                  side={side}
                />
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

export default OrderBook;
