import "./env.js"
import { createApp } from "./app.js"
import { kilo } from "./kilo.js"

// 3100 by default: port 3000 is commonly taken by local dev stacks / containers.
const PORT = Number(process.env.PORT || 3100)
const HOST = process.env.HOST || "0.0.0.0"

const app = createApp()
const server = app.listen(PORT, HOST, () => {
  console.log(`kilo-code web listening on http://${HOST === "0.0.0.0" ? "localhost" : HOST}:${PORT}`)
})
server.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EADDRINUSE") {
    console.error(`Port ${PORT} is already in use (HOST=${HOST}). Stop the other process or set PORT to a free port.`)
  } else {
    console.error(`Server error: ${err.message}`)
  }
  process.exit(1)
})

// Start kilo (non-blocking): login page renders even while it warms up.
void kilo.init()

function shutdown() {
  console.log("shutting down…")
  kilo.stop()
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(0), 3_000).unref()
}
process.on("SIGTERM", shutdown)
process.on("SIGINT", shutdown)
