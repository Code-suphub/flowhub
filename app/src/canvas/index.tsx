import { createRoot } from 'react-dom/client';
import { Canvas } from './Canvas';
import './canvas.css';

/** Host main mounts this island into #canvas-root. Return the root for teardown. */
export function mountCanvas(root: HTMLElement) {
  const reactRoot = createRoot(root);
  reactRoot.render(<Canvas />);
  return reactRoot;
}
