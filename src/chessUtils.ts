import { Chess, type Move } from "chess.js";

export const START_FEN = "r1bqkb1r/pppp1ppp/2n2n2/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4";

export type StepId = 1 | 2 | 3 | 4 | 5;

export interface CandidateLine {
  myMove: string;
  theirReply: string;
  myFollowUp: string;
}

export interface StepTimes {
  1: number;
  2: number;
  3: number;
  4: number;
  5: number;
}

export interface ReviewData {
  playedMoveSan: string;
  playedMoveUci: string;
  accuracy: number; // 0-100
  cpLoss: number; // centipawns lost vs best
  bestMoveSan: string;
  topThree: { san: string; scoreCp: number | null; mate: number | null }[];
  candidateIncludedBest: boolean;
  preEvalCp: number | null; // eval before the move (side to move POV)
  postEvalCp: number | null; // eval after the move (opponent POV, negated)
}

// Validate a SAN move string against a FEN. Returns true if legal.
export function isValidSan(fen: string, san: string): boolean {
  if (!san || !san.trim()) return false;
  try {
    const game = new Chess(fen);
    return game.move(san.trim()) !== null;
  } catch {
    return false;
  }
}

// Validate a UCI move string against a FEN. Returns true if legal.
export function isValidUci(fen: string, uci: string): boolean {
  if (!uci || uci.length < 4) return false;
  try {
    const game = new Chess(fen);
    const from = uci.slice(0, 2);
    const to = uci.slice(2, 4);
    const promotion = uci.length > 4 ? uci[4] : undefined;
    return game.move({ from, to, promotion }) !== null;
  } catch {
    return false;
  }
}

// Convert SAN to UCI for a given FEN.
export function sanToUci(fen: string, san: string): string | null {
  try {
    const game = new Chess(fen);
    const move = game.move(san.trim());
    return move ? `${move.from}${move.to}${move.promotion || ""}` : null;
  } catch {
    return null;
  }
}

// Convert UCI to SAN for a given FEN.
export function uciToSanSingle(fen: string, uci: string): string | null {
  try {
    const game = new Chess(fen);
    const from = uci.slice(0, 2);
    const to = uci.slice(2, 4);
    const promotion = uci.length > 4 ? uci[4] : undefined;
    const move = game.move({ from, to, promotion });
    return move ? move.san : null;
  } catch {
    return null;
  }
}

// Get the FEN after a SAN move.
export function fenAfterSan(fen: string, san: string): string | null {
  try {
    const game = new Chess(fen);
    const move = game.move(san.trim());
    return move ? game.fen() : null;
  } catch {
    return null;
  }
}

// List all legal moves in SAN for a FEN (for autocomplete / validation).
export function legalSans(fen: string): string[] {
  try {
    const game = new Chess(fen);
    return game.moves({ verbose: true }).map((m: Move) => m.san);
  } catch {
    return [];
  }
}

// Format seconds as MM:SS.
export function formatTime(totalSeconds: number): string {
  const m = Math.floor(totalSeconds / 60);
  const s = Math.floor(totalSeconds % 60);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

// Compute a simple accuracy score (0-100) from centipawn loss.
// 0 cp loss = 100, 100+ cp loss approaches 0. Uses a smooth decay.
export function accuracyFromCpLoss(cpLoss: number): number {
  if (cpLoss <= 0) return 100;
  // Exponential decay: accuracy = 100 * exp(-cpLoss / 100)
  const acc = 100 * Math.exp(-cpLoss / 100);
  return Math.max(0, Math.round(acc));
}
