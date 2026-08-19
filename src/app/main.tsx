import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
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

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <App /><Toaster />
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
