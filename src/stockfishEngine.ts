// Wrapper around the Stockfish engine running inside a Web Worker.
// The worker (public/uci-worker.js) loads the single-threaded stockfish.js
// which auto-wires onmessage/postMessage in worker context.

export interface EngineLine {
  readonly depth: number;
  readonly scoreCp: number | null;
  readonly mate: number | null;
  readonly pv: readonly string[];
  readonly uciMoves: readonly string[];
}

export interface EngineInfo {
  readonly lines: readonly EngineLine[];
  readonly depth: number;
}

export type EngineProgress = (info: EngineInfo) => void;

export class StockfishEngine {
  private worker: Worker | null = null;
  private ready = false;
  private readyPromise: Promise<void> | null = null;

  async init(): Promise<void> {
    if (this.ready && this.worker) return;
    if (this.readyPromise) return this.readyPromise;

    this.worker = new Worker("/uci-worker.js");
    this.readyPromise = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (!this.ready) {
          this.worker?.removeEventListener("message", check);
          reject(new Error("Engine failed to load (timeout)."));
        }
      }, 15000);

      const check = (ev: MessageEvent) => {
        const d = typeof ev.data === "string" ? ev.data : "";
        if (d === "uciok") {
          this.worker?.removeEventListener("message", check);
          this.ready = true;
          clearTimeout(timeout);
          resolve();
        }
      };
      this.worker!.addEventListener("message", check);
      this.worker!.postMessage("uci");
    });
    await this.readyPromise;
  }

  analyzeMultiPV(
    fen: string,
    depth: number,
    multiPV: number,
    onProgress?: EngineProgress
  ): Promise<EngineLine[]> {
    if (!this.worker || !this.ready) {
      return Promise.reject(new Error("Engine not initialized"));
    }
    const allLines: Map<number, EngineLine> = new Map();

    return new Promise<EngineLine[]>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.worker?.removeEventListener("message", handler);
        reject(new Error("Analysis timed out"));
      }, 120000);

      const handler = (ev: MessageEvent) => {
        const d = typeof ev.data === "string" ? ev.data : "";
        if (d.startsWith("info") && d.includes("multipv") && d.includes("pv")) {
          const depthMatch = d.match(/depth\s+(\d+)/);
          const mpvMatch = d.match(/multipv\s+(\d+)/);
          const scoreMatch = d.match(/score\s+cp\s+(-?\d+)/);
          const mateMatch = d.match(/score\s+mate\s+(-?\d+)/);
          const pvIdx = d.indexOf(" pv ");
          if (!depthMatch || !mpvMatch || pvIdx === -1) return;
          const pvUci = d.slice(pvIdx + 4).trim().split(/\s+/);
          const line: EngineLine = {
            depth: parseInt(depthMatch[1], 10),
            scoreCp: scoreMatch ? parseInt(scoreMatch[1], 10) : null,
            mate: mateMatch ? parseInt(mateMatch[1], 10) : null,
            pv: [],
            uciMoves: pvUci,
          };
          allLines.set(parseInt(mpvMatch[1], 10), line);
          if (onProgress) {
            onProgress({
              lines: Array.from(allLines.values()),
              depth: line.depth,
            });
          }
        }
        if (d.startsWith("bestmove")) {
          clearTimeout(timeout);
          this.worker?.removeEventListener("message", handler);
          const result: EngineLine[] = [];
          for (let i = 1; i <= multiPV; i++) {
            const l = allLines.get(i);
            if (l) result.push(l);
          }
          resolve(result);
        }
      };
      this.worker!.addEventListener("message", handler);
      this.worker!.postMessage("ucinewgame");
      this.worker!.postMessage(`setoption name MultiPV value ${multiPV}`);
      this.worker!.postMessage("isready");
      this.worker!.postMessage(`position fen ${fen}`);
      this.worker!.postMessage(`go depth ${depth}`);
    });
  }

  stop(): void {
    if (this.worker) this.worker.postMessage("stop");
  }

  terminate(): void {
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
    this.ready = false;
  }
}

import { Chess } from "chess.js";

export function uciToSan(fen: string, uciMoves: readonly string[]): string[] {
  const game = new Chess(fen);
  const san: string[] = [];
  for (const uci of uciMoves) {
    try {
      const from = uci.slice(0, 2);
      const to = uci.slice(2, 4);
      const promotion = uci.length > 4 ? uci[4] : undefined;
      const move = game.move({ from, to, promotion });
      if (move) san.push(move.san);
    } catch {
      break;
    }
  }
  return san;
}
