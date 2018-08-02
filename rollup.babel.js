import {rollup} from 'rollup';
import babel from 'rollup-plugin-babel';

export default [
  {
    input: 'src/Potree.js',
    output: {
      file: 'build/potree.es5.js',
      format: 'cjs',
      sourcemap: true,
    },
    plugins: [
      babel({
        exclude: 'node_modules/**',
      }),
    ],
  },
  {
    input: 'src/PotreeCore.js',
    output: {
      file: 'build/potree-core.es5.js',
      format: 'cjs',
      sourcemap: true,
    },
    plugins: [
      babel({
        exclude: 'node_modules/**',
      }),
    ],
  },
  {
    input: 'src/workers/BinaryDecoderWorker.js',
    output: {
      file: 'build/BinaryDecoderWorker.es5.js',
      format: 'cjs',
      sourcemap: true,
    },
    plugins: [
      babel({
        exclude: 'node_modules/**',
      }),
    ],
  },
  {
    input: 'src/workers/LASDecoderWorker.js',
    output: {
      file: 'build/LASDecoderWorker.es5.js',
      format: 'cjs',
      sourcemap: true,
    },
    plugins: [
      babel({
        exclude: 'node_modules/**',
      }),
    ],
  },
  {
    input: 'src/workers/LASLAZWorker.js',
    output: {
      file: 'build/LASLAZWorker.es5.js',
      format: 'cjs',
      sourcemap: true,
    },
    plugins: [
      babel({
        exclude: 'node_modules/**',
      }),
    ],
  },
];
