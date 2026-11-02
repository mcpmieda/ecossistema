import './preview-clock-v1';
import './preview-mouse-swipe-v1';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { PortalDemoAppV1 } from './portal-demo-app-v1';

const root = document.getElementById('root');
if (!root) throw new Error('Preview root missing');

createRoot(root).render(
  <StrictMode>
    <PortalDemoAppV1 />
  </StrictMode>,
);
