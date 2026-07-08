// Flat ESLint config. Lightweight but real: catches undefined variables,
// unused vars, and obvious mistakes across the server code — the class of drift
// that unit tests don't. Browser assets live in public/ and are linted with the
// browser globals.
import js from "@eslint/js";

export default [
  js.configs.recommended,
  {
    files: ["src/**/*.js", "scripts/**/*.js", "test/**/*.js"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      globals: {
        process: "readonly",
        console: "readonly",
        Buffer: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        setInterval: "readonly",
        clearInterval: "readonly",
        fetch: "readonly",
        URL: "readonly",
        URLSearchParams: "readonly",
        AbortController: "readonly",
        __dirname: "readonly",
      },
    },
    rules: {
      "no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "no-undef": "error",
      "no-console": "off",
      "no-empty": ["warn", { allowEmptyCatch: true }],
    },
  },
  {
    files: ["public/**/*.html"],
    ignores: ["**/*"], // HTML isn't linted by ESLint here; inline JS is reviewed manually.
  },
];
