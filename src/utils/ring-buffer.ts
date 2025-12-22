/**
 * High-Performance Ring Buffer for Price History
 *
 * Provides O(1) push operations with time-based expiration for maintaining
 * rolling price windows. Optimized for high-frequency trading scenarios
 * where price updates occur ~50 times per second.
 *
 * @example
 * ```typescript
 * // Create a 10-minute rolling window with max 3000 entries
 * const buffer = new RingBuffer<PricePoint>(3000, 10 * 60 * 1000);
 *
 * // O(1) push
 * buffer.push({ price: 100.5, timestamp: Date.now() });
 *
 * // Iterate for indicator calculations
 * for (const point of buffer) {
 *   // process point
 * }
 *
 * // Convert to array for backward compatibility
 * const prices = buffer.toArray();
 * ```
 */

/**
 * Interface for items that have a timestamp property.
 * Required for time-based expiration functionality.
 */
export interface Timestamped {
  timestamp: number;
}

/**
 * Ring buffer statistics for monitoring and debugging.
 */
export interface RingBufferStats {
  /** Current number of valid entries */
  size: number;
  /** Maximum capacity of the buffer */
  capacity: number;
  /** Utilization percentage (size / capacity) */
  utilization: number;
  /** Number of entries expired since last cleanup */
  expiredCount: number;
  /** Total number of push operations */
  totalPushes: number;
  /** Total number of entries that have been evicted (overflow or expiration) */
  totalEvictions: number;
}

/**
 * High-performance circular buffer with time-based expiration.
 *
 * Key performance characteristics:
 * - O(1) push operations
 * - O(1) size queries
 * - O(n) iteration (where n is the number of valid entries)
 * - O(n) toArray conversion
 * - Amortized O(1) time-based cleanup on push
 *
 * Memory is pre-allocated for the maximum capacity to avoid
 * garbage collection during high-frequency operations.
 *
 * @typeParam T - The type of elements stored, must have a timestamp property
 */
export class RingBuffer<T extends Timestamped> implements Iterable<T> {
  /** Pre-allocated circular buffer storage */
  private readonly buffer: Array<T | undefined>;

  /** Maximum number of elements the buffer can hold */
  private readonly capacity: number;

  /** Time-to-live in milliseconds for entries */
  private readonly ttlMs: number;

  /** Index where the next element will be written (tail of the buffer) */
  private writeIndex: number = 0;

  /** Index of the oldest valid element (head of the buffer) */
  private readIndex: number = 0;

  /** Current number of valid elements in the buffer */
  private _size: number = 0;

  /** Statistics tracking */
  private _totalPushes: number = 0;
  private _totalEvictions: number = 0;
  private _lastExpiredCount: number = 0;

  /**
   * Creates a new RingBuffer instance.
   *
   * @param capacity - Maximum number of elements to store.
   *                   For a 10-minute window at 50 updates/second, use 3000+.
   * @param ttlMs - Time-to-live in milliseconds. Entries older than this
   *                are considered expired and will be cleaned up.
   *                Default is 10 minutes (600,000ms).
   *
   * @throws Error if capacity is less than 1
   * @throws Error if ttlMs is less than 0
   */
  constructor(capacity: number, ttlMs: number = 10 * 60 * 1000) {
    if (capacity < 1) {
      throw new Error('RingBuffer capacity must be at least 1');
    }
    if (ttlMs < 0) {
      throw new Error('RingBuffer TTL must be non-negative');
    }

    this.capacity = capacity;
    this.ttlMs = ttlMs;
    // Pre-allocate array with undefined slots
    this.buffer = new Array<T | undefined>(capacity);
  }

  /**
   * Returns the current number of valid (non-expired) entries.
   *
   * @returns Number of entries in the buffer
   *
   * @complexity O(1)
   */
  public get size(): number {
    return this._size;
  }

  /**
   * Returns the maximum capacity of the buffer.
   *
   * @returns Maximum number of entries the buffer can hold
   */
  public get maxCapacity(): number {
    return this.capacity;
  }

