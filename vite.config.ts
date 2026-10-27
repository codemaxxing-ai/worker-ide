import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { TLSSocket } from 'node:tls';
import { fileURLToPath } from 'node:url';

import { cloudflare } from '@cloudflare/vite-plugin';
import tailwindcss from '@tailwindcss/vite';
import basicSsl from '@vitejs/plugin-basic-ssl';
import react from '@vitejs/plugin-react';
import { defineConfig, transformWithEsbuild } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

import { DEFAULT_EDITOR_FONT, EDITOR_FONT_FAMILIES } from './shared/constants/editor-fonts';
import { appManifestMetadata } from './src/lib/app-metadata';

import type { Plugin, ResolvedConfig } from 'vite';
import type { ManifestOptions } from 'vite-plugin-pwa';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const commitHash = execSync('git rev-parse HEAD').toString().trim();
function applyDefines(code: string, defines: Record<string, string>): string {
	let result = code;
	for (const [token, value] of Object.entries(defines)) {
		result = result.replaceAll(token, value);
	}
	return result;
}
async function minifyAndHash(code: string, filePath: string): Promise<{ source: string; hash: string }> {
	const result = await transformWithEsbuild(code, filePath, {
		minify: true,
		legalComments: 'none',
	});
	const digest = createHash('sha256').update(result.code).digest('base64');
	return { source: result.code, hash: `sha256-${digest}` };
}

/**
 * Import any `.js` file as a minified source string + SRI hash via `?raw-minified`.
 *
 * Supports an optional `define` map for build-time token replacement (applied
 * before minification so that the replaced values are also minified).
 */
function rawMinifiedPlugin(options?: { define?: Record<string, string> }): Plugin {
	const defines = options?.define ?? {};

	return {
		name: 'raw-minified',
		enforce: 'pre',
		async resolveId(source, importer) {
			if (!source.endsWith('?raw-minified')) return;
			const rawPath = source.slice(0, -'?raw-minified'.length);

			if (rawPath.startsWith('.') || path.isAbsolute(rawPath)) {
				const resolved = importer ? path.resolve(path.dirname(importer), rawPath) : rawPath;
				return resolved + '?raw-minified';
			}

			// Bare module specifier — resolve via import.meta.resolve to avoid Vite's dep optimizer
			const resolved = await import.meta.resolve(rawPath);
			return fileURLToPath(resolved) + '?raw-minified';
		},
		async load(id) {
			if (!id.endsWith('?raw-minified')) return;
			const filePath = id.slice(0, -'?raw-minified'.length);

			const raw = applyDefines(readFileSync(filePath, 'utf8'), defines);
			const { source, hash } = await minifyAndHash(raw, filePath);

			return `export const source = ${JSON.stringify(source)};\nexport const hash = ${JSON.stringify(hash)};\nexport default source;`;
		},
	};
}

/**
 * Emit the FOUC-prevention script as an external, render-blocking `<script>` in `<head>`.
 *
 * - **Dev**: serves the token-replaced script at a virtual URL via middleware.
 * - **Build**: minifies, emits as a content-hashed asset with a deterministic
 *   filename, and injects `<script src="/assets/fouc-prevention-<hash>.js">`
 *   into the HTML.
 *
 * Tokens (`__DEFAULT_EDITOR_FONT__`, `__EDITOR_FONT_FAMILIES__`) are replaced
 * with values from `shared/constants/editor-fonts.ts` so that `index.html`
 * never contains hardcoded font definitions.
 */
