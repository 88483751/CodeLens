import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { AppProvider } from './state/AppState';
import { ErrorBoundary } from './components/ErrorBoundary';
import { attachGlobalErrorHandlers } from './lib/logger';
import { syncMode } from './api/browserMode';
import { SyncAccount } from './components/SyncAccount';
import './index.css';

attachGlobalErrorHandlers();
const workbench = <AppProvider><App /></AppProvider>;

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <ErrorBoundary>
      {syncMode ? <SyncAccount>{workbench}</SyncAccount> : workbench}
    </ErrorBoundary>
  </StrictMode>,
);
