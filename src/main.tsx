import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { prefetchPlatformDataV2 } from './platform/platform-data-v2';
import { AreaErrorBoundaryV1 } from './shared/ui/area-error-boundary-v1';
import './styles.css';

prefetchPlatformDataV2();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AreaErrorBoundaryV1 label="Centro de Administração" whole>
      <App />
    </AreaErrorBoundaryV1>
  </StrictMode>,
);