  /**
   * Checks if the buffer is empty.
   *
   * @returns true if the buffer contains no valid entries
   *
   * @complexity O(1)
   */
  public get isEmpty(): boolean {
    return this._size === 0;
  }

  /**
   * Checks if the buffer is at capacity.
   *
   * @returns true if the buffer is full
   *
   * @complexity O(1)
   */
  public get isFull(): boolean {
    return this._size === this.capacity;
  }

  /**
   * Pushes a new element to the buffer.
   *
   * If the buffer is full, the oldest element is evicted.
   * Before pushing, expired entries from the head are cleaned up.
   *
   * @param item - The item to push (must have a timestamp property)
   *
   * @complexity O(1) amortized (cleanup is amortized over multiple pushes)
   */
  public push(item: T): void {
    this._totalPushes++;

    // Clean up expired entries from the head before pushing
    this.cleanupExpired(item.timestamp);

    // If buffer is full after cleanup, evict the oldest entry
    if (this._size === this.capacity) {
      this.readIndex = (this.readIndex + 1) % this.capacity;
      this._size--;
      this._totalEvictions++;
    }

    // Write the new item at the tail
    this.buffer[this.writeIndex] = item;
    this.writeIndex = (this.writeIndex + 1) % this.capacity;
    this._size++;
  }

  /**
   * Removes expired entries from the head of the buffer.
   *
   * This is called automatically during push operations, but can also
   * be called manually to clean up before iteration.
   *
   * @param currentTimestamp - The current timestamp to compare against.
   *                           Defaults to Date.now().
   *
   * @complexity O(k) where k is the number of expired entries
   */
  public cleanupExpired(currentTimestamp: number = Date.now()): void {
    const cutoff = currentTimestamp - this.ttlMs;
    let expiredCount = 0;

    while (this._size > 0) {
      const item = this.buffer[this.readIndex];
      if (item && item.timestamp >= cutoff) {
        break; // Found a non-expired entry
      }

      // Clear the expired entry for GC
      this.buffer[this.readIndex] = undefined;
      this.readIndex = (this.readIndex + 1) % this.capacity;
      this._size--;
      expiredCount++;
      this._totalEvictions++;
    }

    this._lastExpiredCount = expiredCount;
  }

  /**
   * Returns the oldest (first) valid entry without removing it.
   *
   * @returns The oldest entry, or undefined if the buffer is empty
   *
   * @complexity O(1)
   */
  public peek(): T | undefined {
    if (this._size === 0) {
      return undefined;
    }
    return this.buffer[this.readIndex];
  }

  /**
   * Returns the newest (last) valid entry without removing it.
   *
   * @returns The newest entry, or undefined if the buffer is empty
   *
   * @complexity O(1)
   */
  public peekLast(): T | undefined {
    if (this._size === 0) {
      return undefined;
    }
    // writeIndex points to the next empty slot, so the last item is at writeIndex - 1
    const lastIndex = (this.writeIndex - 1 + this.capacity) % this.capacity;
    return this.buffer[lastIndex];
  }

  /**
   * Converts the buffer contents to an array.
   *
   * Returns entries in chronological order (oldest first).
   * This method is provided for backward compatibility with code
   * that expects arrays.
   *
   * @returns Array of all valid entries in chronological order
   *
   * @complexity O(n) where n is the number of entries
   */
  public toArray(): T[] {
    const result: T[] = [];
    result.length = this._size; // Pre-allocate for performance

    let writePos = 0;
    let index = this.readIndex;
    for (let i = 0; i < this._size; i++) {
      const item = this.buffer[index];
      if (item !== undefined) {
        result[writePos++] = item;
      }
      index = (index + 1) % this.capacity;
    }

    return result;
  }

  /**
   * Returns the entries within a specific time window.
   *
   * Useful for calculating indicators over different periods without
   * converting the entire buffer to an array.
   *
   * @param windowMs - The time window in milliseconds from the current timestamp
   * @param currentTimestamp - The current timestamp. Defaults to Date.now().
   *
   * @returns Array of entries within the time window
   *
   * @complexity O(n) where n is the number of entries in the window
   */
  public getWindow(windowMs: number, currentTimestamp: number = Date.now()): T[] {
    const cutoff = currentTimestamp - windowMs;
    const result: T[] = [];

    let index = this.readIndex;
    for (let i = 0; i < this._size; i++) {
      const item = this.buffer[index];
      if (item !== undefined && item.timestamp >= cutoff) {
        result.push(item);
      }
      index = (index + 1) % this.capacity;
    }

    return result;
  }

