/**
 * Tests for MemoryID creation and serialization
 */

import { describe, test, expect } from 'bun:test';
import {
  createMemoryID,
  parseMemoryID,
  serializeMemoryID,
  isValidMemoryID,
  type MemoryLayer,
} from './memory-id.js';

describe('createMemoryID', () => {
  test('creates valid MemoryID with correct layer', () => {
    const layer: MemoryLayer = 'episodic';
    const session = 'test-session-123';
    const machine = 'test-machine';

    const memoryId = createMemoryID(layer, session, machine);

    expect(memoryId.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(memoryId.layer).toBe('episodic');
    expect(memoryId.source_session).toBe(session);
    expect(memoryId.source_machine).toBe(machine);
    expect(memoryId.created_at).toBeInstanceOf(Date);
  });

  test('creates unique IDs for multiple calls', () => {
    const id1 = createMemoryID('working', 'session-1', 'machine-1');
    const id2 = createMemoryID('working', 'session-1', 'machine-1');

    expect(id1.id).not.toBe(id2.id);
  });

  test('creates valid UUID v7 format', () => {
    const memoryId = createMemoryID('semantic', 'session', 'machine');

    // UUID v7 format: version bit should be 7
    expect(memoryId.id.charAt(14)).toBe('7');

    // Variant bits should be 8, 9, a, or b
    expect(['8', '9', 'a', 'b']).toContain(memoryId.id.charAt(19));
  });

  test('handles all memory layers', () => {
    const layers: MemoryLayer[] = ['working', 'episodic', 'semantic', 'procedural'];

    for (const layer of layers) {
      const memoryId = createMemoryID(layer, 'session', 'machine');
      expect(memoryId.layer).toBe(layer);
    }
  });
});

describe('serializeMemoryID', () => {
  test('serializes to JSON string', () => {
    const memoryId = createMemoryID('working', 'test-session', 'test-machine');
    const serialized = serializeMemoryID(memoryId);

    expect(typeof serialized).toBe('string');
    expect(() => JSON.parse(serialized)).not.toThrow();
  });

  test('preserves all fields in serialization', () => {
    const memoryId = createMemoryID('episodic', 'session-abc', 'machine-xyz');
    const serialized = serializeMemoryID(memoryId);
    const parsed = JSON.parse(serialized);

    expect(parsed.id).toBe(memoryId.id);
    expect(parsed.layer).toBe('episodic');
    expect(parsed.source_session).toBe('session-abc');
    expect(parsed.source_machine).toBe('machine-xyz');
    expect(parsed.created_at).toBe(memoryId.created_at.toISOString());
  });
});

describe('parseMemoryID', () => {
  test('round-trip serialize/parse preserves data', () => {
    const original = createMemoryID('semantic', 'session-123', 'machine-456');
    const serialized = serializeMemoryID(original);
    const parsed = parseMemoryID(serialized);

    expect(parsed).not.toBeNull();
    expect(parsed!.id).toBe(original.id);
    expect(parsed!.layer).toBe(original.layer);
    expect(parsed!.source_session).toBe(original.source_session);
    expect(parsed!.source_machine).toBe(original.source_machine);
    expect(parsed!.created_at.getTime()).toBe(original.created_at.getTime());
  });

  test('returns null for invalid JSON', () => {
    expect(parseMemoryID('not valid json')).toBeNull();
    expect(parseMemoryID('{invalid json}')).toBeNull();
    expect(parseMemoryID('')).toBeNull();
  });

  test('returns null for JSON missing required fields', () => {
    expect(parseMemoryID('{}')).toBeNull();
    expect(parseMemoryID('{"id": "123"}')).toBeNull();
    expect(parseMemoryID('{"id": "123", "layer": "episodic"}')).toBeNull();
  });

  test('converts created_at string to Date', () => {
    const original = createMemoryID('working', 'session', 'machine');
    const serialized = serializeMemoryID(original);
    const parsed = parseMemoryID(serialized);

    expect(parsed).not.toBeNull();
    expect(parsed!.created_at).toBeInstanceOf(Date);
  });
});

describe('isValidMemoryID', () => {
  test('returns true for valid MemoryID objects', () => {
    const validId = createMemoryID('episodic', 'session', 'machine');
    expect(isValidMemoryID(validId)).toBe(true);
  });

  test('returns false for null', () => {
    expect(isValidMemoryID(null)).toBe(false);
  });

  test('returns false for non-object types', () => {
    expect(isValidMemoryID(undefined)).toBe(false);
    expect(isValidMemoryID(123)).toBe(false);
    expect(isValidMemoryID('string')).toBe(false);
    expect(isValidMemoryID([])).toBe(false);
  });

  test('returns false for objects missing required fields', () => {
    expect(isValidMemoryID({})).toBe(false);
    expect(isValidMemoryID({ id: '123' })).toBe(false);
    expect(isValidMemoryID({ id: '123', layer: 'episodic' })).toBe(false);
  });

  test('returns false for invalid layer value', () => {
    const invalid = {
      id: 'test-id',
      layer: 'invalid-layer',
      created_at: new Date(),
      source_session: 'session',
      source_machine: 'machine',
    };
    expect(isValidMemoryID(invalid)).toBe(false);
  });

  test('returns true when created_at is Date object', () => {
    const valid = {
      id: 'test-id',
      layer: 'working',
      created_at: new Date(),
      source_session: 'session',
      source_machine: 'machine',
    };
    expect(isValidMemoryID(valid)).toBe(true);
  });

  test('returns true when created_at is ISO string', () => {
    const valid = {
      id: 'test-id',
      layer: 'semantic',
      created_at: new Date().toISOString(),
      source_session: 'session',
      source_machine: 'machine',
    };
    expect(isValidMemoryID(valid)).toBe(true);
  });
});
