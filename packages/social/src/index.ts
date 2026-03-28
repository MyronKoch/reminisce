/**
 * @reminisce/social - Cross-machine memory synchronization
 *
 * Provides CRDT-based conflict-free synchronization of memories across
 * multiple machines using file-based transport (e.g., Syncthing).
 *
 * @packageDocumentation
 */

// Export types
export type {
  MachineID,
  VectorClock,
  CRDTNode,
  LWWRegister,
  SyncMessageType,
  SyncMessage,
  MachinePeer,
  SyncState,
  SyncEngineConfig,
  SyncStats,
  SyncTriggerMode,
} from './types.js';

// Export CRDT utilities
export {
  compareClocks,
  createNode,
  createRegister,
  updateRegister,
  mergeRegisters,
  getValue,
  deleteRegister,
  isDeleted,
  getLastModified,
} from './crdt.js';

// Export sync engine
export { SyncEngine } from './sync-engine.js';

// Export file transport
export { FileTransport } from './file-transport.js';

// Export file watcher
export {
  FileWatcher,
  createSyncTrigger,
  type FileWatcherConfig,
  type FileWatcherEvent,
  type FileWatcherCallback,
} from './file-watcher.js';

// Version info
export const VERSION = '0.1.0';