  /**
   * Clears all entries from the buffer.
   *
   * @complexity O(n) for clearing references (allows GC)
   */
  public clear(): void {
    for (let i = 0; i < this.capacity; i++) {
      this.buffer[i] = undefined;
    }
    this.writeIndex = 0;
    this.readIndex = 0;
    this._size = 0;
  }

  /**
   * Returns buffer statistics for monitoring.
   *
   * @returns Statistics object with size, capacity, utilization, etc.
   */
  public getStats(): RingBufferStats {
    return {
      size: this._size,
      capacity: this.capacity,
      utilization: this.capacity > 0 ? this._size / this.capacity : 0,
      expiredCount: this._lastExpiredCount,
      totalPushes: this._totalPushes,
      totalEvictions: this._totalEvictions,
    };
  }

  /**
   * Implements the Iterable interface for for...of loops.
   *
   * Iterates over all valid entries in chronological order (oldest first).
   *
   * @yields Each valid entry in the buffer
   *
   * @example
   * ```typescript
   * for (const point of buffer) {
   *   console.log(point.price, point.timestamp);
   * }
   * ```
   *
   * @complexity O(n) for full iteration
   */
  public *[Symbol.iterator](): Iterator<T> {
    let index = this.readIndex;
    for (let i = 0; i < this._size; i++) {
      const item = this.buffer[index];
      if (item !== undefined) {
        yield item;
      }
      index = (index + 1) % this.capacity;
    }
  }

  /**
   * Iterates over entries in reverse chronological order (newest first).
   *
   * Useful when you only need to process recent entries.
   *
   * @yields Each valid entry in reverse chronological order
   *
   * @example
   * ```typescript
   * for (const point of buffer.reverseIterator()) {
   *   if (someCondition(point)) break; // Early exit
   * }
   * ```
   */
  public *reverseIterator(): Generator<T, void, undefined> {
    let index = (this.writeIndex - 1 + this.capacity) % this.capacity;
    for (let i = 0; i < this._size; i++) {
      const item = this.buffer[index];
      if (item !== undefined) {
        yield item;
      }
      index = (index - 1 + this.capacity) % this.capacity;
    }
  }

  /**
   * Applies a reducer function over the buffer contents.
   *
   * More memory-efficient than toArray().reduce() for simple aggregations.
   *
   * @param fn - Reducer function
   * @param initialValue - Initial accumulator value
   *
   * @returns The final accumulated value
   *
   * @example
   * ```typescript
   * const sum = buffer.reduce((acc, point) => acc + point.price, 0);
   * const avg = sum / buffer.size;
   * ```
   *
   * @complexity O(n)
   */
  public reduce<U>(fn: (accumulator: U, item: T, index: number) => U, initialValue: U): U {
    let accumulator = initialValue;
    let itemIndex = 0;
    let bufferIndex = this.readIndex;

    for (let i = 0; i < this._size; i++) {
      const item = this.buffer[bufferIndex];
      if (item !== undefined) {
        accumulator = fn(accumulator, item, itemIndex++);
      }
      bufferIndex = (bufferIndex + 1) % this.capacity;
    }

    return accumulator;
  }

  /**
   * Finds entries matching a predicate.
   *
   * @param predicate - Function to test each entry
   *
   * @returns Array of matching entries
   *
   * @complexity O(n)
   */
  public filter(predicate: (item: T, index: number) => boolean): T[] {
    const result: T[] = [];
    let itemIndex = 0;
    let bufferIndex = this.readIndex;

    for (let i = 0; i < this._size; i++) {
      const item = this.buffer[bufferIndex];
      if (item !== undefined && predicate(item, itemIndex++)) {
        result.push(item);
      }
      bufferIndex = (bufferIndex + 1) % this.capacity;
    }

    return result;
  }

