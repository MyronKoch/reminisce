import { BrowserRouter as Router, Routes, Route } from 'react-router-dom';
import Layout from './components/Layout';
import WorkingMemoryView from './components/WorkingMemoryView';
import EpisodicTimeline from './components/EpisodicTimeline';
import SemanticBrowser from './components/SemanticBrowser';
import KnowledgeGraph from './components/KnowledgeGraph';
import StatsOverview from './components/StatsOverview';

function App() {
  return (
    <Router basename={import.meta.env.BASE_URL}>
      <Layout>
        <Routes>
          <Route path="/" element={<StatsOverview />} />
          <Route path="/working-memory" element={<WorkingMemoryView />} />
          <Route path="/episodic" element={<EpisodicTimeline />} />
          <Route path="/semantic" element={<SemanticBrowser />} />
          <Route path="/graph" element={<KnowledgeGraph />} />
        </Routes>
      </Layout>
    </Router>
  );
}

export default App;
