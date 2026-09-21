import { createRoot } from 'react-dom/client';
import { Market } from './market/Market';
import { Navigation } from './settings/Navigation';
import './styles.css';
const market = document.getElementById('market-root');
if (market) createRoot(market).render(<Market />);
const settings = document.getElementById('settings-navigation-root');
if (settings) createRoot(settings).render(<Navigation />);