function foucPreventionPlugin(): Plugin {
	const scriptPath = path.resolve(__dirname, 'src/lib/fouc-prevention.js');
	const virtualUrl = '/@fouc-prevention.js';

	const defines: Record<string, string> = {
		__DEFAULT_EDITOR_FONT__: JSON.stringify(DEFAULT_EDITOR_FONT),
		__EDITOR_FONT_FAMILIES__: JSON.stringify(EDITOR_FONT_FAMILIES),
	};

	let resolvedConfig: ResolvedConfig;
	let assetFileName: string;

	function processScript(): string {
		return applyDefines(readFileSync(scriptPath, 'utf8'), defines);
	}

	return {
		name: 'fouc-prevention',

		configResolved(config) {
			resolvedConfig = config;
		},

		// Dev: serve the processed script at a virtual URL
		configureServer(server) {
			server.middlewares.use(virtualUrl, (_request, response) => {
				response.setHeader('Content-Type', 'application/javascript');
				response.setHeader('Cache-Control', 'no-cache');
				response.end(processScript());
			});
		},

		// Build: emit the minified script as a content-hashed asset.
		// We compute the hash ourselves and use an explicit `fileName` so
		// the value is deterministic and known before transformIndexHtml runs
		// (no reliance on __VITE_ASSET__ placeholder resolution in HTML).
		async buildStart() {
			if (resolvedConfig.command !== 'build') return;
			const { source } = await minifyAndHash(processScript(), scriptPath);
			// Use the first 8 hex chars of a content hash for a deterministic filename.
			const contentHash = createHash('sha256').update(source).digest('hex').slice(0, 8);
			assetFileName = `assets/fouc-prevention-${contentHash}.js`;
			this.emitFile({
				type: 'asset',
				fileName: assetFileName,
				source,
			});
		},

		// Inject a render-blocking <script src="..."> at the top of <head>
		transformIndexHtml() {
			const source = resolvedConfig.command === 'serve' ? virtualUrl : `/${assetFileName}`;
			return [{ tag: 'script', attrs: { src: source }, injectTo: 'head-prepend' }];
		},
	};
}

/**
 * Prevent Vite from statically detecting `new URL('biome_wasm_bg.wasm', import.meta.url)`
 * in @biomejs/wasm-web and trying to emit the WASM as a bundled asset.
 *
 * Both client and server now pass the WASM module explicitly to the init function,
 * so this default URL inside @biomejs/wasm-web is never used. We replace it with a
 * no-op URL to stop Vite's asset pipeline from processing the original 27+ MiB file.
 *
 * The optimized WASM lives in vendor/biome_wasm_bg.wasm (created by scripts/vendor-wasm.ts).
 */
function biomeWasmNoopPlugin(): Plugin {
	return {
		name: 'biome-wasm-noop',
		enforce: 'pre',
		transform(code, id) {
			if (!id.includes('@biomejs/wasm-web')) return;
			return code.replace(`new URL('biome_wasm_bg.wasm', import.meta.url)`, `new URL('about:blank')`);
		},
	};
}

function justBashWorkerdPlugin(): Plugin {
	return {
		name: 'just-bash-workerd',
		enforce: 'pre',
		transform(code, id) {
			if (!id.includes('node_modules/just-bash/dist/bundle/')) return;
			return code.replaceAll('import.meta.url', JSON.stringify('file:///shell.js'));
		},
	};
}

/** Cloudflare Vite's upgrade adapter reads forwarded protocol instead of the TLS socket. */
function httpsWebSocketPlugin(): Plugin {
	return {
		name: 'https-websocket',
		configureServer(server) {
			server.httpServer?.prependListener('upgrade', (request) => {
				request.headers['x-forwarded-proto'] = request.socket instanceof TLSSocket && request.socket.encrypted ? 'https' : 'http';
				const protocol = request.headers['sec-websocket-protocol'];
				if (request.url?.split('?')[0] !== '/__native-hmr' || typeof protocol !== 'string' || !protocol.startsWith('vite')) return;
				// The Cloudflare adapter otherwise reserves every Vite socket for the editor.
				// It copies headers synchronously before awaiting the Worker response.
				request.headers['sec-websocket-protocol'] = `worker-ide-${protocol}`;
				queueMicrotask(() => {
					// Preserve the browser's offered protocol for the outer upgrade handshake.
					request.headers['sec-websocket-protocol'] = protocol;
				});
			});
		},
	};
}

const appManifest: Partial<ManifestOptions> = { ...appManifestMetadata };

