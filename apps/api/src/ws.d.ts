declare module 'ws' {
  export default class WebSocket {
    static readonly OPEN: number;
    readyState: number;
    constructor(url: string, options?: { headers?: Record<string, string> });
    on(event: 'open' | 'close' | 'error', listener: (...args: unknown[]) => void): this;
    on(event: 'message', listener: (data: { toString(): string }) => void): this;
    send(data: string): void;
    close(): void;
  }
}
