export default async function globalTeardown() {
  const { stopMainBackend } = await import("./helpers")
  await stopMainBackend()
}
