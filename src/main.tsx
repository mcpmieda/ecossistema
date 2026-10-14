import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { prefetchPlatformDataV2 } from './platform/platform-data-v2';
import './styles.css';

prefetchPlatformDataV2();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
