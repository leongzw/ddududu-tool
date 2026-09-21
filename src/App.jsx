import { useState } from 'react';
import Sidebar from './components/Sidebar';
import FundingCompare from './modules/funding-compare/FundingCompare';
import RhVolume from './modules/rh-volume/RhVolume';
import NftMint from './modules/nft-mint/NftMint';
import OpenseaMint from './modules/opensea-mint/OpenseaMint';
import Wallets from './modules/wallets/Wallets';
import WhitelistCurator from './modules/whitelist/WhitelistCurator';
import TokenMonitor from './modules/token-monitor/TokenMonitor';
import BundleRadar from './modules/bundle-radar/BundleRadar';
import './App.css';

const MODULES = [
  { id: 'funding-compare', label: 'Funding Rate Compare', icon: '📊' },
  { id: 'rh-volume', label: 'Chain Volume Monitor', icon: '📈' },
  { id: 'token-monitor', label: 'Token Monitor', icon: '📡' },
  { id: 'bundle-radar', label: 'Bundle Radar 莊家', icon: '🎯' },
  { id: 'nft-mint', label: 'NFT Mint Monitor', icon: '🎨' },
  {
    id: 'nft-mint-group',
    label: 'NFT Mint',
    icon: '🖼️',
    children: [{ id: 'opensea', label: 'Opensea', icon: '⛵' }],
  },
  { id: 'wallets', label: 'Wallets', icon: '👛' },
  { id: 'whitelist', label: 'Whitelist Curator', icon: '🎟️' },
];

function App() {
  const [activeModule, setActiveModule] = useState('funding-compare');
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

  const renderModule = () => {
    switch (activeModule) {
      case 'funding-compare':
        return <FundingCompare />;
      case 'rh-volume':
        return <RhVolume />;
      case 'nft-mint':
        return <NftMint />;
      case 'opensea':
        return <OpenseaMint />;
      case 'wallets':
        return <Wallets />;
      case 'whitelist':
        return <WhitelistCurator />;
      case 'token-monitor':
        return <TokenMonitor />;
      case 'bundle-radar':
        return <BundleRadar />;
      default:
        return <FundingCompare />;
    }
  };

  const activeLabel =
    MODULES.flatMap((m) =>
      m.children ? m.children.map((c) => ({ id: c.id, label: `${m.label} · ${c.label}` })) : [m],
    ).find((m) => m.id === activeModule)?.label || '';

  return (
    <div className="app-layout">
      <Sidebar
        modules={MODULES}
        activeModule={activeModule}
        onModuleChange={setActiveModule}
        collapsed={sidebarCollapsed}
        onToggleCollapse={() => setSidebarCollapsed(!sidebarCollapsed)}
      />
      <main className={`app-main ${sidebarCollapsed ? 'sidebar-collapsed' : ''}`}>
        <header className="app-header">
          <h1 className="app-title">{activeLabel}</h1>
        </header>
        <div className="app-content">
          {renderModule()}
        </div>
      </main>
    </div>
  );
}

export default App;
