# @reminisce/dashboard

Web dashboard for the Reminisce (Reminisce).

## Features

- **Working Memory View**: Monitor the current 7 ± 2 items in working memory
- **Episodic Timeline**: Browse stored episodes with temporal context
- **Semantic Browser**: Explore facts organized by subject with contradiction detection
- **Knowledge Graph**: Visualize connections between entities, facts, and episodes
- **Stats Overview**: System statistics and manual consolidation trigger

## Tech Stack

- **React 18** - UI framework
- **Vite** - Build tool and dev server
- **TypeScript** - Type safety
- **Tailwind CSS** - Styling
- **React Router** - Navigation
- **vis.js** - Knowledge graph visualization

## Getting Started

### Prerequisites

- Bun (the monorepo uses Bun as the package manager)
- Reminisce backend running (either standalone or via MCP server)

### Installation

From the monorepo root:

```bash
bun install
```

### Development

```bash
# From the monorepo root
bun run dev --filter=@reminisce/dashboard

# Or from this package directory
cd packages/dashboard
bun run dev
```

The dashboard will open at http://localhost:3000

### Configuration

Create a `.env` file in this directory:

```env
# Reminisce API endpoint
VITE_REMINISCE_API_URL=http://localhost:3001
```

## API Integration

The dashboard connects to Reminisce via the API client in `src/api/reminisce.ts`.

### Connection Options

1. **Direct HTTP API**: If Reminisce exposes REST endpoints (configure `VITE_REMINISCE_API_URL`)
2. **MCP Server Proxy**: If using the MCP server, you may need to add a proxy endpoint
3. **Local Development**: Mock data can be added for development without a backend

### Expected API Endpoints

The dashboard expects these endpoints:

- `GET /api/memory/working` - Get working memory items
- `GET /api/memory/episodic` - Get episodic memories
- `GET /api/memory/semantic` - Get semantic facts
- `GET /api/graph` - Get knowledge graph data
- `GET /api/stats` - Get system statistics
- `POST /api/consolidate` - Trigger consolidation
- `GET /api/search?q=query` - Search across all layers

Refer to `src/api/reminisce.ts` for the complete API interface.

## Building for Production

```bash
bun run build
```

The built files will be in `dist/`.

## Project Structure

```
packages/dashboard/
├── src/
│   ├── api/
│   │   └── reminisce.ts              # API client
│   ├── components/
│   │   ├── Layout.tsx           # Main layout with navigation
│   │   ├── WorkingMemoryView.tsx
│   │   ├── EpisodicTimeline.tsx
│   │   ├── SemanticBrowser.tsx
│   │   ├── KnowledgeGraph.tsx
│   │   └── StatsOverview.tsx
│   ├── App.tsx                  # Root component with routing
│   ├── main.tsx                 # Entry point
│   └── index.css                # Global styles with Tailwind
├── index.html
├── package.json
├── vite.config.ts
├── tailwind.config.js
└── tsconfig.json
```

## Customization

### Colors

Modify the theme in `tailwind.config.js`:

```js
theme: {
  extend: {
    colors: {
      'reminisce-blue': '#3b82f6',
      'reminisce-purple': '#8b5cf6',
      'reminisce-green': '#10b981',
    },
  },
}
```

### Graph Visualization

The knowledge graph uses vis.js. Customize in `src/components/KnowledgeGraph.tsx`:

- Node colors by type
- Physics simulation parameters
- Interaction settings

## Development Notes

This is a working scaffold with full component stubs. To complete:

1. Implement or configure the Reminisce backend API endpoints
2. Add real-time updates (WebSocket or polling)
3. Add search functionality
4. Add authentication if needed
5. Improve error handling and loading states
6. Add unit tests

## License

MIT
