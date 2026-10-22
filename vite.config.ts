import { defineConfig } from 'vite';

export default defineConfig({
  // relative paths, so the build also works under a sub-path like /rotopaper/
  base: './',
  build: { target: 'es2022' },
});
