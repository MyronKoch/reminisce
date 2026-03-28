/**
 * File watcher for reactive sync triggers
 *
 * Watches the sync directory for changes and triggers sync operations
 * when new files are detected. More efficient than polling for Syncthing
 * and similar file-sync services.
 */

import { watch, type FSWatcher } from 'node:fs';
import { join, basename } from 'node:path';
import { stat } from 'node:fs/promises';
import type { MachineID } from './types.js';

/**
 * File watcher events
 */
export type FileWatcherEvent = 'sync-file-added' | 'sync-file-changed' | 'sync-file-removed';

/**
 * Callback for file change events
 */
export type FileWatcherCallback = (event: FileWatcherEvent, filename: string, machineId?: MachineID) => void;

/**
 * File watcher configuration
 */
export interface FileWatcherConfig {
  /** Directory to watch */
  syncDirectory: string;

  /** This machine's ID (to ignore own files) */
  machineId: MachineID;

  /** Debounce delay in ms (default: 100) */
  debounceMs?: number | undefined;

  /** Only watch files from specific peers (empty = all) */
  peerFilter?: MachineID[] | undefined;
}

/**
 * Parse machine ID from sync filename
 */
function parseMachineId(filename: string): MachineID | null {
  const match = filename.match(/^(\d+)-(.+)\.json$/);
  return match ? match[2]! : null;
}

/**
 * Check if a file is a valid sync file
 */
function isSyncFile(filename: string): boolean {
  return /^\d+-[^/]+\.json$/.test(filename);
}

/**
 * Internal config type with required fields
 */
interface FileWatcherConfigInternal {
  syncDirectory: string;
  machineId: MachineID;
  debounceMs: number;
  peerFilter: MachineID[];
}

/**
 * File watcher for sync directory
 */
export class FileWatcher {
  private config: FileWatcherConfigInternal;
  private watcher: FSWatcher | null = null;
  private callbacks: Set<FileWatcherCallback> = new Set();
  private debounceTimer: NodeJS.Timeout | null = null;
  private pendingEvents: Map<string, FileWatcherEvent> = new Map();
  private isRunning = false;

  constructor(config: FileWatcherConfig) {
    this.config = {
      syncDirectory: config.syncDirectory,
      machineId: config.machineId,
      debounceMs: config.debounceMs ?? 100,
      peerFilter: config.peerFilter ?? [],
    };
  }

  /**
   * Start watching the sync directory
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      return;
    }

    // Verify directory exists
    try {
      const stats = await stat(this.config.syncDirectory);
      if (!stats.isDirectory()) {
        throw new Error(`${this.config.syncDirectory} is not a directory`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new Error(`Sync directory does not exist: ${this.config.syncDirectory}`);
      }
      throw error;
    }

    this.watcher = watch(this.config.syncDirectory, { persistent: false }, (eventType, filename) => {
      if (!filename || !isSyncFile(filename)) {
        return;
      }

      const machineId = parseMachineId(filename);

      // Skip our own files
      if (machineId === this.config.machineId) {
        return;
      }

      // Apply peer filter if specified
      if (this.config.peerFilter.length > 0 && machineId && !this.config.peerFilter.includes(machineId)) {
        return;
      }

      // Map fs.watch event types to our events
      const event: FileWatcherEvent = eventType === 'rename' ? 'sync-file-added' : 'sync-file-changed';

      this.queueEvent(filename, event, machineId ?? undefined);
    });

    this.watcher.on('error', (error) => {
      console.error('File watcher error:', error);
    });

    this.isRunning = true;
  }

  /**
   * Stop watching
   */
  stop(): void {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }

    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }

    this.pendingEvents.clear();
    this.isRunning = false;
  }

  /**
   * Register a callback for file events
   */
  onFileChange(callback: FileWatcherCallback): () => void {
    this.callbacks.add(callback);
    return () => this.callbacks.delete(callback);
  }

  /**
   * Check if watcher is running
   */
  get running(): boolean {
    return this.isRunning;
  }

  /**
   * Queue an event for debounced processing
   */
  private queueEvent(filename: string, event: FileWatcherEvent, machineId?: MachineID): void {
    this.pendingEvents.set(filename, event);

    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }

    this.debounceTimer = setTimeout(() => {
      this.flushEvents();
    }, this.config.debounceMs);
  }

  /**
   * Flush pending events to callbacks
   */
  private flushEvents(): void {
    for (const [filename, event] of this.pendingEvents) {
      const machineId = parseMachineId(filename) ?? undefined;

      for (const callback of this.callbacks) {
        try {
          callback(event, filename, machineId);
        } catch (error) {
          console.error('File watcher callback error:', error);
        }
      }
    }

    this.pendingEvents.clear();
    this.debounceTimer = null;
  }
}

/**
 * Create a file watcher that triggers sync on changes
 */
export function createSyncTrigger(
  syncDirectory: string,
  machineId: MachineID,
  onSync: () => Promise<void> | void,
  options: { debounceMs?: number } = {}
): FileWatcher {
  const watcher = new FileWatcher({
    syncDirectory,
    machineId,
    debounceMs: options.debounceMs ?? 100,
  });

  watcher.onFileChange(async (event, filename) => {
    try {
      await onSync();
    } catch (error) {
      console.error('Sync trigger error:', error);
    }
  });

  return watcher;
}
