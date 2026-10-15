/**
 * Agent-written HTML (live demo, artifacts) runs in an opaque origin: scripts work, but the page
 * cannot read Emberline's origin or call its API with the session. Never add `allow-same-origin`.
 */
export const DEMO_IFRAME_SANDBOX =
  'allow-scripts allow-forms allow-modals allow-popups allow-downloads allow-pointer-lock';
