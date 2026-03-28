/**
 * Working Memory Buffer
 *
 * Implements a capacity-limited buffer inspired by Baddeley's working memory model.
 * When capacity is exceeded, lowest-salience items overflow to episodic memory.
 *
 * Key features:
 * - Configurable capacity (default: 7, based on Miller's "magical number")
 * - Salience-based eviction (low salience items overflow first)
 * - Overflow callback for episodic handoff
 * - Session-scoped (clears on session end)
 */

import {
  type WorkingMemoryItem,
  type MemoryID,
  type SalienceSignals,
  createMemoryID,
  createProvenance,
  createSalience,
  createSalienceSignals,
  reinforceOnRetrieval,
} from '@reminisce/core';

/**
 * Content types that can be stored in working memory
 */
export type WorkingMemoryContentType = 'message' | 'tool_result' | 'context' | 'goal';

/**
 * Input for adding items to working memory
 */
export interface WorkingMemoryInput {
  type: WorkingMemoryContentType;
  data: unknown;
  summary?: string;
  tags?: string[];
  signals?: Partial<SalienceSignals>;
}

/**
 * Configuration for working memory buffer
 */
export interface WorkingMemoryConfig {
  /** Maximum items before overflow (default: 7) */
  capacity: number;

  /** Session identifier */
  sessionId: string;

  /** Machine/agent identifier */
  machineId: string;

  /** Callback when items overflow (for episodic handoff) */
  onOverflow?: (items: WorkingMemoryItem[]) => void | Promise<void>;

  /** Callback when buffer is cleared (session end) */
  onClear?: (items: WorkingMemoryItem[]) => void | Promise<void>;
}

const DEFAULT_CONFIG: Omit<WorkingMemoryConfig, 'sessionId' | 'machineId'> = {
  capacity: 7,
};

/**
 * Working Memory Buffer
 */
export class WorkingMemoryBuffer {
  private items: Map<string, WorkingMemoryItem> = new Map();
  private slotCounter = 0;
  private config: WorkingMemoryConfig;

  constructor(config: Partial<WorkingMemoryConfig> & Pick<WorkingMemoryConfig, 'sessionId' | 'machineId'>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Add an item to working memory
   * Returns the created item and any overflowed items
   */
  async add(input: WorkingMemoryInput): Promise<{
    item: WorkingMemoryItem;
    overflowed: WorkingMemoryItem[];
  }> {
    const memoryId = createMemoryID('working', this.config.sessionId, this.config.machineId);

    // Build salience signals
    const signals: SalienceSignals = {
      ...createSalienceSignals(),
      ...input.signals,
      last_accessed: new Date(),
    };

    const content: WorkingMemoryItem['content'] = {
      type: input.type,
      data: input.data,
    };
    if (input.summary !== undefined) {
      content.summary = input.summary;
    }

    const item: WorkingMemoryItem = {
      memory_id: memoryId as MemoryID & { layer: 'working' },
      content,
      provenance: createProvenance([], 'direct'),
      salience: createSalience(signals),
      slot: this.slotCounter++,
      overflowed: false,
    };

    if (input.tags !== undefined) {
      item.tags = input.tags;
    }

    this.items.set(memoryId.id, item);

    // Check if we need to overflow
    const overflowed = await this.enforceCapacity();

    return { item, overflowed };
  }

  /**
   * Get an item by ID (reinforces salience on access)
   */
  get(id: string): WorkingMemoryItem | undefined {
    const item = this.items.get(id);
    if (item) {
      // Reinforce on retrieval
      const reinforced: WorkingMemoryItem = {
        ...item,
        salience: reinforceOnRetrieval(item.salience),
      };
      this.items.set(id, reinforced);
      return reinforced;
    }
    return undefined;
  }

  /**
   * Get all items (does not reinforce - use for inspection)
   */
  getAll(): WorkingMemoryItem[] {
    return Array.from(this.items.values()).sort((a, b) => a.slot - b.slot);
  }

  /**
   * Get items by type
   */
  getByType(type: WorkingMemoryContentType): WorkingMemoryItem[] {
    return this.getAll().filter(item => item.content.type === type);
  }

  /**
   * Get items by tag
   */
  getByTag(tag: string): WorkingMemoryItem[] {
    return this.getAll().filter(item => item.tags?.includes(tag));
  }

  /**
   * Remove an item by ID
   */
  remove(id: string): WorkingMemoryItem | undefined {
    const item = this.items.get(id);
    if (item) {
      this.items.delete(id);
    }
    return item;
  }

  /**
   * Update an item's salience signals
   */
  updateSignals(id: string, signals: Partial<SalienceSignals>): WorkingMemoryItem | undefined {
    const item = this.items.get(id);
    if (!item) return undefined;

    const updatedSignals: SalienceSignals = {
      ...item.salience.signals,
      ...signals,
    };

    const updated: WorkingMemoryItem = {
      ...item,
      salience: createSalience(updatedSignals),
    };

    this.items.set(id, updated);
    return updated;
  }

  /**
   * Pin an item (prevents overflow)
   */
  pin(id: string): WorkingMemoryItem | undefined {
    return this.updateSignals(id, { user_pinned: true });
  }

  /**
   * Unpin an item
   */
  unpin(id: string): WorkingMemoryItem | undefined {
    return this.updateSignals(id, { user_pinned: false });
  }

  /**
   * Mark an item for blocking (will be removed, not overflowed)
   */
  block(id: string): WorkingMemoryItem | undefined {
    const item = this.items.get(id);
    if (item) {
      this.items.delete(id);
      return { ...item, salience: createSalience({ ...item.salience.signals, user_blocked: true }) };
    }
    return undefined;
  }

  /**
   * Current item count
   */
  get size(): number {
    return this.items.size;
  }

  /**
   * Current capacity
   */
  get capacity(): number {
    return this.config.capacity;
  }

  /**
   * Available slots
   */
  get available(): number {
    return Math.max(0, this.config.capacity - this.items.size);
  }

  /**
   * Clear all items (triggers onClear callback)
   */
  async clear(): Promise<WorkingMemoryItem[]> {
    const items = this.getAll();

    if (this.config.onClear && items.length > 0) {
      await this.config.onClear(items);
    }

    this.items.clear();
    this.slotCounter = 0;

    return items;
  }

  /**
   * Enforce capacity limit by overflowing lowest-salience items
   */
  private async enforceCapacity(): Promise<WorkingMemoryItem[]> {
    if (this.items.size <= this.config.capacity) {
      return [];
    }

    // Sort by salience (ascending) - lowest first
    // Pinned items (salience boosted) will be last
    const sorted = this.getAll().sort(
      (a, b) => a.salience.current_score - b.salience.current_score
    );

    // Calculate how many to overflow
    const overflowCount = this.items.size - this.config.capacity;
    const toOverflow = sorted.slice(0, overflowCount);

    // Mark as overflowed and remove
    const overflowed: WorkingMemoryItem[] = [];
    for (const item of toOverflow) {
      this.items.delete(item.memory_id.id);
      overflowed.push({ ...item, overflowed: true });
    }

    // Trigger callback
    if (this.config.onOverflow && overflowed.length > 0) {
      await this.config.onOverflow(overflowed);
    }

    return overflowed;
  }
}
