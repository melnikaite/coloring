import { defineConfig, Plugin } from 'vite';
import { promises as fs } from 'node:fs';
import path from 'node:path';

/**
 * After the build, list every file written into dist/assets/ and write it as
 * a JSON array of URL paths to dist/precache-manifest.json. The service
 * worker fetches this on install to precache the hashed JS/CSS bundle right
 * away, instead of waiting for the lazy cache-first fetch handler to pick
 * each file up one at a time on a later load.
 */
function precacheManifestPlugin(): Plugin {
  let outDir = 'dist';
  return {
    name: 'precache-manifest',
    configResolved(config) {
      outDir = path.resolve(config.root, config.build.outDir);
    },
    async closeBundle() {
      const assetsDir = path.join(outDir, 'assets');
      let files: string[] = [];
      try {
        files = await fs.readdir(assetsDir);
      } catch {
        return; // no assets dir (nothing to precache) - not fatal.
      }
      const urls = files.map((f) => `/assets/${f}`);
      await fs.writeFile(path.join(outDir, 'precache-manifest.json'), JSON.stringify(urls));
    },
  };
}

export default defineConfig({
  server: {
    port: 5199,
    strictPort: true,
  },
  preview: {
    port: 5199,
    strictPort: true,
  },
  build: {
    target: 'es2020',
  },
  plugins: [precacheManifestPlugin()],
});
