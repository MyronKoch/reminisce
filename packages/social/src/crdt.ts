/**
 * CRDT implementation for conflict-free memory synchronization
 * Uses Last-Write-Wins (LWW) Register pattern
 */

import type { VectorClock, CRDTNode, LWWRegister } from './types.js';

/**
 * Compare two vector clocks
 * Returns:
 *   positive if a > b
 *   negative if a < b
 *   0 if equal
 */
export function compareClocks(a: VectorClock, b: VectorClock): number {
  // First compare timestamps
  if (a.timestamp !== b.timestamp) {
    return a.timestamp - b.timestamp;
  }

  // Tie-break by machineId (lexicographic)
  return a.machineId.localeCompare(b.machineId);
}

/**
 * Create a new CRDT node
 */
export function createNode<T>(
  value: T,
  clock: VectorClock,
  tombstone = false
): CRDTNode<T> {
  return {
    value,
    clock,
    tombstone,
  };
}

/**
 * Create an empty LWW register
 */
export function createRegister<T>(): LWWRegister<T> {
  return {
    current: null,
    history: [],
  };
}

/**
 * Update a register with a new value
 * Returns true if the value was updated (new clock > old clock)
 */
export function updateRegister<T>(
  register: LWWRegister<T>,
  value: T,
  clock: VectorClock,
  tombstone = false
): boolean {
  const node = createNode(value, clock, tombstone);

  // If no current value, always accept
  if (!register.current) {
    register.current = node;
    register.history.push(node);
    return true;
  }

  // Compare clocks - only update if new clock is greater
  const comparison = compareClocks(clock, register.current.clock);

  if (comparison > 0) {
    register.current = node;
    register.history.push(node);
    return true;
  }

  // Even if we don't update current, add to history if different
  if (comparison === 0 && register.current !== node) {
    register.history.push(node);
  }

  return false;
}

/**
 * Merge two registers (for sync)
 * Returns true if the first register was updated
 */
export function mergeRegisters<T>(
  local: LWWRegister<T>,
  remote: LWWRegister<T>
): boolean {
  if (!remote.current) {
    return false;
  }

  return updateRegister(
    local,
    remote.current.value,
    remote.current.clock,
    remote.current.tombstone
  );
}

/**
 * Get the current value of a register (null if deleted/empty)
 */
export function getValue<T>(register: LWWRegister<T>): T | null {
  if (!register.current || register.current.tombstone) {
    return null;
  }
  return register.current.value;
}

/**
 * Mark a register as deleted by setting tombstone
 */
export function deleteRegister<T>(
  register: LWWRegister<T>,
  clock: VectorClock
): boolean {
  if (!register.current) {
    return false;
  }

  return updateRegister(
    register,
    register.current.value,
    clock,
    true
  );
}

/**
 * Check if a register has been deleted
 */
export function isDeleted<T>(register: LWWRegister<T>): boolean {
  return register.current?.tombstone ?? false;
}

/**
 * Get the last modification time of a register
 */
export function getLastModified<T>(register: LWWRegister<T>): number {
  return register.current?.clock.timestamp ?? 0;
}
