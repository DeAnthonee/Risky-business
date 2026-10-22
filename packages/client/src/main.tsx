import React from 'react';
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

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