  /**
   * Maps entries to a new array.
   *
   * @param fn - Mapping function
   *
   * @returns Array of mapped values
   *
   * @complexity O(n)
   */
  public map<U>(fn: (item: T, index: number) => U): U[] {
    const result: U[] = [];
    result.length = this._size;

    let itemIndex = 0;
    let bufferIndex = this.readIndex;

    for (let i = 0; i < this._size; i++) {
      const item = this.buffer[bufferIndex];
      if (item !== undefined) {
        result[itemIndex] = fn(item, itemIndex);
        itemIndex++;
      }
      bufferIndex = (bufferIndex + 1) % this.capacity;
    }

    return result;
  }

  /**
   * Finds the first entry matching a predicate.
   *
   * @param predicate - Function to test each entry
   *
   * @returns The first matching entry, or undefined if none found
   *
   * @complexity O(n) worst case, but stops at first match
   */
  public find(predicate: (item: T, index: number) => boolean): T | undefined {
    let itemIndex = 0;
    let bufferIndex = this.readIndex;

    for (let i = 0; i < this._size; i++) {
      const item = this.buffer[bufferIndex];
      if (item !== undefined && predicate(item, itemIndex++)) {
        return item;
      }
      bufferIndex = (bufferIndex + 1) % this.capacity;
    }

    return undefined;
  }

  /**
   * Checks if any entry matches a predicate.
   *
   * @param predicate - Function to test each entry
   *
   * @returns true if at least one entry matches
   *
   * @complexity O(n) worst case, but stops at first match
   */
  public some(predicate: (item: T, index: number) => boolean): boolean {
    return this.find(predicate) !== undefined;
  }

  /**
   * Checks if all entries match a predicate.
   *
   * @param predicate - Function to test each entry
   *
   * @returns true if all entries match (or buffer is empty)
   *
   * @complexity O(n)
   */
  public every(predicate: (item: T, index: number) => boolean): boolean {
    let itemIndex = 0;
    let bufferIndex = this.readIndex;

    for (let i = 0; i < this._size; i++) {
      const item = this.buffer[bufferIndex];
      if (item !== undefined && !predicate(item, itemIndex++)) {
        return false;
      }
      bufferIndex = (bufferIndex + 1) % this.capacity;
    }

    return true;
  }

  /**
   * Executes a function for each entry.
   *
   * @param fn - Function to execute for each entry
   *
   * @complexity O(n)
   */
  public forEach(fn: (item: T, index: number) => void): void {
    let itemIndex = 0;
    let bufferIndex = this.readIndex;

    for (let i = 0; i < this._size; i++) {
      const item = this.buffer[bufferIndex];
      if (item !== undefined) {
        fn(item, itemIndex++);
      }
      bufferIndex = (bufferIndex + 1) % this.capacity;
    }
  }

  /**
   * Returns the entry at the specified index (0-based from oldest).
   *
   * @param index - The index of the entry to retrieve
   *
   * @returns The entry at the index, or undefined if out of bounds
   *
   * @complexity O(1)
   */
  public at(index: number): T | undefined {
    if (index < 0 || index >= this._size) {
      return undefined;
    }

    const bufferIndex = (this.readIndex + index) % this.capacity;
    return this.buffer[bufferIndex];
  }

  /**
   * Returns a slice of the buffer as an array.
   *
   * @param start - Start index (inclusive, from oldest)
   * @param end - End index (exclusive). If omitted, slices to the end.
   *
   * @returns Array of entries in the specified range
   *
   * @complexity O(end - start)
   */
  public slice(start: number, end?: number): T[] {
    const actualEnd = end === undefined ? this._size : Math.min(end, this._size);
    const actualStart = Math.max(0, start);

    if (actualStart >= actualEnd) {
      return [];
    }

    const result: T[] = [];
    result.length = actualEnd - actualStart;

    let writePos = 0;
    for (let i = actualStart; i < actualEnd; i++) {
      const bufferIndex = (this.readIndex + i) % this.capacity;
      const item = this.buffer[bufferIndex];
      if (item !== undefined) {
        result[writePos++] = item;
      }
    }

    return result;
  }
}

export default RingBuffer;
