import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import FeedWindow from './components/FeedWindow'
import './styles.css'
import { initTooltips } from './lib/tooltip'

initTooltips()

// The docked activity-feed window loads this same bundle with a `#feed` hash and
// mounts only the feed surface; everything else is the full command center.
const isFeedWindow = window.location.hash === '#feed'

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>{isFeedWindow ? <FeedWindow /> : <App />}</React.StrictMode>
)
