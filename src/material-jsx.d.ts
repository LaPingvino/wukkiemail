// Minimal JSX type declarations for the Material Web custom elements we use.
// Lit components don't ship React JSX types, so React would complain about
// unknown intrinsic elements. We declare them loosely — full prop typing
// can come later if needed.

import type React from 'react';

type AnyProps = React.HTMLAttributes<HTMLElement> & Record<string, unknown>;

declare global {
  namespace JSX {
    interface IntrinsicElements {
      'md-filled-button': AnyProps;
      'md-outlined-button': AnyProps;
      'md-text-button': AnyProps;
      'md-outlined-text-field': AnyProps;
      'md-list': AnyProps;
      'md-list-item': AnyProps;
      'md-icon': AnyProps;
      'md-icon-button': AnyProps;
      'md-divider': AnyProps;
      'md-circular-progress': AnyProps;
      'md-navigation-rail': AnyProps;
      'md-navigation-tab': AnyProps;
    }
  }
}
