import { execSync } from "node:child_process"

export default async function globalSetup() {
  if (process.env.KILO_REAL_E2E !== "1") {
    throw new Error(
      "The real-kilo suite spawns real kilo processes and consumes real model quota on a few tests. " +
        "Run it explicitly: npm run test:real",
    )
  }
  execSync("npm run build", { cwd: new URL("..", import.meta.url).pathname, stdio: "inherit" })
  const { startMainBackend } = await import("./helpers")
  await startMainBackend()
}
