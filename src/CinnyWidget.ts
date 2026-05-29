// Thin wrapper over matrix-widget-api's Widget so we can pass our IApp
// definition (which carries the MatrixClient + roomId). Ported from cinny-wally.
import { Widget } from 'matrix-widget-api';
import type { IApp } from './SmallWidget';

export class CinnyWidget extends Widget {
  public constructor(rawDefinition: IApp) {
    super(rawDefinition);
  }
}
