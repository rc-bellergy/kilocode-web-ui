#!/usr/bin/env node
// Fake `kilo` CLI for KiloManager spawn tests. Behavior driven by FAKE_MODE:
//   ready            print the ready line with $FAKE_URL and stay alive (default)
//   never-ready      stay alive, print nothing on stdout
//   exit-fast        exit(1) immediately
//   ready-then-exit  print ready line, then exit after FAKE_EXIT_MS (default 300ms)
const mode = process.env.FAKE_MODE ?? "ready"

if (mode === "exit-fast") {
  process.exit(1)
}

if (mode === "ready" || mode === "ready-then-exit") {
  const url = process.env.FAKE_URL ?? "http://127.0.0.1:1"
  process.stdout.write(`fake stderr noise\n`)
  process.stdout.write(`kilo server listening on ${url}\n`)
  if (mode === "ready-then-exit") {
    setTimeout(() => process.exit(1), Number(process.env.FAKE_EXIT_MS ?? 300))
  }
} else if (mode === "never-ready") {
  process.stderr.write("fake kilo booting forever…\n")
}

// Stay alive until killed.
setInterval(() => {}, 1 << 30)
