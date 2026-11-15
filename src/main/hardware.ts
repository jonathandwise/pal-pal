/** Hardware detection and hardware-aware Ollama defaults. computeDefaults() is pure. */
import { execFile } from 'node:child_process';
import os from 'node:os';
import type { Hardware, HardwareProfile, ModelDefaults, ModelInfo, OllamaOverrides } from '../shared/types';

const MB = 1024 * 1024;

function run(cmd: string, args: string[], timeout = 8000): Promise<string> {
  return new Promise((resolve) => {
    try {
      execFile(cmd, args, { timeout, windowsHide: true }, (err, stdout) => resolve(err ? '' : String(stdout)));
    } catch {
      resolve('');
    }
  });
}

let cachedMachineId = '';
export async function machineId(): Promise<string> {
  if (cachedMachineId) return cachedMachineId;
  const out = await run('reg', ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid']);
  const m = out.match(/MachineGuid\s+REG_SZ\s+([\w-]+)/i);
  cachedMachineId = (m ? m[1] : os.hostname()).toLowerCase();
  return cachedMachineId;
}

export async function detectHardware(): Promise<Hardware> {
  const gpus: { name: string; vramMB: number }[] = [];
  // 1. NVIDIA: exact numbers
  const smi = await run('nvidia-smi', ['--query-gpu=name,memory.total', '--format=csv,noheader,nounits']);
  for (const line of smi.split('\n')) {
    const [name, mem] = line.split(',').map((s) => s.trim());
    if (name && Number(mem) > 0) gpus.push({ name, vramMB: Number(mem) });
  }
  // 2. Any vendor: 64-bit VRAM size from the display-class registry key (Win32_VideoController.AdapterRAM caps at 4 GB)
  if (gpus.length === 0) {
    const ps = await run('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      "Get-ItemProperty 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}\\0*' -ErrorAction SilentlyContinue | ForEach-Object { \"$($_.DriverDesc)|$($_.'HardwareInformation.qwMemorySize')\" }",
    ]);
    for (const line of ps.split('\n')) {
      const [name, bytes] = line.trim().split('|');
      if (name && Number(bytes) > 0) gpus.push({ name, vramMB: Math.round(Number(bytes) / MB) });
    }
  }
  // Only discrete-class GPUs with >= 2 GB count as usable for offload.
  const usable = gpus.filter((g) => g.vramMB >= 2000 && /nvidia|geforce|rtx|gtx|quadro|amd|radeon|arc/i.test(g.name));
  const cpus = os.cpus();
  return {
    machineId: await machineId(),
    hostname: os.hostname(),
    gpus,
    vramMB: usable.reduce((m, g) => Math.max(m, g.vramMB), 0),
    ramMB: Math.round(os.totalmem() / MB),
    cpu: cpus[0]?.model?.trim() || 'Unknown CPU',
    cores: cpus.length,
    detectedAt: Date.now(),
  };
}

const VRAM_RESERVE_MB = 700; // Windows desktop, browser etc.
const OVERHEAD_MB = 500; // compute/graph buffers
const CTX_STEPS = [32768, 16384, 8192, 4096];

/** Estimated memory (MB) for a model at a given context length. */
export function estimateMB(model: ModelInfo, numCtx: number): number {
  const size = (model.sizeBytes || 0) / MB;
  const kvPerTok = model.kvBytesPerToken || Math.max(40_000, (model.sizeBytes || 4e9) * 0.00002); // rough fallback
  return Math.round(size + (kvPerTok * numCtx) / MB + OVERHEAD_MB);
}

/**
 * Pick num_ctx and estimate GPU offload from model size (which already reflects parameter count and
 * quantization), its KV-cache cost per token, and the VRAM / RAM available.
 */
export function computeDefaults(model: ModelInfo, hw: Hardware | null, forceCtx?: number, forceGpu?: number): ModelDefaults {
  const maxCtx = Math.max(2048, Math.min(model.contextLength || 8192, 32768));
  const steps = CTX_STEPS.filter((c) => c <= maxCtx);
  if (steps.length === 0) steps.push(maxCtx);
  const vram = hw ? hw.vramMB : 0;
  const ram = hw ? hw.ramMB : 16000;
  const usable = Math.max(0, vram - VRAM_RESERVE_MB);
  const sizeMB = (model.sizeBytes || 0) / MB;
  const totalLayers = model.layers ? model.layers + 1 : undefined;
  const lowest = steps[steps.length - 1];

  let num_ctx = forceCtx || 0;
  if (!num_ctx) {
    if (vram > 0) num_ctx = steps.find((c) => estimateMB(model, c) <= usable) || lowest;
    else num_ctx = Math.min(maxCtx, ram >= 32000 ? 8192 : 4096);
  }
  const est = estimateMB(model, num_ctx);
  const fits = vram > 0 && est <= usable;
  let estGpuLayers: number | undefined;
  let warning: string | undefined;
  const gb = (mb: number) => (mb / 1024).toFixed(1) + ' GB';

  if (vram === 0) {
    estGpuLayers = 0;
    warning = est > ram * 0.8
      ? `No usable GPU detected and this model needs about ${gb(est)} - more than is comfortable for ${gb(ram)} of RAM. Expect it to be very slow or fail to load.`
      : `No usable GPU detected: this model will run on the CPU (about ${gb(est)} of RAM) and will be slow.`;
  } else if (!fits) {
    const forWeights = Math.max(0, usable - (est - sizeMB));
    const frac = sizeMB > 0 ? Math.min(1, forWeights / sizeMB) : 0;
    estGpuLayers = totalLayers ? Math.floor(totalLayers * frac) : undefined;
    const over = est - usable;
    warning =
      `Needs about ${gb(est)} at ${num_ctx} context but only ~${gb(usable)} of VRAM is free for it: ~${gb(over)} will spill into system RAM` +
      (totalLayers ? ` (roughly ${estGpuLayers} of ${totalLayers} layers on the GPU)` : '') +
      ` and it will run slowly.` +
      (est > usable + ram * 0.8 ? ' It may not load at all.' : '');
  } else {
    estGpuLayers = totalLayers;
  }
  if (forceGpu !== undefined && totalLayers !== undefined && estGpuLayers !== undefined && forceGpu > estGpuLayers && vram > 0) {
    warning = (warning ? warning + ' ' : '') + `num_gpu is overridden to ${forceGpu} layers, more than the ~${estGpuLayers} estimated to fit; loading may fail.`;
  }
  return { num_ctx, num_gpu: forceGpu, estGpuLayers, totalLayers, estVramMB: est, fitsVram: fits, warning };
}

/** Defaults with the user's global and per-model overrides applied (per-model wins). */
export function effectiveOptions(model: ModelInfo, profile: HardwareProfile): { overrides: OllamaOverrides; defaults: ModelDefaults } {
  const overrides: OllamaOverrides = { ...profile.global, ...(profile.perModel[model.id] || {}) };
  for (const k of Object.keys(overrides) as (keyof OllamaOverrides)[]) if (overrides[k] === undefined || overrides[k] === null || (overrides[k] as any) === '') delete overrides[k];
  const defaults = computeDefaults(model, profile.hardware, overrides.num_ctx, overrides.num_gpu);
  return { overrides, defaults };
}
