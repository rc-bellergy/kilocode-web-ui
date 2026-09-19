import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { BrowserRouter } from "react-router-dom"
import App from "./App"
import "./index.css"
import { onSessionExpired } from "./lib/api"

onSessionExpired(() => {
  if (!window.location.pathname.startsWith("/login")) {
    window.location.href = "/login"
  }
})

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
)
