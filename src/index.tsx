import { render } from 'preact';
import { ChatPanel } from './components/ChatPanel';
import './style.css';

render(<ChatPanel />, document.getElementById('app')!);
