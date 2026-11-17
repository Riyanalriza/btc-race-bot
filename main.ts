// btc-race-bot: a cbBTC/USDC bot for make.fun's "Race a BTC trading bot live for 24 hours".
//
// Strategy (my own design, fitted on the published dev window with the exact fill model):
//   * Core leg — slow mean reversion around the 480-minute simple moving average of closes.
//     BTC on this window is range-bound with wide intraday swings, so the bot buys the dip
//     (close 40 bps or more BELOW the 480-bar SMA) and sells the rip (close 80 bps or more
//     ABOVE it), full size, one position at a time. A full-size round trip costs ~34 bps in
//     fee + slippage + pool impact, so the 40/80 bps bands only fire on moves that clear it.
//   * Insurance leg — if the bot has never held a position by bar 480 and the market is in
//     a strong uptrend (close 80 bps above the SMA and the 240-minute return above +80 bps),
//     it buys and holds with a wide stop (-200 bps from entry) and take-profit (+300 bps).
//     This only exists so a monotonic uptrend day cannot leave the bot with zero trades.
//     On the dev window it never fires: the mean-reversion leg trades first.
//
// All decisions are integer (BigInt) arithmetic on the bars the harness sends; no wall clock,
// no environment, no randomness, so two runs on the same data give the same action log.

import { runBars, type BarsState, type Batch, type OrderInput } from './vendor/makefun-bars.ts';

const SYM = 'CBBTC';
const SMA_N = 480; // bars in the slow mean
const BUY_BPS = 40; // buy when close is this far BELOW the SMA (bps)
const SELL_BPS = 80; // sell when close is this far ABOVE the SMA (bps)
const INS_BAR = 480; // earliest bar (by closes seen) the insurance leg may fire
const INS_DEV_BPS = 80; // insurance entry: close this far above the SMA (bps)
const INS_MOM_BPS = 80; // insurance entry: 240-bar return above this (bps)
const INS_SL_BPS = 200; // insurance stop: this far below entry (bps)
const INS_TP_BPS = 300; // insurance take-profit: this far above entry (bps)
const MAX_SLIP_BPS = 100; // max slippage on every order (bps from the latest close)

// Closes seen so far, oldest first (warm-up bars included: they build history, never trade).
const closes: bigint[] = [];
let entry = 0n;
let leg: 'mr' | 'ins' | null = null;
let everHeld = false;

function sma(): bigint | null {
  if (closes.length < SMA_N) return null;
  let sum = 0n;
  for (let i = closes.length - SMA_N; i < closes.length; i++) sum += closes[i]!;
  return sum / BigInt(SMA_N);
}

await runBars({
  onBatch(state: BarsState, batch: Batch): OrderInput[] {
    for (const bar of batch.bars) {
      if (bar.symbol === SYM) closes.push(BigInt(bar.c));
    }
    if (state.warmingUp) return [];
    const close = state.close(SYM);
    if (close === null) return [];
    const mean = sma();
    if (mean === null) return [];
    const held = state.positions.get(SYM)?.qty ?? 0n;
    if (held > 0n) everHeld = true;
    // Deviation of the latest close from the slow mean, in bps (integer, truncating).
    const dev = (close * 10000n) / mean - 10000n;
    if (held === 0n) {
      if (dev < -BigInt(BUY_BPS)) {
        entry = close;
        leg = 'mr';
        return [{ side: 'buy', symbol: SYM, notional_quote_units: state.cash, max_slippage_bps: MAX_SLIP_BPS }];
      }
      if (!everHeld && closes.length >= INS_BAR) {
        const ref = closes[closes.length - 1 - 240]!;
        const mom240 = (close * 10000n) / ref - 10000n;
        if (dev > BigInt(INS_DEV_BPS) && mom240 > BigInt(INS_MOM_BPS)) {
          entry = close;
          leg = 'ins';
          return [{ side: 'buy', symbol: SYM, notional_quote_units: state.cash, max_slippage_bps: MAX_SLIP_BPS }];
        }
      }
      return [];
    }
    if (leg === 'mr') {
      if (dev > BigInt(SELL_BPS)) {
        return [{ side: 'sell', symbol: SYM, qty: held, max_slippage_bps: MAX_SLIP_BPS }];
      }
    } else {
      if (close <= (entry * BigInt(10000 - INS_SL_BPS)) / 10000n) {
        return [{ side: 'sell', symbol: SYM, qty: held, max_slippage_bps: MAX_SLIP_BPS }];
      }
      if (close >= (entry * BigInt(10000 + INS_TP_BPS)) / 10000n) {
        return [{ side: 'sell', symbol: SYM, qty: held, max_slippage_bps: MAX_SLIP_BPS }];
      }
    }
    return [];
  },
});
