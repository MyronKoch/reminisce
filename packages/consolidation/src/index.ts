/**
 * @reminisce/consolidation - Memory Consolidation Package
 *
 * Implements the "slow learning" consolidation from episodic to semantic memory.
 * Extracts facts from episodes and stores them with provenance tracking.
 *
 * @packageDocumentation
 */

export {
  ConsolidationEngine,
  type ConsolidationConfig,
  type ConsolidationResult,
  type FactExtractor,
  type ExtractedFact,
  type ExtractionResult,
  SimpleFactExtractor,
} from './engine.js';

export {
  LLMFactExtractor,
  type LLMExtractorConfig,
  type LLMProvider,
  type LLMOptions,
  OpenAIProvider,
  AnthropicProvider,
  createOpenAIExtractor,
  createAnthropicExtractor,
} from './llm-extractor.js';
