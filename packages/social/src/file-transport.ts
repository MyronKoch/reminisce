/**
 * File-based transport for memory synchronization
 * Writes sync messages as JSON files to a shared directory (e.g., Syncthing)
 */

import { writeFile, readFile, readdir, mkdir, rm } from 'node:fs/promises';
import { join, basename } from 'node:path';
import type { SyncMessage, MachineID } from './types.js';

/**
 * File naming convention: {timestamp}-{machineId}.json
 */
function createSyncFileName(machineId: MachineID, timestamp: number): string {
  return `${timestamp}-${machineId}.json`;
}

/**
 * Parse machine ID and timestamp from filename
 */
function parseSyncFileName(filename: string): { machineId: MachineID; timestamp: number } | null {
  const match = filename.match(/^(\d+)-(.+)\.json$/);
  if (!match) {
    return null;
  }

  return {
    timestamp: parseInt(match[1]!, 10),
    machineId: match[2]!,
  };
}

/**
 * File transport for sync messages
 */
export class FileTransport {
  private syncDir: string;
  private machineId: MachineID;

  constructor(syncDir: string, machineId: MachineID) {
    this.syncDir = syncDir;
    this.machineId = machineId;
  }

  /**
   * Initialize the sync directory
   */
  async initialize(): Promise<void> {
    try {
      await mkdir(this.syncDir, { recursive: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw error;
      }
    }
  }

  /**
   * Write a sync message to the shared directory
   */
  async writeSyncMessage(message: SyncMessage): Promise<string> {
    const filename = createSyncFileName(this.machineId, message.timestamp);
    const filepath = join(this.syncDir, filename);

    await writeFile(filepath, JSON.stringify(message, null, 2), 'utf-8');

    return filename;
  }

  /**
   * Read all sync messages from other machines since a given timestamp
   */
  async readSyncMessages(sinceTimestamp: number): Promise<SyncMessage[]> {
    const files = await readdir(this.syncDir);
    const messages: SyncMessage[] = [];

    for (const file of files) {
      const parsed = parseSyncFileName(file);

      // Skip if not a sync file, from this machine, or older than requested
      if (!parsed || parsed.machineId === this.machineId || parsed.timestamp <= sinceTimestamp) {
        continue;
      }

      try {
        const filepath = join(this.syncDir, file);
        const content = await readFile(filepath, 'utf-8');
        const message = JSON.parse(content) as SyncMessage;
        messages.push(message);
      } catch (error) {
        console.warn(`Failed to read sync file ${file}:`, error);
      }
    }

    // Sort by timestamp
    return messages.sort((a, b) => a.timestamp - b.timestamp);
  }

  /**
   * Clean up old sync messages older than retentionMs
   */
  async cleanup(retentionMs: number): Promise<number> {
    const cutoff = Date.now() - retentionMs;
    const files = await readdir(this.syncDir);
    let deleted = 0;

    for (const file of files) {
      const parsed = parseSyncFileName(file);

      if (parsed && parsed.timestamp < cutoff) {
        try {
          await rm(join(this.syncDir, file));
          deleted++;
        } catch (error) {
          console.warn(`Failed to delete old sync file ${file}:`, error);
        }
      }
    }

    return deleted;
  }

  /**
   * Get list of peer machines that have written sync files
   */
  async getPeerMachines(): Promise<Set<MachineID>> {
    const files = await readdir(this.syncDir);
    const peers = new Set<MachineID>();

    for (const file of files) {
      const parsed = parseSyncFileName(file);

      if (parsed && parsed.machineId !== this.machineId) {
        peers.add(parsed.machineId);
      }
    }

    return peers;
  }

  /**
   * Get the latest timestamp from a specific peer
   */
  async getLatestPeerTimestamp(peerId: MachineID): Promise<number> {
    const files = await readdir(this.syncDir);
    let latest = 0;

    for (const file of files) {
      const parsed = parseSyncFileName(file);

      if (parsed && parsed.machineId === peerId) {
        latest = Math.max(latest, parsed.timestamp);
      }
    }

    return latest;
  }
}
