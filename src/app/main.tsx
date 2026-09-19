import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { PersistQueryClientProvider } from '@tanstack/react-query-persist-client';
import { isPersistenceEnabled, persistOptions } from './api/persister';
import { App } from './app';
import { Toaster } from './components/ui/sonner';
import './globals.css';

const root = document.getElementById('root');
if (!root) throw new Error('Root element is missing');

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnReconnect: false,
      refetchOnWindowFocus: false,
      retry: false,
    },
  },
});

const app = (
  <BrowserRouter>
    <App /><Toaster />
  </BrowserRouter>
);

createRoot(root).render(
  <StrictMode>
    {isPersistenceEnabled ? (
      <PersistQueryClientProvider client={queryClient} persistOptions={persistOptions}>{app}</PersistQueryClientProvider>
    ) : (
      <QueryClientProvider client={queryClient}>{app}</QueryClientProvider>
    )}
  </StrictMode>,
);
