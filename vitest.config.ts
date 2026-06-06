import { defineConfig } from "vitest/config";

// Vitest config for catlit-ttyd unit tests.
//
// happy-dom is used as the DOM environment because the component
// relies on Lit's reactive update cycle, which needs `customElements`,
// `MutationObserver`, and shadow DOM — all of which happy-dom
// provides without the cost of a real browser. Browser-mode tests
// (real xterm canvas, real WebSocket) are tracked separately and run
// only against a live ttyd; they're not part of this suite.

export default defineConfig({
  test: {
    environment: "happy-dom",
    include: ["test/**/*.test.ts"],
  },
});
