import React, { Suspense, lazy } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import '@fontsource/dela-gothic-one/400.css';
import '@fontsource/abril-fatface/400.css';
import '@fontsource/barlow-semi-condensed/500.css';
import '@fontsource/barlow-semi-condensed/700.css';
import '@fontsource/barlow-semi-condensed/800-italic.css';
import './styles.css';
import './theme.css';
import './home.css';
import './game.css';
import './inception.css';

// /?dev=inception: the nested-tournament view on demo data (no server). Loaded only on that page.
const InceptionDemo = lazy(() => import('./components/InceptionDemo').then((m) => ({ default: m.InceptionDemo })));
const dev = new URLSearchParams(location.search).get('dev');

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {dev === 'inception' ? (
      <Suspense fallback={null}>
        <InceptionDemo />
      </Suspense>
    ) : (
      <App />
    )}
  </React.StrictMode>,
);
