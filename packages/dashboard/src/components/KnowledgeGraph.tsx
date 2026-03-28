import { useState, useEffect, useRef } from 'react';
import { Network } from 'vis-network';
import { DataSet } from 'vis-data';
import { reminisceClient } from '../api/reminisce';
import type { KnowledgeGraphData } from '../api/reminisce';

export default function KnowledgeGraph() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [graphData, setGraphData] = useState<KnowledgeGraphData | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const networkRef = useRef<Network | null>(null);

  useEffect(() => {
    loadGraph();
  }, []);

  useEffect(() => {
    if (graphData && containerRef.current) {
      renderGraph();
    }

    return () => {
      if (networkRef.current) {
        networkRef.current.destroy();
        networkRef.current = null;
      }
    };
  }, [graphData]);

  const loadGraph = async () => {
    try {
      setLoading(true);
      const data = await reminisceClient.getKnowledgeGraph();
      setGraphData(data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load knowledge graph');
    } finally {
      setLoading(false);
    }
  };

  const renderGraph = () => {
    if (!graphData || !containerRef.current) return;

    // Convert graph data to vis.js format with Apple system colors
    const nodes = new DataSet(
      graphData.nodes.map((node) => ({
        id: node.id,
        label: node.label,
        color: getNodeColor(node.type),
        shape: 'dot',
        size: 20,
        font: { color: 'rgba(255, 255, 255, 0.9)' },
      }))
    );

    const edges = new DataSet(
      graphData.edges.map((edge, idx) => ({
        id: idx,
        from: edge.from,
        to: edge.to,
        label: edge.label,
        arrows: 'to',
        color: 'rgba(255, 255, 255, 0.3)',
        font: { color: 'rgba(255, 255, 255, 0.5)' },
      }))
    );

    const options = {
      nodes: {
        font: { size: 14 },
      },
      edges: {
        font: { size: 12, align: 'middle' as const },
        smooth: {
          enabled: true,
          type: 'continuous' as const,
          roundness: 0.5,
        },
      },
      physics: {
        stabilization: true,
        barnesHut: {
          gravitationalConstant: -2000,
          springLength: 150,
        },
      },
      interaction: {
        hover: true,
        navigationButtons: true,
        keyboard: true,
      },
    };

    networkRef.current = new Network(containerRef.current, { nodes, edges }, options);
  };

  const getNodeColor = (type: string) => {
    switch (type) {
      case 'entity':
      case 'subject':
        return '#0A84FF'; // Apple Blue
      case 'fact':
        return '#30D158'; // Apple Green
      case 'episode':
      case 'object':
        return '#BF5AF2'; // Apple Purple
      default:
        return '#64D2FF'; // Apple Cyan
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-96">
        <div className="text-white/50">Loading knowledge graph...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="glass-card p-6 border-[#FF453A]/30">
        <h3 className="text-[#FF453A] font-semibold">Error</h3>
        <p className="text-[#FF453A]/80 mt-1">{error}</p>
        <button
          onClick={loadGraph}
          className="mt-4 px-4 py-2 bg-[#FF453A] text-white rounded-lg hover:bg-[#FF453A]/80 transition-colors"
        >
          Retry
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <h2 className="text-2xl font-semibold text-white tracking-tight">Knowledge Graph</h2>
        <button
          onClick={loadGraph}
          className="px-4 py-2 bg-[#0A84FF] text-white rounded-lg font-medium hover:bg-[#3395FF] transition-all hover:shadow-[0_4px_12px_rgba(10,132,255,0.4)]"
        >
          Refresh
        </button>
      </div>

      <div className="glass-card p-5 border-[#0A84FF]/30">
        <p className="text-sm text-white/70">
          <strong className="text-[#0A84FF]">Knowledge Graph</strong> visualizes the connections between entities, facts, and episodes.
          Use mouse to pan and zoom. Click nodes for details.
        </p>
      </div>

      <div className="glass-card p-4">
        <div className="flex space-x-6 mb-4 text-sm text-white/70">
          <div className="flex items-center space-x-2">
            <div className="w-4 h-4 bg-[#0A84FF] rounded-full shadow-[0_0_8px_rgba(10,132,255,0.5)]" />
            <span>Subject</span>
          </div>
          <div className="flex items-center space-x-2">
            <div className="w-4 h-4 bg-[#BF5AF2] rounded-full shadow-[0_0_8px_rgba(191,90,242,0.5)]" />
            <span>Object</span>
          </div>
          <div className="flex items-center space-x-2">
            <div className="w-4 h-4 bg-[#30D158] rounded-full shadow-[0_0_8px_rgba(48,209,88,0.5)]" />
            <span>Fact</span>
          </div>
        </div>

        <div
          ref={containerRef}
          className="w-full border border-white/10 rounded-lg bg-black"
          style={{ height: '600px' }}
        />

        {graphData && (
          <div className="mt-4 text-sm text-white/50">
            {graphData.nodes.length} nodes, {graphData.edges.length} edges
          </div>
        )}
      </div>
    </div>
  );
}
