import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.jsx';
import { captureUrlCredentials } from './ui/EntryScreen.jsx';
import './index.css';

/**
 * Phase 6 — take `?invite=` and `?reset=` out of the address bar before React
 * renders anything.
 *
 * Before, and not inside an effect, for two reasons. Both values are
 * credentials, so the window in which they sit in a visible URL should be as
 * short as possible — an invite code in a screenshot is a door into the Space,
 * and a reset token in a screen-shared address bar is a password. And
 * `StrictMode` double-invokes effects on mount, so a capture written as one
 * would run twice against a URL the first pass had already rewritten.
 */
captureUrlCredentials();

const container = document.getElementById('root');
if (!container) throw new Error('#root is missing from index.html');

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
