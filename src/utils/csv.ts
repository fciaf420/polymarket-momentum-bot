/**
 * CSV Trade History Writer
 * Exports trade history to CSV format for analysis
 */

import fs from 'fs';
import path from 'path';
import type { TradeRecord } from '../types/index.js';
import logger from './logger.js';

const CSV_HEADERS = [
  'timestamp',
  'asset',
  'market',
  'side',
  'entry_price',
  'exit_price',
  'size',
  'cost_basis',
  'proceeds',
  'pnl',
  'pnl_percent',
  'hold_time_minutes',
  'exit_reason',
  'signal_gap',
  'signal_confidence',
  // Debug columns for execution analysis
  'is_orphaned',
  'order_latency_ms',
  'slippage',
  'expected_price',
  'market_spread_at_entry',
];

/**
 * Create CSV writer for trade history
 */
export class TradeHistoryWriter {
  private filePath: string;
  private initialized: boolean = false;

  constructor(filePath: string) {
    this.filePath = filePath;
    this.ensureDirectory();
  }

  /**
   * Ensure the directory exists
   */
  private ensureDirectory(): void {
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  /**
   * Initialize the CSV file with headers
   */
  private initialize(): void {
    if (this.initialized) return;

    // Check if file exists and has content
    if (fs.existsSync(this.filePath)) {
      const content = fs.readFileSync(this.filePath, 'utf-8');
      if (content.trim().length > 0) {
        this.initialized = true;
        return;
      }
    }

    // Write headers
    const headerRow = CSV_HEADERS.join(',') + '\n';
    fs.writeFileSync(this.filePath, headerRow, 'utf-8');
    this.initialized = true;

    logger.info(`Trade history CSV initialized: ${this.filePath}`);
  }

  /**
   * Escape a value for CSV
   */
  private escapeValue(value: string | number | undefined): string {
    if (value === undefined || value === null) {
      return '';
    }

    const str = String(value);

    // Escape quotes and wrap in quotes if contains special chars
    if (str.includes(',') || str.includes('"') || str.includes('\n')) {
      return `"${str.replace(/"/g, '""')}"`;
    }

    return str;
  }

  /**
   * Write a trade record to the CSV
   */
  public write(trade: TradeRecord): void {
    this.initialize();

    const row = [
      trade.timestamp,
      trade.asset,
      trade.market,
      trade.side,
      trade.entryPrice.toFixed(6),
      trade.exitPrice.toFixed(6),
      trade.size.toFixed(4),
      trade.costBasis.toFixed(2),
      trade.proceeds.toFixed(2),
      trade.pnl.toFixed(2),
      trade.pnlPercent.toFixed(4),
      trade.holdTimeMinutes.toFixed(2),
      trade.exitReason,
      trade.signalGap.toFixed(4),
      trade.signalConfidence.toFixed(4),
      // Debug fields
      trade.isOrphaned ? 'true' : 'false',
      trade.orderLatencyMs?.toFixed(0) ?? '',
      trade.slippage?.toFixed(4) ?? '',
      trade.expectedPrice?.toFixed(6) ?? '',
      trade.marketSpreadAtEntry?.toFixed(4) ?? '',
    ].map(v => this.escapeValue(v));

    const csvRow = row.join(',') + '\n';
    fs.appendFileSync(this.filePath, csvRow, 'utf-8');

    logger.debug(`Trade written to CSV: ${trade.asset} ${trade.side} PnL: ${trade.pnl.toFixed(2)}`);
  }

  /**
   * Write multiple trade records
   */
  public writeAll(trades: TradeRecord[]): void {
    for (const trade of trades) {
      this.write(trade);
    }
  }

  /**
   * Read all trades from the CSV
   */
  public readAll(): TradeRecord[] {
    if (!fs.existsSync(this.filePath)) {
      return [];
    }

    const content = fs.readFileSync(this.filePath, 'utf-8');
    const lines = content.trim().split('\n');

    if (lines.length <= 1) {
      return [];
    }

    // Skip header row
    const trades: TradeRecord[] = [];

    for (let i = 1; i < lines.length; i++) {
      const values = this.parseCsvLine(lines[i]);

      // Need at least the core 15 columns (debug fields are optional for backwards compatibility)
      if (values.length < 15) {
        continue;
      }

      trades.push({
        timestamp: values[0],
        asset: values[1] as TradeRecord['asset'],
        market: values[2],
        side: values[3] as TradeRecord['side'],
        entryPrice: parseFloat(values[4]),
        exitPrice: parseFloat(values[5]),
        size: parseFloat(values[6]),
        costBasis: parseFloat(values[7]),
        proceeds: parseFloat(values[8]),
        pnl: parseFloat(values[9]),
        pnlPercent: parseFloat(values[10]),
        holdTimeMinutes: parseFloat(values[11]),
        exitReason: values[12] as TradeRecord['exitReason'],
        signalGap: parseFloat(values[13]),
        signalConfidence: parseFloat(values[14]),
        // Debug fields (may not exist in older CSVs)
        isOrphaned: values[15] === 'true',
        orderLatencyMs: values[16] ? parseFloat(values[16]) : undefined,
        slippage: values[17] ? parseFloat(values[17]) : undefined,
        expectedPrice: values[18] ? parseFloat(values[18]) : undefined,
        marketSpreadAtEntry: values[19] ? parseFloat(values[19]) : undefined,
      });
    }

    return trades;
  }

  /**
   * Parse a CSV line handling quoted values
   */
  private parseCsvLine(line: string): string[] {
    const values: string[] = [];
    let current = '';
    let inQuotes = false;

    for (let i = 0; i < line.length; i++) {
      const char = line[i];
      const nextChar = line[i + 1];

      if (char === '"') {
        if (inQuotes && nextChar === '"') {
          current += '"';
          i++; // Skip next quote
        } else {
          inQuotes = !inQuotes;
        }
      } else if (char === ',' && !inQuotes) {
        values.push(current);
        current = '';
      } else {
        current += char;
      }
    }

    values.push(current);
    return values;
  }

  /**
   * Get summary statistics from trade history
   */
  public getSummary(): {
    totalTrades: number;
    winningTrades: number;
    losingTrades: number;
    winRate: number;
    totalPnl: number;
    averagePnl: number;
    averageHoldTime: number;
    bestTrade: number;
    worstTrade: number;
  } {
    const trades = this.readAll();

    if (trades.length === 0) {
      return {
        totalTrades: 0,
        winningTrades: 0,
        losingTrades: 0,
        winRate: 0,
        totalPnl: 0,
        averagePnl: 0,
        averageHoldTime: 0,
        bestTrade: 0,
        worstTrade: 0,
      };
    }

    const winningTrades = trades.filter(t => t.pnl > 0);
    const losingTrades = trades.filter(t => t.pnl <= 0);
    const totalPnl = trades.reduce((sum, t) => sum + t.pnl, 0);
    const averageHoldTime = trades.reduce((sum, t) => sum + t.holdTimeMinutes, 0) / trades.length;
    const pnls = trades.map(t => t.pnl);

    return {
      totalTrades: trades.length,
      winningTrades: winningTrades.length,
      losingTrades: losingTrades.length,
      winRate: winningTrades.length / trades.length,
      totalPnl,
      averagePnl: totalPnl / trades.length,
      averageHoldTime,
      bestTrade: Math.max(...pnls),
      worstTrade: Math.min(...pnls),
    };
  }
}

/**
 * Create a default trade history writer
 */
export function createTradeHistoryWriter(filePath?: string): TradeHistoryWriter {
  const path = filePath || process.env.TRADE_HISTORY_PATH || './trades.csv';
  return new TradeHistoryWriter(path);
}
