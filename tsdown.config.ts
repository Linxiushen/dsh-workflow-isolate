import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    protocol: 'src/protocol.ts',
    worker: 'src/worker.ts',
  },
  clean: true,
  dts: true,
  fixedExtension: false,
  format: 'esm',
  platform: 'node',
  sourcemap: true,
  target: 'node22',
  deps: {
    neverBundle: [
      '@deepseek-ai/cordis',
      '@deepseek-ai/dsh-agent',
      '@deepseek-ai/dsh-llm',
      '@deepseek-ai/dsh-subagent',
      '@deepseek-ai/dsh-tools',
      '@deepseek-ai/dsh-workflow',
      'quickjs-emscripten',
    ],
  },
})
