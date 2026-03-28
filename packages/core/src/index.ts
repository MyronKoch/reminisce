/**
 * @reminisce/core - Core types, schemas, and utilities for Reminisce
 *
 * This package provides the foundational types and utilities used across
 * all Reminisce memory layers.
 *
 * @packageDocumentation
 */

// Re-export all types
export * from './types/index.js';

// Re-export salience utilities
export * as salience from './salience/index.js';

// Re-export evaluation harness
export * as eval from './eval/index.js';

// Version info
export const VERSION = '0.2.0';
