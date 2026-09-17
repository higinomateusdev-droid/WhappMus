# Mobile navigation verification

- Authenticated temporary QA workspace rendered successfully.
- At 390 × 844, the dashboard header shows a visible cyan hamburger button on the left.
- The desktop sidebar is absent at the mobile breakpoint.
- Header status and refresh controls remain visible without horizontal overflow.
- Source contains all requested destinations: Dashboard, WhatsApp, Conversas, IA, Teste da IA, and Logs.

The interactive cloud browser is fixed at 1280 × 1100 and does not allow `window.resizeTo`, but it confirmed that the hamburger trigger exists in the authenticated DOM and is hidden only by the expected `lg:hidden` breakpoint. The dedicated WebDev capture at 390 × 844 confirmed that this same trigger is visible and correctly positioned on a phone viewport.

The authenticated interaction test activated the hamburger trigger and confirmed that the drawer opened with all six destinations and their descriptions. Selecting **WhatsApp** changed the active header to `TURNSTARK / WhatsApp`, rendered the **Conexão de sessão** view, and closed the drawer automatically.
