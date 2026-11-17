// Entry point for the forge.
//
// The harness runs this process beside its own env server and drives the
// whole trial through it, so this file owns only the lifecycle:
//
//   1. read the env origin from MAKEFUN_ENV_URL (absent means there is
//      nothing to serve, so exit 1 immediately);
//   2. build the HTTP app from app.ts and bind an ephemeral port;
//   3. tell the env which port we bound by POSTing /register;
//   4. poll GET /done until the env reports the trial is finished;
//   5. close the server and exit 0.
//
// Transient failures of the register POST and of individual polls are
// retried with a short exponential backoff rather than giving up: a
// process that dies before registering scores nothing at all.

import { createApp } from './app.ts';

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// One backoff schedule: start small, double each round, never wait
// longer than the cap.
function backoff(initialMs: number, capMs: number): () => Promise<void> {
  let next = initialMs;
  return async () => {
    await pause(next);
    next = Math.min(next * 2, capMs);
  };
}

// POST /register until the env has taken our port. A 2xx means the env
// recorded us. A 409 means a registration already stands (the first one
// wins and is never moved), so the step is complete either way. Network
// errors and 5xx answers are treated as transient and retried.
async function registerUntilAccepted(envUrl: string, port: number): Promise<void> {
  const wait = backoff(100, 2000);
  for (;;) {
    try {
      const res = await fetch(`${envUrl}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
      });
      if (res.ok || res.status === 409) {
        return;
      }
      if (res.status < 500) {
        // A definitive non-server refusal: retrying the identical POST
        // would not change the answer, but the registration is not in
        // place, so keep trying on the backoff rather than exit early.
        await wait();
        continue;
      }
    } catch {
      // Connection refused / reset while the env is still coming up.
    }
    await wait();
  }
}

// Poll GET /done until it answers {"done": true}. Each poll is a fresh
// short request that returns at once; we never hold one open. A failed
// or malformed poll is not fatal: wait on the backoff and ask again.
async function waitUntilDone(envUrl: string): Promise<void> {
  const wait = backoff(150, 1000);
  for (;;) {
    try {
      const res = await fetch(`${envUrl}/done`);
      if (res.ok) {
        const body: unknown = await res.json();
        if (
          typeof body === 'object' &&
          body !== null &&
          (body as { done?: unknown }).done === true
        ) {
          return;
        }
      }
    } catch {
      // Env briefly unreachable; fall through to the backoff and retry.
    }
    await wait();
  }
}

async function main(): Promise<void> {
  const rawEnvUrl = process.env.MAKEFUN_ENV_URL;
  if (rawEnvUrl === undefined || rawEnvUrl.trim() === '') {
    process.exit(1);
  }
  const envUrl = rawEnvUrl.replace(/\/+$/, '');

  const server = createApp();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => resolve());
  });

  const address = server.address();
  if (address === null || typeof address === 'string') {
    // listen(0) on a TCP server always yields an AddressInfo; anything
    // else means we have no port to register.
    process.exit(1);
  }

  await registerUntilAccepted(envUrl, address.port);
  await waitUntilDone(envUrl);

  // Trial over: stop accepting work and leave with a clean status.
  // Bound the close so a lingering keep-alive socket cannot stall exit.
  await Promise.race([
    new Promise<void>((resolve) => server.close(() => resolve())),
    pause(1000),
  ]);
  process.exit(0);
}

main().catch(() => {
  process.exit(1);
});
