import { killMock, stopBackend } from "./mock-kilo-process"

export default async function globalTeardown() {
  await stopBackend().catch(() => {})
  await killMock().catch(() => {})
}
