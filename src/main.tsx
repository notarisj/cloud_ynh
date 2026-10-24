import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { QuickSignInHelp } from './components/QuickSignIn';
import './index.css';
import './App.css';

const container = document.getElementById('root');
if (!container) throw new Error('Root element is missing from index.html');

createRoot(container).render(
  <StrictMode>
    {/* A quick sign-in code scanned with the camera rather than the app. */}
    {window.location.hash.startsWith('#quick=') ? <QuickSignInHelp /> : <App />}
  </StrictMode>,
);
