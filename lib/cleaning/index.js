const { runCycle } = require('./cleanWorker');

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

/** @type {number|null} */
let timer = null;
/** @type {boolean} */
let running = false;

/**
 * Start the cleaning worker on a 5-minute interval.
 * @param {{ intervalMs?: number }} [options]
 */
function start(options = {}) {
  if (running) return;
  running = true;

  const intervalMs = options.intervalMs || DEFAULT_INTERVAL_MS;

  // Run once immediately on startup
  runCycle();

  timer = setInterval(() => {
    runCycle();
  }, intervalMs);

  // Unref so it doesn't keep the process alive
  if (timer.unref) timer.unref();

  console.log(`[cleaning] Worker started (every ${intervalMs / 1000}s)`);
}

/**
 * Stop the cleaning worker.
 */
function stop() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  running = false;
}

module.exports = { start, stop };
