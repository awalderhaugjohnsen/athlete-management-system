import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    rules: {
      // A leading underscore is this codebase's convention for "intentionally unused"
      // (e.g. destructuring a field off an object purely to drop it: `{ id: _id, ...rest }`).
      "@typescript-eslint/no-unused-vars": ["warn", {
        args: "after-used",
        argsIgnorePattern: "^_",
        varsIgnorePattern: "^_",
        destructuredArrayIgnorePattern: "^_",
      }],
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Vite build output from Playwright component tests — generated, not source.
    "playwright/.cache/**",
    "test-results/**",
    "playwright-report/**",
  ]),
]);

export default eslintConfig;
