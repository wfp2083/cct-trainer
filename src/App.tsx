import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Chess } from "chess.js";
import { Chessground } from "@lichess-org/chessground";
import type { Api as ChessgroundApi } from "@lichess-org/chessground/api";
import type { Key as CgKey } from "@lichess-org/chessground/types";
import "@lichess-org/chessground/assets/chessground.base.css";
import "@lichess-org/chessground/assets/chessground.brown.css";
import "@lichess-org/chessground/assets/chessground.cburnett.css";
import {
  Clock,
  Lock,
  Unlock,
  CheckCircle2,
  Circle,
  ChevronRight,
  RotateCcw,
  Loader2,
  Brain,
  Target,
  Swords,
  Shield,
  ListChecks,
  Play,
  Trophy,
  AlertTriangle,
  Sparkles,
} from "lucide-react";
import {
  START_FEN,
  isValidSan,
  sanToUci,
  uciToSanSingle,
  fenAfterSan,
  legalSans,
  formatTime,
  accuracyFromCpLoss,
  type CandidateLine,
  type ReviewData,
} from "@/chessUtils";
import { StockfishEngine, uciToSan, type EngineLine } from "@/stockfishEngine";

type StepId = 1 | 2 | 3 | 4 | 5;
type Phase = "training" | "evaluating" | "review";

const STEP_LABELS: Record<StepId, string> = {
  1: "Your CCT",
  2: "Their CCT",
  3: "3 Candidates",
  4: "Calculate 3 Plies",
  5: "Play Move",
};

const STEP_ICONS: Record<StepId, typeof Clock> = {
  1: Swords,
  2: Shield,
  3: ListChecks,
  4: Brain,
  5: Play,
};

function fenToDests(fen: string): Map<CgKey, CgKey[]> {
  const game = new Chess(fen);
  const dests = new Map<CgKey, CgKey[]>();
  const moves = game.moves({ verbose: true });
  for (const m of moves) {
    const arr = dests.get(m.from as CgKey) || [];
    arr.push(m.to as CgKey);
    dests.set(m.from as CgKey, arr);
  }
  return dests;
}

function fenToTurn(fen: string): "white" | "black" {
  return fen.split(" ")[1] === "w" ? "white" : "black";
}

