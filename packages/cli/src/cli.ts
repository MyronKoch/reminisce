#!/usr/bin/env bun
/**
 * Reminisce CLI
 *
 * Command-line interface for initializing and managing Reminisce memory systems.
 */

import { init } from './init.js';

const HELP = `
Reminisce - Reminisce CLI

Usage:
  reminisce <command> [options]

Commands:
  init              Initialize a new Reminisce database
  version           Show version information
  help              Show this help message

Examples:
  reminisce init                           # Create reminisce.db in current directory
  reminisce init --path ./data/memory.db   # Create at custom path
  reminisce init --vector --dimensions 768  # Enable vector search

Run 'reminisce <command> --help' for more information on a command.
`;

const VERSION = '0.2.0';

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command || command === 'help' || command === '--help' || command === '-h') {
    console.log(HELP);
    process.exit(0);
  }

  if (command === 'version' || command === '--version' || command === '-v') {
    console.log(`reminisce version ${VERSION}`);
    process.exit(0);
  }

  if (command === 'init') {
    await handleInit(args.slice(1));
    process.exit(0);
  }

  console.error(`Unknown command: ${command}`);
  console.log(HELP);
  process.exit(1);
}

async function handleInit(args: string[]) {
  // Parse arguments
  let path = './reminisce.db';
  let enableVector = false;
  let dimensions = 768; // EmbeddingGemma-300m default
  let machineId = 'default';

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === '--help' || arg === '-h') {
      console.log(`
reminisce init - Initialize a new Reminisce database

Usage:
  reminisce init [options]

Options:
  --path, -p <path>       Database file path (default: ./reminisce.db)
  --vector, -v            Enable vector search (requires sqlite-vec)
  --dimensions, -d <n>    Embedding dimensions (default: 768)
  --machine-id, -m <id>   Machine identifier (default: 'default')
  --help, -h              Show this help message

Examples:
  reminisce init
  reminisce init --path ./data/memory.db
  reminisce init --vector --dimensions 768
`);
      return;
    }

    if (arg === '--path' || arg === '-p') {
      path = args[++i] ?? path;
    } else if (arg === '--vector' || arg === '-v') {
      enableVector = true;
    } else if (arg === '--dimensions' || arg === '-d') {
      const val = args[++i];
      if (val) dimensions = parseInt(val, 10);
    } else if (arg === '--machine-id' || arg === '-m') {
      machineId = args[++i] ?? machineId;
    }
  }

  console.log('Initializing Reminisce database...');
  console.log(`  Path: ${path}`);
  console.log(`  Machine ID: ${machineId}`);

  if (enableVector) {
    console.log(`  Vector search: enabled (${dimensions} dimensions)`);
  }

  try {
    const result = await init({
      path,
      enableVector,
      dimensions,
      machineId,
    });

    console.log('\nDatabase initialized successfully!');
    console.log(`  Episodic table: ${result.episodicCreated ? 'created' : 'already exists'}`);
    console.log(`  Semantic table: ${result.semanticCreated ? 'created' : 'already exists'}`);

    if (enableVector) {
      if (result.vectorEnabled) {
        console.log(`  Vector tables: created (sqlite-vec v${result.vectorVersion})`);
      } else {
        console.log('  Vector tables: skipped (sqlite-vec not available)');
        console.log('    To enable, install Homebrew SQLite: brew install sqlite');
      }
    }

    console.log('\nNext steps:');
    console.log('  1. Add @reminisce/mcp-server to your Claude Code config');
    console.log('  2. Configure the database path in your MCP settings');
    console.log('  3. Start using Reminisce tools in your conversations');
  } catch (error) {
    console.error('Failed to initialize database:', error);
    process.exit(1);
  }
}

main().catch(console.error);
