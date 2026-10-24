import { defineConfig } from 'vite';

export default defineConfig({
  // relative paths, so the build also works under a sub-path like /papr/
  base: './',
  build: { target: 'es2022' },
});