export default defineConfig(({ command }) => ({
	plugins: [
		httpsWebSocketPlugin(),
		basicSsl({ domains: ['localhost', 'content.localhost', '*.content.localhost', 'git.localhost'], certDir: '.local-certificates' }),
		rawMinifiedPlugin(),
		foucPreventionPlugin(),
		biomeWasmNoopPlugin(),
		justBashWorkerdPlugin(),
		tailwindcss(),
		react(),
		cloudflare({
			configPath: './wrangler.jsonc',
			config:
				command === 'serve'
					? { vars: { APP_ORIGIN: 'https://localhost:3000', CONTENT_ORIGIN: 'https://content.localhost:3000' } }
					: undefined,
			auxiliaryWorkers: [
				{ configPath: './auxiliary/biome/wrangler.jsonc' },
				{ configPath: './auxiliary/esbuild/wrangler.jsonc' },
				{ configPath: './auxiliary/vite-host/wrangler.jsonc' },
				{ configPath: './auxiliary/push/wrangler.jsonc' },
				{ configPath: './auxiliary/email/wrangler.jsonc' },
			],
		}),
		VitePWA({
			registerType: 'prompt',
			manifest: appManifest,
			workbox: {
				navigateFallback: '/index.html',
				navigateFallbackDenylist: [/^\/api\//, /^\/p\//, /^\/docs/],
				globPatterns: ['**/*.{js,css,html,ico,png,svg,woff2}'],
				runtimeCaching: [
					{
						urlPattern: ({ sameOrigin, url }) =>
							sameOrigin &&
							!url.pathname.startsWith('/api/') &&
							!url.pathname.startsWith('/p/') &&
							!url.pathname.startsWith('/docs') &&
							!/\.[^/]+$/.test(url.pathname),
						handler: 'NetworkFirst',
						options: {
							cacheName: 'app-shell',
							networkTimeoutSeconds: 3,
							cacheableResponse: {
								statuses: [200],
							},
						},
					},
				],
				importScripts: ['/push-sw.js'],
			},
			devOptions: {
				enabled: true,
			},
		}),
	],
	define: {
		__APP_VERSION__: JSON.stringify(commitHash),
	},
	resolve: {
		alias: {
			'@': path.resolve(__dirname, './src'),
			'@shared': path.resolve(__dirname, './shared'),
			'@server': path.resolve(__dirname, './worker'),
			'@worker': path.resolve(__dirname, './worker'),
			'esbuild-wasm': 'esbuild-wasm/lib/browser.js',
			// Force just-bash's code-split ESM entry instead of its `browser` export
			// (which the Workers build would otherwise pick). The browser build inlines
			// every optional command and runs turndown's `require()` at module load,
			// which is fatal in the Workers runtime; the main build keeps them lazy.
			'just-bash': path.resolve(__dirname, 'node_modules/just-bash/dist/bundle/index.js'),
		},
	},
	optimizeDeps: {
		exclude: ['@biomejs/wasm-web'],
	},
	build: {
		sourcemap: true,
		rollupOptions: {
			output: {
				manualChunks: {
					// CodeMirror core + extensions (~350KB)
					codemirror: [
						'@codemirror/autocomplete',
						'@codemirror/commands',
						'@codemirror/lang-css',
						'@codemirror/lang-html',
						'@codemirror/lang-javascript',
						'@codemirror/lang-json',
						'@codemirror/language',
						'@codemirror/lint',
						'@codemirror/search',
						'@codemirror/state',
						'@codemirror/view',
						'@lezer/common',
						'@lezer/highlight',
						'@lezer/javascript',
						'@lezer/css',
						'@lezer/html',
						'@lezer/json',
					],
					// React ecosystem (~200KB)
					react: ['react', 'react-dom', 'react/jsx-runtime', 'scheduler'],
					// UI libraries (~100KB)
					ui: ['@base-ui/react', 'class-variance-authority', 'clsx', 'tailwind-merge', 'lucide-react'],
					// Data layer (~50KB)
					data: ['@tanstack/react-query', 'zustand', 'hono/client'],
				},
			},
		},
	},
	esbuild: {
		supported: {
			decorators: false,
		},
	},
	server: {
		// Freeze the host source during E2E runs; project preview HMR uses its own runtime.
		// eslint-disable-next-line unicorn/no-null -- Vite disables file watching with null.
		watch: process.env.WORKER_IDE_E2E === '1' ? null : undefined,
		cors: false,
		port: 3000,
		host: '0.0.0.0',
		// Preview hosts use signed flat labels under content.localhost.
		allowedHosts: ['.localhost'],
	},
}));
