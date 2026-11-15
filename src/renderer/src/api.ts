import type { AgentEvent } from '../../shared/types';

const bridge = (window as any).api as { invoke: (ch: string, ...a: any[]) => Promise<any>; onEvent: (cb: (e: any) => void) => () => void };

export function api<T = any>(channel: string, ...args: any[]): Promise<T> {
  return bridge.invoke(channel, ...args).catch((e: any) => {
    // Electron prefixes remote errors; keep only the message.
    throw new Error(String(e?.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''));
  });
}
export const onEvent = (cb: (e: AgentEvent) => void): (() => void) => bridge.onEvent(cb);

export const fmtTokens = (n: number): string => (n >= 10000 ? (n / 1000).toFixed(0) + 'k' : n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(Math.round(n)));
export const modelKey = (provider: string, id: string) => `${provider}::${id}`;
