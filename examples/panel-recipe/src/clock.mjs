// Time, injectable: a test drives the whole recipe with a fake clock and no real waiting.

export const realClock = Object.freeze({
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
});
