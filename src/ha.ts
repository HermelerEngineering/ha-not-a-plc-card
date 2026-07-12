/**
 * Minimal Home Assistant frontend types.
 *
 * We declare only the slice of the `hass` object and websocket connection the
 * card actually uses, rather than depending on the full `custom-card-helpers`
 * package. This keeps the build light and the surface explicit.
 */

export interface HaMessage {
  type: string;
  [key: string]: unknown;
}

export interface HaConnection {
  sendMessagePromise<T>(message: HaMessage): Promise<T>;
  subscribeMessage<T>(
    callback: (message: T) => void,
    subscribeMessage: HaMessage,
  ): Promise<() => void>;
}

export interface HomeAssistant {
  connection: HaConnection;
  themes?: unknown;
  language?: string;
}

export interface LovelaceCardConfig {
  type: string;
  title?: string;
  [key: string]: unknown;
}

/** The optional card registry the HA UI reads to list custom cards. */
export interface CustomCardEntry {
  type: string;
  name: string;
  description?: string;
  preview?: boolean;
}

declare global {
  interface Window {
    customCards?: CustomCardEntry[];
  }
}
