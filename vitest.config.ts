import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        include: ["src/*/src/**/*.{test,spec}.{js,ts}"],
        environment: "node",
    },
});
