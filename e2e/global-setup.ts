import { execSync } from "node:child_process"
import { BACKEND_URL, startBackend, startMock } from "./mock-kilo-process"

export default async function globalSetup() {
  execSync("npm run build", { cwd: new URL("..", import.meta.url).pathname, stdio: "inherit" })
  await startMock()
  await startBackend()
  void BACKEND_URL
}
