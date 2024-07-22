/* eslint-disable header/header */

import json from '@rollup/plugin-json';
import commonjs from '@rollup/plugin-commonjs';
import terser from '@rollup/plugin-terser';
import { babel } from '@rollup/plugin-babel';
import typescript from '@rollup/plugin-typescript';

import {
  babelPlugin,
  nodeResolvePlugin,
} from '../../rollup.shared.mjs';

export default [
  {
    input: 'src/indexBrowser.ts',
    output: {
      file: 'dist/artifacts/otel-web.js',
      format: 'iife',
      name: 'KloudMateRum',
      sourcemap: true,
      inlineDynamicImports: true,
    },
    plugins: [
      json(),
      nodeResolvePlugin,
      commonjs({
        include: /node_modules/,
        sourceMap: true,
        transformMixedEsModules: true,
      }),
      typescript({ tsconfig: './tsconfig.base.json' }),
      babelPlugin,
      terser({
        output: {
          comments: (_, comment) => {
            if (comment.type === 'comment2') {
              return /Copyright/i.test(comment.value);
            }
            return false;
          }
        }
      }),
    ],
    context: 'window',
  },
  {
    input: 'src/indexBrowser.ts',
    output: {
      file: 'dist/artifacts/otel-web-legacy.js',
      format: 'iife',
      name: 'KloudMateRum',
      sourcemap: true,
      inlineDynamicImports: true,
    },
    plugins: [
      json(),
      nodeResolvePlugin,
      commonjs({
        include: /node_modules/,
        sourceMap: true,
        transformMixedEsModules: true,
      }),
      typescript({ tsconfig: './tsconfig.base.json' }),
      babel({
        babelHelpers: 'runtime',
        envName: 'legacy',
        extensions: ['.js', '.es6', '.es', 'mjs', '.ts'],
        exclude: [
          /node_modules\/core-js/
        ]
      }),
      terser({
        ecma: 5,
        output: {
          comments: (_, comment) => {
            if (comment.type === 'comment2') {
              return /Copyright/i.test(comment.value);
            }
            return false;
          }
        }
      }),
    ],
    context: 'window',
  },
  {
    input: 'integration-tests/otel-api-globals.ts',
    output: {
      file: 'dist/artifacts/otel-api-globals.js',
      format: 'iife',
      name: 'OtelApiGlobals',
      sourcemap: true,
      inlineDynamicImports: true,
    },
    plugins: [
      json(),
      nodeResolvePlugin,
      commonjs({
        include: /node_modules/,
        sourceMap: true,
        transformMixedEsModules: true,
      }),
      typescript({ tsconfig: './tsconfig.base.json' }),
      babelPlugin,
      terser({
        ecma: 5,
        output: {
          comments: (_, comment) => {
            if (comment.type === 'comment2') {
              return /Copyright/i.test(comment.value);
            }
            return false;
          }
        }
      }),
    ],
    context: 'window',
  }
];
