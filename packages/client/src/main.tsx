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
import './housebots.css';
import './inception.css';

// /?dev=inception: the nested-tournament view on demo data (no server), in dev builds only (`npm run dev`); the
// production bundle leaves the page out, so visitors never run its mock bot game.
const InceptionDemo = import.meta.env.DEV ? lazy(() => import('./components/InceptionDemo').then((m) => ({ default: m.InceptionDemo }))) : null;
const dev = import.meta.env.DEV ? new URLSearchParams(location.search).get('dev') : null;

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {InceptionDemo && dev === 'inception' ? (
      <Suspense fallback={null}>
        <InceptionDemo />
      </Suspense>
    ) : (
      <App />
    )}
  </React.StrictMode>,
);
