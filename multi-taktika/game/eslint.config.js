// @ts-check
import js from '@eslint/js';
import tsParser from '@typescript-eslint/parser';
import tsPlugin from '@typescript-eslint/eslint-plugin';

/**
 * 層の依存方向（実装手順書 §3.1）と決定論の禁止事項（§0.3）を機械的に強制する。
 *
 * 手順書では eslint-plugin-boundaries を挙げていたが、
 * flat config の per-file override + no-restricted-imports で同じ制約が表現でき、
 * 依存を 1 つ減らせるためこちらを採用した（docs/ISSUES.md に記録）。
 */

/** sim が import してはいけない層 */
const forbiddenFromSim = ['render', 'ui', 'input', 'ai', 'net', 'replay'];

/** @type {import('eslint').Linter.Config['rules']} */
const determinismRules = {
  'no-restricted-properties': [
    'error',
    {
      object: 'Math',
      property: 'random',
      message: '決定論違反: sim では Rng（sim/core/rng.ts）を使うこと。実装手順書 §0.3',
    },
    {
      object: 'Date',
      property: 'now',
      message: '決定論違反: sim では world.tick を使うこと。実装手順書 §0.3',
    },
    {
      object: 'performance',
      property: 'now',
      message: '決定論違反: sim では world.tick を使うこと。実装手順書 §0.3',
    },
  ],
  'no-restricted-globals': [
    'error',
    { name: 'window', message: '層違反: sim から DOM を触ってはいけない。実装手順書 §3.1' },
    { name: 'document', message: '層違反: sim から DOM を触ってはいけない。実装手順書 §3.1' },
    { name: 'localStorage', message: '層違反: sim は端末ローカル状態を持たない。実装手順書 §3.1' },
    { name: 'WebSocket', message: '層違反: 通信は net 層の責務。実装手順書 §3.1' },
  ],
  'no-restricted-syntax': [
    'error',
    {
      selector: 'NewExpression[callee.name="Date"]',
      message: '決定論違反: sim で Date を作ってはいけない。実装手順書 §0.3',
    },
  ],
};

export default [
  { ignores: ['dist/**', 'node_modules/**', 'public/**'] },
  js.configs.recommended,
  {
    files: ['**/*.ts'],
    languageOptions: {
      parser: tsParser,
      parserOptions: { ecmaVersion: 2022, sourceType: 'module' },
      globals: {
        console: 'readonly',
        performance: 'readonly',
        structuredClone: 'readonly',
        TextEncoder: 'readonly',
        TextDecoder: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        requestAnimationFrame: 'readonly',
        cancelAnimationFrame: 'readonly',
      },
    },
    plugins: { '@typescript-eslint': tsPlugin },
    rules: {
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      'no-undef': 'off', // TS が担保する
      eqeqeq: ['error', 'always'],
      'prefer-const': 'error',
    },
  },
  {
    // ---- sim 層: 層違反と決定論違反を禁止 ----
    files: ['src/sim/**/*.ts'],
    languageOptions: {
      globals: { console: 'readonly' },
    },
    rules: {
      ...determinismRules,
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            ...forbiddenFromSim.map((layer) => ({
              group: [`**/${layer}`, `**/${layer}/**`, `@/${layer}`, `@/${layer}/**`],
              message: `層違反: sim は ${layer} を import できない（shared と data のみ可）。実装手順書 §3.1`,
            })),
          ],
        },
      ],
    },
  },
  {
    // ---- render / ui: sim の状態を書き換えないこと（規約。機械検出は将来課題）----
    files: ['src/render/**/*.ts', 'src/ui/**/*.ts'],
    languageOptions: {
      globals: {
        window: 'readonly',
        document: 'readonly',
        localStorage: 'readonly',
        HTMLElement: 'readonly',
        HTMLCanvasElement: 'readonly',
        CanvasRenderingContext2D: 'readonly',
        Image: 'readonly',
        Event: 'readonly',
        MouseEvent: 'readonly',
        KeyboardEvent: 'readonly',
        WheelEvent: 'readonly',
        console: 'readonly',
        performance: 'readonly',
        requestAnimationFrame: 'readonly',
        cancelAnimationFrame: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        fetch: 'readonly',
      },
    },
    rules: {},
  },
  {
    files: ['tests/**/*.ts', 'server/**/*.ts', '*.config.ts'],
    languageOptions: {
      globals: { console: 'readonly', process: 'readonly', setTimeout: 'readonly' },
    },
    rules: {},
  },
];
