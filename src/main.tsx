import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './material'; // side-effect: register Material Web custom elements
import './styles.css';

const root = document.getElementById('root');
if (!root) throw new Error('no #root');
createRoot(root).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