export default function App() {
  const [fen, setFen] = useState(START_FEN);
  const [phase, setPhase] = useState<Phase>("training");
  const [currentStep, setCurrentStep] = useState<StepId>(1);
  const [strictMode, setStrictMode] = useState(true);
  const [elapsed, setElapsed] = useState(0);

  // Step inputs
  const [myCct, setMyCct] = useState("");
  const [theirCct, setTheirCct] = useState("");
  const [candidates, setCandidates] = useState<string[]>(["", "", ""]);
  const [candidateLines, setCandidateLines] = useState<CandidateLine[]>([
    { myMove: "", theirReply: "", myFollowUp: "" },
    { myMove: "", theirReply: "", myFollowUp: "" },
    { myMove: "", theirReply: "", myFollowUp: "" },
  ]);
  const [playedMove, setPlayedMove] = useState("");

  // Step times (seconds spent on each step)
  const [stepTimes, setStepTimes] = useState<Record<StepId, number>>({
    1: 0,
    2: 0,
    3: 0,
    4: 0,
    5: 0,
  });
  const stepStartRef = useRef<number>(Date.now());

  // Engine
  const engineRef = useRef<StockfishEngine | null>(null);
  const [engineLoading, setEngineLoading] = useState(false);
  const [engineProgress, setEngineProgress] = useState<string>("");
  const [reviewData, setReviewData] = useState<ReviewData | null>(null);

  // Chessground
  const boardEl = useRef<HTMLDivElement>(null);
  const cgRef = useRef<ChessgroundApi | null>(null);
  const [lastMove, setLastMove] = useState<[CgKey, CgKey] | undefined>(undefined);

  // Timer
  useEffect(() => {
    if (phase !== "training") return;
    const id = setInterval(() => {
      setElapsed((e) => e + 1);
    }, 1000);
    return () => clearInterval(id);
  }, [phase]);

  // Track time per step
  useEffect(() => {
    stepStartRef.current = Date.now();
  }, [currentStep]);

  const logStepTime = useCallback(
    (step: StepId) => {
      const spent = (Date.now() - stepStartRef.current) / 1000;
      setStepTimes((prev) => ({ ...prev, [step]: prev[step] + spent }));
    },
    []
  );

  // Initialize chessground
  useEffect(() => {
    if (!boardEl.current) return;
    const dests = fenToDests(fen);
    cgRef.current = Chessground(boardEl.current, {
      fen,
      orientation: fenToTurn(fen) === "black" ? "black" : "white",
      movable: {
        color: phase === "training" ? fenToTurn(fen) : undefined,
        free: false,
        dests,
        events: {
          after: (orig: CgKey, dest: CgKey) => {
            handleBoardMove(orig, dest);
          },
        },
      },
      draggable: {
        enabled: phase === "training",
      },
      lastMove: lastMove ? [lastMove[0], lastMove[1]] : undefined,
      coordinates: true,
      animation: { duration: 200 },
    });
    return () => {
      cgRef.current?.destroy();
      cgRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Update chessground when fen / step / phase changes
  useEffect(() => {
    if (!cgRef.current) return;
    const dests = fenToDests(fen);
    const canMove = phase === "training";
    cgRef.current.set({
      fen,
      movable: {
        color: canMove ? fenToTurn(fen) : undefined,
        free: false,
        dests,
        events: {
          after: (orig: CgKey, dest: CgKey) => {
            handleBoardMove(orig, dest);
          },
        },
      },
      draggable: { enabled: canMove },
      lastMove: lastMove ? [lastMove[0], lastMove[1]] : undefined,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fen, currentStep, phase, strictMode, lastMove]);

  const handleBoardMove = useCallback(
    (orig: CgKey, dest: CgKey) => {
      const game = new Chess(fen);
      let promotion: string | undefined = undefined;
      const piece = game.get(orig as never);
      if (
        piece &&
        piece.type === "p" &&
        ((dest[1] === "8" && piece.color === "w") ||
          (dest[1] === "1" && piece.color === "b"))
      ) {
        promotion = "q";
      }
      try {
        const move = game.move({ from: orig, to: dest, promotion });
        if (!move) return;
        const san = move.san;

        if (currentStep === 5) {
          setPlayedMove(san);
          setLastMove([orig, dest]);
          return;
        }

        // For steps 1-4, capture the SAN and reset the board
        setLastMove([orig, dest]);

        if (currentStep === 1) {
          setMyCct((prev) => (prev.trim() ? prev + "\n" : "") + san);
        } else if (currentStep === 2) {
          setTheirCct((prev) => (prev.trim() ? prev + "\n" : "") + san);
        } else if (currentStep === 3) {
          const nextEmpty = candidates.findIndex((c) => c.trim() === "");
          if (nextEmpty !== -1) {
            const next = [...candidates];
            next[nextEmpty] = san;
            setCandidates(next);
          }
        } else if (currentStep === 4) {
          const nextEmpty = candidateLines.findIndex(
            (l) => l.myMove.trim() === ""
          );
          if (nextEmpty !== -1) {
            const next = [...candidateLines];
            next[nextEmpty] = { ...next[nextEmpty], myMove: san };
            setCandidateLines(next);
          }
        }

        // Reset board to original position so user can drag another move
        setTimeout(() => {
          const dests = fenToDests(fen);
          cgRef.current?.set({
            fen,
            movable: {
              color: fenToTurn(fen),
              free: false,
              dests,
              events: {
                after: (o: CgKey, d: CgKey) => handleBoardMove(o, d),
              },
            },
            lastMove: undefined,
            animation: { enabled: true, duration: 200 },
          });
        }, 300);

      } catch {
        // ignore illegal
      }
    },
    [fen, currentStep, candidates, candidateLines]
  );

  const reset = useCallback(() => {
    setFen(START_FEN);
    setPhase("training");
    setCurrentStep(1);
    setMyCct("");
    setTheirCct("");
    setCandidates(["", "", ""]);
    setCandidateLines([
      { myMove: "", theirReply: "", myFollowUp: "" },
      { myMove: "", theirReply: "", myFollowUp: "" },
      { myMove: "", theirReply: "", myFollowUp: "" },
    ]);
    setPlayedMove("");
    setElapsed(0);
    setStepTimes({ 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 });
    setLastMove(undefined);
    setReviewData(null);
    setEngineProgress("");
    stepStartRef.current = Date.now();
  }, []);

  // Validation
  const candidatesValid = useMemo(() => {
    return candidates.every((c) => c.trim() !== "" && isValidSan(fen, c));
  }, [candidates, fen]);

  const candidateLinesValid = useMemo(() => {
    return candidateLines.every((line) => {
      return line.myMove.trim() !== "";
    });
  }, [candidateLines]);

  const playedMoveValid = useMemo(() => {
    return playedMove.trim() !== "" && isValidSan(fen, playedMove);
  }, [playedMove, fen]);

  const legalMoves = useMemo(() => legalSans(fen), [fen]);

  const canAdvance = useCallback(
    (step: StepId): boolean => {
      if (!strictMode) return true;
      switch (step) {
        case 1:
          return myCct.trim().length > 0;
        case 2:
          return theirCct.trim().length > 0;
        case 3:
          return candidatesValid;
        case 4:
          return candidateLinesValid;
        case 5:
          return playedMoveValid;
      }
    },
    [
      strictMode,
      myCct,
      theirCct,
      candidatesValid,
      candidateLinesValid,
      playedMoveValid,
    ]
  );

  const advanceStep = useCallback(
    (fromStep: StepId) => {
      if (strictMode && !canAdvance(fromStep)) return;
      logStepTime(fromStep);
      if (fromStep < 5) {
        setCurrentStep((fromStep + 1) as StepId);
      }
    },
    [strictMode, canAdvance, logStepTime]
  );

  // Submit for analysis
  const submitForAnalysis = useCallback(async () => {
    if (!playedMoveValid) return;
    logStepTime(5);
    setPhase("evaluating");
    setEngineLoading(true);
    setEngineProgress("Loading engine...");

    try {
      if (!engineRef.current) {
        engineRef.current = new StockfishEngine();
        await engineRef.current.init();
      }
      const engine = engineRef.current;

      // 1. Evaluate position BEFORE the move (side to move POV)
      setEngineProgress("Evaluating position before move...");
      const preLines = await engine.analyzeMultiPV(fen, 18, 3, (info) => {
        setEngineProgress(`Evaluating position... depth ${info.depth}`);
      });
      const preBest = preLines[0];
      const preEvalCp = preBest?.scoreCp ?? 0;
      const preEvalMate = preBest?.mate ?? null;

      // 2. Get the FEN after the played move
      const postFen = fenAfterSan(fen, playedMove);
      if (!postFen) {
        setEngineLoading(false);
        setPhase("training");
        return;
      }

      // 3. Evaluate position AFTER the move (from opponent's POV)
      setEngineProgress("Evaluating after your move...");
      const postLines = await engine.analyzeMultiPV(postFen, 18, 3, (info) => {
        setEngineProgress(`Evaluating after move... depth ${info.depth}`);
      });
      const postBest = postLines[0];
      // postEvalCp is from opponent POV; negate to get our POV
      const postEvalCpRaw = postBest?.scoreCp ?? 0;
      const postEvalMate = postBest?.mate ?? null;
      const postEvalCp = -postEvalCpRaw;

      // 4. Compute centipawn loss
      let cpLoss: number;
      if (preEvalMate !== null) {
        // If already mate, can't really lose; use 0 if we maintain mate
        cpLoss = postEvalMate !== null ? 0 : 1000;
      } else if (postEvalMate !== null) {
        // We found mate after our move — that's great, no loss
        cpLoss = 0;
      } else {
        cpLoss = Math.max(0, preEvalCp - postEvalCp);
      }

      const accuracy = accuracyFromCpLoss(cpLoss);

      // 5. Best move SAN
      const bestUci = preBest?.uciMoves[0] ?? "";
      const bestSan = bestUci ? uciToSanSingle(fen, bestUci) || "" : "";

      // 6. Top 3 in SAN
      const topThree = preLines.slice(0, 3).map((line) => {
        const san = line.uciMoves[0] ? uciToSanSingle(fen, line.uciMoves[0]) || "" : "";
        return { san, scoreCp: line.scoreCp, mate: line.mate };
      });

      // 7. Did candidates include best?
      const candidateIncludedBest = candidates.some(
        (c) => c.trim() === bestSan
      );

      const playedUci = sanToUci(fen, playedMove) || "";

      const data: ReviewData = {
        playedMoveSan: playedMove,
        playedMoveUci: playedUci,
        accuracy,
        cpLoss,
        bestMoveSan: bestSan,
        topThree,
        candidateIncludedBest,
        preEvalCp,
        postEvalCp,
      };
      setReviewData(data);
      setEngineLoading(false);
      setPhase("review");
    } catch (err) {
      console.error("Engine error", err);
      setEngineLoading(false);
      setPhase("training");
      setCurrentStep(5);
      setEngineProgress("Engine error. Try again.");
    }
  }, [playedMoveValid, fen, playedMove, logStepTime, candidates]);

  // Cleanup engine on unmount
  useEffect(() => {
    return () => {
      engineRef.current?.terminate();
    };
  }, []);

  return (
    <div className="min-h-screen bg-slate-100 text-slate-800">
      {/* Header */}
      <header className="border-b border-slate-200 bg-white/80 backdrop-blur-sm">
        <div className="mx-auto max-w-7xl px-4 py-4 sm:px-6 lg:px-8">
          <div className="flex items-center justify-between gap-4 flex-wrap">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-slate-800 text-white">
                <Target className="h-5 w-5" />
              </div>
              <div>
                <h1 className="text-lg font-semibold tracking-tight text-slate-900">
                  My Chess Checklist Trainer
                </h1>
                <p className="text-xs text-slate-500">
                  Train your calculation discipline, one position at a time.
                </p>
              </div>
            </div>
            <div className="flex items-center gap-3">
              <div className="flex items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-1.5">
                <Clock className="h-4 w-4 text-slate-500" />
                <span className="font-mono text-sm font-medium tabular-nums text-slate-700">
                  {formatTime(elapsed)}
                </span>
              </div>
              <button
                onClick={() => setStrictMode((s) => !s)}
                className={`flex items-center gap-2 rounded-lg border px-3 py-1.5 text-sm font-medium transition-colors ${
                  strictMode
                    ? "border-slate-300 bg-slate-800 text-white hover:bg-slate-700"
                    : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
                }`}
              >
                {strictMode ? (
                  <Lock className="h-4 w-4" />
                ) : (
                  <Unlock className="h-4 w-4" />
                )}
                Strict Mode {strictMode ? "On" : "Off"}
              </button>
              <button
                onClick={reset}
                className="flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm font-medium text-slate-600 transition-colors hover:bg-slate-50"
              >
                <RotateCcw className="h-4 w-4" />
                Reset
              </button>
            </div>
          </div>
        </div>
      </header>

      {/* Main */}
      <main className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8">
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,440px)]">
          {/* Board */}
          <div className="flex flex-col gap-4">
            <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
              <div className="mx-auto aspect-square w-full max-w-[560px]">
                <div ref={boardEl} className="cg-wrap aspect-square w-full" />
              </div>
            </div>
            {phase === "training" && currentStep === 5 && (
              <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
                <label className="mb-1.5 block text-sm font-medium text-slate-700">
                  Play your move (type SAN or drag on board)
                </label>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={playedMove}
                    onChange={(e) => setPlayedMove(e.target.value)}
                    placeholder="e.g. Nc3, Bxf7+, O-O"
                    list="legal-moves"
                    className="flex-1 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm outline-none focus:border-slate-400 focus:bg-white"
                  />
                  <datalist id="legal-moves">
                    {legalMoves.map((m) => (
                      <option key={m} value={m} />
                    ))}
                  </datalist>
                </div>
                {playedMove.trim() !== "" && !playedMoveValid && (
                  <p className="mt-1.5 text-xs text-red-500">
                    Not a legal move in this position.
                  </p>
                )}
              </div>
            )}
          </div>

          {/* Panel */}
          <div className="flex flex-col gap-4">
            {/* Step progress */}
            <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
              <div className="mb-3 flex items-center justify-between">
                <h2 className="text-sm font-semibold text-slate-700">
                  Checklist Progress
                </h2>
                <span className="text-xs text-slate-400">
                  Step {currentStep} of 5
                </span>
              </div>
              <div className="space-y-1">
                {([1, 2, 3, 4, 5] as StepId[]).map((s) => {
                  const Icon = STEP_ICONS[s];
                  const done = s < currentStep;
                  const active = s === currentStep;
                  return (
                    <div
                      key={s}
                      className={`flex items-center gap-3 rounded-lg px-3 py-2 transition-colors ${
                        active
                          ? "bg-slate-100"
                          : done
                          ? "opacity-60"
                          : "opacity-40"
                      }`}
                    >
                      {done ? (
                        <CheckCircle2 className="h-4 w-4 text-emerald-500" />
                      ) : (
                        <Circle className="h-4 w-4 text-slate-300" />
                      )}
                      <Icon className="h-4 w-4 text-slate-400" />
                      <span
                        className={`text-sm ${
                          active
                            ? "font-medium text-slate-800"
                            : "text-slate-500"
                        }`}
                      >
                        {s}. {STEP_LABELS[s]}
                      </span>
                      {stepTimes[s] > 0 && (
                        <span className="ml-auto font-mono text-xs text-slate-400">
                          {formatTime(stepTimes[s])}
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Step content */}
            {phase === "training" && (
              <StepContent
                step={currentStep}
                fen={fen}
                myCct={myCct}
                setMyCct={setMyCct}
                theirCct={theirCct}
                setTheirCct={setTheirCct}
                candidates={candidates}
                setCandidates={setCandidates}
                candidateLines={candidateLines}
                setCandidateLines={setCandidateLines}
                playedMove={playedMove}
                setPlayedMove={setPlayedMove}
                legalMoves={legalMoves}
                strictMode={strictMode}
                canAdvance={canAdvance}
                onAdvance={advanceStep}
                onSubmit={submitForAnalysis}
              />
            )}

            {phase === "evaluating" && (
              <div className="flex flex-col items-center justify-center gap-4 rounded-2xl border border-slate-200 bg-white p-8 shadow-sm">
                {engineProgress.startsWith("Engine error") || engineProgress.startsWith("Engine failed") ? (
                  <>
                    <AlertTriangle className="h-8 w-8 text-red-400" />
                    <p className="text-sm font-medium text-red-600">
                      {engineProgress}
                    </p>
                    <p className="text-xs text-slate-400 max-w-xs text-center">
                      Stockfish requires cross-origin isolation headers. If the dev server was just updated, please refresh the page.
                    </p>
                  </>
                ) : (
                  <>
                    <Loader2 className="h-8 w-8 animate-spin text-slate-400" />
                    <p className="text-sm font-medium text-slate-600">
                      {engineProgress || "Evaluating position..."}
                    </p>
                    <p className="text-xs text-slate-400">
                      Running Stockfish at depth 18...
                    </p>
                  </>
                )}
              </div>
            )}

            {phase === "review" && reviewData && (
              <ReviewScreen data={reviewData} onReset={reset} />
            )}
          </div>
        </div>
      </main>
    </div>
  );
}

/* ---------- Step Content ---------- */

interface StepContentProps {
  step: StepId;
  fen: string;
  myCct: string;
  setMyCct: (v: string) => void;
  theirCct: string;
  setTheirCct: (v: string) => void;
  candidates: string[];
  setCandidates: (v: string[]) => void;
  candidateLines: CandidateLine[];
  setCandidateLines: (v: CandidateLine[]) => void;
  playedMove: string;
  setPlayedMove: (v: string) => void;
  legalMoves: string[];
  strictMode: boolean;
  canAdvance: (step: StepId) => boolean;
  onAdvance: (step: StepId) => void;
  onSubmit: () => void;
}

function StepContent(props: StepContentProps) {
  const {
    step,
    fen,
    myCct,
    setMyCct,
    theirCct,
    setTheirCct,
    candidates,
    setCandidates,
    candidateLines,
    setCandidateLines,
    playedMove,
    setPlayedMove,
    legalMoves,
    strictMode,
    canAdvance,
    onAdvance,
    onSubmit,
  } = props;

  const cardClass =
    "rounded-2xl border border-slate-200 bg-white p-5 shadow-sm";

  if (step === 1) {
    return (
      <div className={cardClass}>
        <StepHeader step={1} title="Your CCT" subtitle="Checks, Captures, Threats for your side — drag pieces on the board to auto-fill" />
        <textarea
          value={myCct}
          onChange={(e) => setMyCct(e.target.value)}
          rows={5}
          placeholder="List all checks, captures, and threats available to you..."
          className="w-full resize-none rounded-lg border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm outline-none focus:border-slate-400 focus:bg-white"
        />
        <NextButton
          disabled={strictMode && !canAdvance(1)}
          onClick={() => onAdvance(1)}
        />
      </div>
    );
  }

  if (step === 2) {
    return (
      <div className={cardClass}>
        <StepHeader step={2} title="Their CCT" subtitle="Checks, Captures, Threats for your opponent — drag pieces on the board to auto-fill" />
        <textarea
          value={theirCct}
          onChange={(e) => setTheirCct(e.target.value)}
          rows={5}
          placeholder="List all checks, captures, and threats available to your opponent..."
          className="w-full resize-none rounded-lg border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm outline-none focus:border-slate-400 focus:bg-white"
        />
        <NextButton
          disabled={strictMode && !canAdvance(2)}
          onClick={() => onAdvance(2)}
        />
      </div>
    );
  }

  if (step === 3) {
    return (
      <div className={cardClass}>
        <StepHeader step={3} title="3 Candidates" subtitle="Enter exactly 3 candidate moves (SAN) — or drag on the board" />
        <div className="space-y-2.5">
          {candidates.map((c, i) => (
            <div key={i} className="flex items-center gap-2">
              <span className="flex h-6 w-6 items-center justify-center rounded-md bg-slate-100 text-xs font-medium text-slate-500">
                {i + 1}
              </span>
              <input
                type="text"
                value={c}
                onChange={(e) => {
                  const next = [...candidates];
                  next[i] = e.target.value;
                  setCandidates(next);
                }}
                list="legal-moves-step3"
                placeholder={`Candidate ${i + 1} (e.g. Nc3)`}
                className="flex-1 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm outline-none focus:border-slate-400 focus:bg-white"
              />
              {c.trim() !== "" && (
                <span className="text-xs">
                  {isValidSan(fen, c) ? (
                    <CheckCircle2 className="h-4 w-4 text-emerald-500" />
                  ) : (
                    <span className="text-red-500">invalid</span>
                  )}
                </span>
              )}
            </div>
          ))}
          <datalist id="legal-moves-step3">
            {legalMoves.map((m) => (
              <option key={m} value={m} />
            ))}
          </datalist>
        </div>
        <NextButton
          disabled={strictMode && !canAdvance(3)}
          onClick={() => onAdvance(3)}
        />
      </div>
    );
  }

  if (step === 4) {
    return (
      <div className={cardClass}>
        <StepHeader
          step={4}
          title="Calculate 3 Plies"
          subtitle="For each candidate: your move, likely reply, your follow-up — drag on the board to fill 'My move'"
        />
        <div className="space-y-4">
          {candidateLines.map((line, i) => (
            <div
              key={i}
              className="rounded-xl border border-slate-100 bg-slate-50/50 p-3"
            >
              <div className="mb-2 flex items-center gap-2">
                <span className="flex h-5 w-5 items-center justify-center rounded-md bg-slate-200 text-xs font-medium text-slate-600">
                  {i + 1}
                </span>
                <span className="text-xs font-medium text-slate-500">
                  {candidates[i].trim() || `Candidate ${i + 1}`}
                </span>
              </div>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                <PlyInput
                  label="My move"
                  value={line.myMove}
                  onChange={(v) => {
                    const next = [...candidateLines];
                    next[i] = { ...line, myMove: v };
                    setCandidateLines(next);
                  }}
                />
                <PlyInput
                  label="Likely reply"
                  value={line.theirReply}
                  onChange={(v) => {
                    const next = [...candidateLines];
                    next[i] = { ...line, theirReply: v };
                    setCandidateLines(next);
                  }}
                />
                <PlyInput
                  label="My follow-up"
                  value={line.myFollowUp}
                  onChange={(v) => {
                    const next = [...candidateLines];
                    next[i] = { ...line, myFollowUp: v };
                    setCandidateLines(next);
                  }}
                />
              </div>
            </div>
          ))}
        </div>
        <NextButton
          disabled={strictMode && !canAdvance(4)}
          onClick={() => onAdvance(4)}
        />
      </div>
    );
  }

  // Step 5
  return (
    <div className={cardClass}>
      <StepHeader
        step={5}
        title="Play Move"
        subtitle="Enter your move in SAN or drag on the board"
      />
      <div className="flex gap-2">
        <input
          type="text"
          value={playedMove}
          onChange={(e) => setPlayedMove(e.target.value)}
          list="legal-moves-step5"
          placeholder="e.g. Nc3, Bxf7+, O-O"
          className="flex-1 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm outline-none focus:border-slate-400 focus:bg-white"
        />
        <datalist id="legal-moves-step5">
          {legalMoves.map((m) => (
            <option key={m} value={m} />
          ))}
        </datalist>
      </div>
      {playedMove.trim() !== "" && !isValidSan(fen, playedMove) && (
        <p className="mt-1.5 text-xs text-red-500">
          Not a legal move in this position.
        </p>
      )}
      <button
        onClick={onSubmit}
        disabled={strictMode && !canAdvance(5)}
        className="mt-4 flex w-full items-center justify-center gap-2 rounded-lg bg-slate-800 px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-40"
      >
        <Sparkles className="h-4 w-4" />
        Submit for Analysis
      </button>
    </div>
  );
}

function StepHeader({
  step,
  title,
  subtitle,
}: {
  step: StepId;
  title: string;
  subtitle: string;
}) {
  return (
    <div className="mb-4">
      <div className="flex items-center gap-2">
        <span className="flex h-6 w-6 items-center justify-center rounded-md bg-slate-800 text-xs font-semibold text-white">
          {step}
        </span>
        <h3 className="text-base font-semibold text-slate-800">{title}</h3>
      </div>
      <p className="mt-1 text-xs text-slate-500">{subtitle}</p>
    </div>
  );
}

function NextButton({
  disabled,
  onClick,
}: {
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="mt-4 flex w-full items-center justify-center gap-2 rounded-lg bg-slate-800 px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-40"
    >
      Next
      <ChevronRight className="h-4 w-4" />
    </button>
  );
}

function PlyInput({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div>
      <label className="mb-1 block text-xs font-medium text-slate-500">
        {label}
      </label>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="e.g. Nc3"
        className="w-full rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-sm outline-none focus:border-slate-400"
      />
    </div>
  );
}

/* ---------- Review Screen ---------- */

function ReviewScreen({
  data,
  onReset,
}: {
  data: ReviewData;
  onReset: () => void;
}) {
  const accuracyColor =
    data.accuracy >= 85
      ? "text-emerald-600"
      : data.accuracy >= 60
      ? "text-amber-600"
      : "text-red-600";

  return (
    <div className="space-y-4">
      {/* Accuracy */}
      <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <div className="mb-3 flex items-center gap-2">
          <Trophy className="h-5 w-5 text-amber-500" />
          <h3 className="text-sm font-semibold text-slate-700">
            Move Accuracy
          </h3>
        </div>
        <div className="flex items-end justify-between">
          <div>
            <p className={`text-4xl font-bold ${accuracyColor}`}>
              {data.accuracy}
              <span className="text-lg text-slate-400">/100</span>
            </p>
            <p className="mt-1 text-xs text-slate-500">
              You played: <span className="font-mono font-medium text-slate-700">{data.playedMoveSan}</span>
            </p>
          </div>
          <div className="text-right">
            <p className="text-xs text-slate-400">Centipawn loss</p>
            <p className="text-lg font-semibold text-slate-700">
              {data.cpLoss} cp
            </p>
          </div>
        </div>
      </div>

      {/* Candidate check */}
      <div
        className={`rounded-2xl border p-5 shadow-sm ${
          data.candidateIncludedBest
            ? "border-emerald-200 bg-emerald-50"
            : "border-amber-200 bg-amber-50"
        }`}
      >
        <div className="flex items-center gap-2">
          {data.candidateIncludedBest ? (
            <CheckCircle2 className="h-5 w-5 text-emerald-600" />
          ) : (
            <AlertTriangle className="h-5 w-5 text-amber-600" />
          )}
          <h3 className="text-sm font-semibold text-slate-700">
            Candidate Quality
          </h3>
        </div>
        <p className="mt-2 text-sm text-slate-600">
          {data.candidateIncludedBest
            ? `Great! The engine's best move (${data.bestMoveSan}) was in your 3 candidates.`
            : `The engine's best move (${data.bestMoveSan}) was NOT among your 3 candidates.`}
        </p>
      </div>

      {/* Top 3 moves */}
      <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <div className="mb-3 flex items-center gap-2">
          <Brain className="h-5 w-5 text-slate-500" />
          <h3 className="text-sm font-semibold text-slate-700">
            Stockfish Top 3 Moves
          </h3>
        </div>
        <div className="space-y-2">
          {data.topThree.map((m, i) => (
            <div
              key={i}
              className={`flex items-center justify-between rounded-lg border px-3 py-2 ${
                m.san === data.playedMoveSan
                  ? "border-emerald-200 bg-emerald-50"
                  : "border-slate-100 bg-slate-50"
              }`}
            >
              <div className="flex items-center gap-2">
                <span className="flex h-5 w-5 items-center justify-center rounded-md bg-slate-200 text-xs font-medium text-slate-600">
                  {i + 1}
                </span>
                <span className="font-mono text-sm font-medium text-slate-700">
                  {m.san}
                </span>
                {m.san === data.playedMoveSan && (
                  <span className="text-xs text-emerald-600">your move</span>
                )}
              </div>
              <span className="font-mono text-xs text-slate-500">
                {m.mate !== null
                  ? `M${m.mate}`
                  : m.scoreCp !== null
                  ? `${m.scoreCp > 0 ? "+" : ""}${(m.scoreCp / 100).toFixed(2)}`
                  : "—"}
              </span>
            </div>
          ))}
        </div>
      </div>

      {/* Best move highlight */}
      <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <div className="flex items-center gap-2">
          <Target className="h-5 w-5 text-slate-500" />
          <h3 className="text-sm font-semibold text-slate-700">
            Engine's Best Move
          </h3>
        </div>
        <p className="mt-2 font-mono text-2xl font-bold text-slate-800">
          {data.bestMoveSan}
        </p>
      </div>

      <button
        onClick={onReset}
        className="flex w-full items-center justify-center gap-2 rounded-lg bg-slate-800 px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-slate-700"
      >
        <RotateCcw className="h-4 w-4" />
        New Position
      </button>
    </div>
  );
}
