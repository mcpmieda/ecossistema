import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RedesignAppV3 } from './app-v3';
import '../../features/student-portal/shared/styles.css';

const root = document.getElementById('root');
if (!root) throw new Error('Preview root missing');

createRoot(root).render(
  <StrictMode>
    <RedesignAppV3 />
  </StrictMode>,
);
