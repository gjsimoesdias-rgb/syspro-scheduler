import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import ShopFloorView from './components/ShopFloorView';
import DialogHost from './components/DialogHost';
import { DarkModeProvider } from './context/DarkModeContext';
import { ErrorBoundary } from './components/ErrorBoundary';
// Design tokens load first so component CSS that references --bg-* / --text-*
// resolves correctly and the dark-by-default APS palette wins from page load.
import './styles/theme.css';
import './index.css';

// Route /shopfloor to the mobile shop-floor view (#65); everything else renders the full planner.
const isShopFloor = window.location.pathname.startsWith('/shopfloor');

const root = ReactDOM.createRoot(document.getElementById('root') as HTMLElement);
root.render(
  <React.StrictMode>
    <ErrorBoundary>
      <DarkModeProvider>
        {isShopFloor ? <ShopFloorView /> : <App />}
        <DialogHost />
      </DarkModeProvider>
    </ErrorBoundary>
  </React.StrictMode>
);
