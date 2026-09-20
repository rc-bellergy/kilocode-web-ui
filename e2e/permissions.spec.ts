import { expect, test } from "@playwright/test"
import { control, mockState } from "./mock-kilo-process"
import { createMockSession, login, resetMock } from "./helpers"

test.beforeEach(async ({ page }) => {
  await resetMock()
  await login(page)
})

test.describe("E2E-6 permission inbox", () => {
  test("permission.asked badges the inbox; replies reach the mock with the right body", async ({ page }) => {
    const sessionID = await createMockSession()
    const inboxButton = page.getByTitle("Permission requests")

    const request = (await control("/__control/permission", {
      sessionID,
      permission: "bash",
      patterns: ["rm -rf /tmp/**"],
      metadata: { command: "rm -rf /tmp/kilo-e2e/scratch" },
    })) as { id: string }

    // Badge count appears.
    await expect(inboxButton.locator("span", { hasText: "1" })).toBeVisible()

    // Open the inbox: request details shown.
    await inboxButton.click()
    const panel = page.locator("aside")
    await expect(panel.getByText("bash").first()).toBeVisible()
    await expect(panel.getByText("rm -rf /tmp/kilo-e2e/scratch")).toBeVisible()

    // Allow once (panel stays open and live-updates with new requests).
    await panel.getByRole("button", { name: "Approve" }).click()
    await expect(inboxButton.locator("span", { hasText: "1" })).toHaveCount(0)
    let { replies } = await mockState()
    expect(replies.at(-1)).toMatchObject({ requestID: request.id, reply: "once" })
    await expect(panel.getByText("Nothing pending")).toBeVisible()

    // Always allow on a fresh request rendered into the same panel.
    const request2 = (await control("/__control/permission", { sessionID, permission: "bash" })) as { id: string }
    const alwaysBtn = panel.getByRole("button", { name: "Always allow" })
    await expect(alwaysBtn).toBeVisible({ timeout: 10_000 })
    await alwaysBtn.click()
    ;({ replies } = await mockState())
    expect(replies.at(-1)).toMatchObject({ requestID: request2.id, reply: "always" })
    await expect(panel.getByText("Nothing pending")).toBeVisible()

    // Reject with feedback.
    const request3 = (await control("/__control/permission", { sessionID, permission: "bash" })) as { id: string }
    const rejectBtn = panel.getByRole("button", { name: "Reject", exact: true })
    await expect(rejectBtn).toBeVisible({ timeout: 10_000 })
    await rejectBtn.click()
    await panel.getByPlaceholder(/Optional feedback/).fill("use a safer command")
    await panel.getByRole("button", { name: "Send rejection" }).click()
    await expect(inboxButton.locator("span", { hasText: "1" })).toHaveCount(0)
    ;({ replies } = await mockState())
    expect(replies.at(-1)).toMatchObject({ requestID: request3.id, reply: "reject", message: "use a safer command" })
  })

  test("drawer overlays the full viewport and closes via the close button", async ({ page }) => {
    const sessionID = await createMockSession()
    await control("/__control/permission", { sessionID, permission: "bash" })
    const inboxButton = page.getByTitle("Permission requests")
    await expect(inboxButton.locator("span", { hasText: "1" })).toBeVisible()

    await inboxButton.click()
    const panel = page.locator("aside")
    await expect(panel.getByRole("button", { name: "Approve" })).toBeVisible()

    // Regression (backdrop-blur containing block): the overlay must be a
    // body-level portal covering the viewport, not a fixed child squeezed
    // into the blurred header strip.
    const overlay = page.locator("body > div.fixed")
    await expect(overlay).toHaveCount(1)
    const viewport = page.viewportSize()!
    const box = await overlay.boundingBox()
    expect(box).toEqual({ x: 0, y: 0, width: viewport.width, height: viewport.height })
    const approveBox = await panel.getByRole("button", { name: "Approve" }).boundingBox()
    expect(approveBox!.y).toBeGreaterThan(0)
    expect(approveBox!.y + approveBox!.height).toBeLessThanOrEqual(viewport.height)

    // Close button dismisses the drawer.
    await panel.getByRole("button", { name: "Close permission requests" }).click()
    await expect(page.locator("aside")).toHaveCount(0)
  })
})
