/**
 * Memory ID - Cross-layer identifier with provenance tracking
 *
 * Uses UUID v7 for time-sortability (timestamp embedded in ID).
 * Every memory in the system gets a MemoryID regardless of layer.
 */

export type MemoryLayer = 'working' | 'episodic' | 'semantic' | 'procedural';

export interface MemoryID {
  /** UUID v7 - time-sortable unique identifier */
  id: string;

  /** Which memory layer this belongs to */
  layer: MemoryLayer;

  /** When this memory was created */
  created_at: Date;

  /** Session that created this memory */
  source_session: string;

  /** Machine/agent that created this memory */
  source_machine: string;
}

/**
 * Create a new MemoryID
 *
 * @param layer - The memory layer
 * @param session - Session identifier
 * @param machine - Machine/agent identifier
 */
export function createMemoryID(
  layer: MemoryLayer,
  session: string,
  machine: string
): MemoryID {
  return {
    id: generateUUIDv7(),
    layer,
    created_at: new Date(),
    source_session: session,
    source_machine: machine,
  };
}

/**
 * Parse a MemoryID from a string (for cross-layer references)
 */
export function parseMemoryID(idString: string): MemoryID | null {
  try {
    const parsed = JSON.parse(idString);
    if (isValidMemoryID(parsed)) {
      return {
        ...parsed,
        created_at: new Date(parsed.created_at),
      };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Serialize a MemoryID for storage/transmission
 */
export function serializeMemoryID(memoryId: MemoryID): string {
  return JSON.stringify({
    ...memoryId,
    created_at: memoryId.created_at.toISOString(),
  });
}

/**
 * Type guard for MemoryID
 */
export function isValidMemoryID(obj: unknown): obj is MemoryID {
  if (typeof obj !== 'object' || obj === null) return false;
  const candidate = obj as Record<string, unknown>;

  return (
    typeof candidate.id === 'string' &&
    typeof candidate.layer === 'string' &&
    ['working', 'episodic', 'semantic', 'procedural'].includes(candidate.layer) &&
    (candidate.created_at instanceof Date || typeof candidate.created_at === 'string') &&
    typeof candidate.source_session === 'string' &&
    typeof candidate.source_machine === 'string'
  );
}

/**
 * Generate UUID v7 (time-sortable)
 *
 * Format: tttttttt-tttt-7xxx-yxxx-xxxxxxxxxxxx
 * Where t = timestamp, 7 = version, y = variant (8,9,a,b), x = random
 */
function generateUUIDv7(): string {
  const now = Date.now();
  const timestamp = now.toString(16).padStart(12, '0');

  // Random bytes for the rest
  const randomBytes = new Uint8Array(10);
  crypto.getRandomValues(randomBytes);

  // Build UUID v7
  const hex = Array.from(randomBytes)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');

  // tttttttt-tttt-7xxx-yxxx-xxxxxxxxxxxx
  return [
    timestamp.slice(0, 8),
    timestamp.slice(8, 12),
    '7' + hex.slice(0, 3),
    ((parseInt(hex.slice(3, 4), 16) & 0x3) | 0x8).toString(16) + hex.slice(4, 7),
    hex.slice(7, 19),
  ].join('-');
}
