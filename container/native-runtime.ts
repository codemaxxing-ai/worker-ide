import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, readdir, readFile, readlink, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import type { NativePreviewSourceEntry } from '../shared/native-preview';
import type { InlineConfig, Plugin, PluginOption, ViteDevServer } from 'vite';

const SOURCE = '/workspace';
const ROOT = '/tmp/worker-ide-preview';
const ARTIFACTS = '/tmp/worker-ide-builds';
const MANAGER_PORT = 8788;
const PREVIEW_PORT = 5173;
const MAX_ARTIFACT_BYTES = 8 * 1024 * 1024;
const EXCLUDED = new Set(['.git', '.agent', 'node_modules', '.cache', '.bun', '.next', 'dist', 'coverage', 'tmp']);
let server: ViteDevServer | undefined;
let serverConfiguration: string | undefined;
let starting: Promise<void> | undefined;

async function readOptional(file: string): Promise<Buffer | undefined> {
	try {
		return await readFile(file);
	} catch {
		return;
	}
}

function isSourceEntry(value: unknown): value is NativePreviewSourceEntry {
	if (!value || typeof value !== 'object' || !('path' in value) || typeof value.path !== 'string' || !('type' in value)) return false;
	if (value.type === 'directory') return true;
	if (value.type === 'file') return 'contents' in value && typeof value.contents === 'string';
	return value.type === 'symlink' && 'target' in value && typeof value.target === 'string';
}

async function syncSource(entries: NativePreviewSourceEntry[]): Promise<void> {
	await mkdir(ROOT, { recursive: true });
	const retained = new Set(entries.map((entry) => entry.path));
	const prune = async (directory = ROOT, prefix = ''): Promise<void> => {
		for (const entry of await readdir(directory, { withFileTypes: true })) {
			if (EXCLUDED.has(entry.name)) continue;
			const name = `${prefix}${entry.name}`;
			const output = path.join(directory, entry.name);
			if (!retained.has(name)) await rm(output, { force: true, recursive: true });
			else if (entry.isDirectory()) await prune(output, `${name}/`);
		}
	};
	await prune();
	for (const entry of entries) {
		if (!entry.path || entry.path.startsWith('/') || entry.path.split('/').some((part) => part === '..' || EXCLUDED.has(part)))
			throw new Error('Invalid native source path');
		const output = path.resolve(ROOT, entry.path);
		if (!output.startsWith(`${ROOT}/`)) throw new Error('Native source escapes its staging root');
		const metadata = await lstat(output).catch(() => {});
		if (entry.type === 'directory') {
			if (metadata && !metadata.isDirectory()) await rm(output, { force: true });
			await mkdir(output, { recursive: true });
			continue;
		}
		await mkdir(path.dirname(output), { recursive: true });
		if (entry.type === 'symlink') {
			const resolved = entry.target.startsWith('/')
				? path.resolve(SOURCE, `.${entry.target}`)
				: path.resolve(SOURCE, path.dirname(entry.path), entry.target);
			if (resolved !== SOURCE && !resolved.startsWith(`${SOURCE}/`)) throw new Error('Native symlink escapes the workspace');
			const target = path.relative(path.dirname(output), path.join(ROOT, path.relative(SOURCE, resolved)));
			if ((await readlink(output).catch(() => {})) === target) continue;
			await rm(output, { force: true, recursive: true });
			await symlink(target, output);
			continue;
		}
		const bytes = Buffer.from(entry.contents, 'base64');
		const previous = metadata?.isFile() ? await readOptional(output) : undefined;
		if (previous?.equals(bytes)) continue;
		if (metadata && !metadata.isFile()) await rm(output, { force: true, recursive: true });
		await writeFile(output, bytes);
	}
}

async function prepare(): Promise<void> {
	const hash = createHash('sha256');
	for (const filename of ['package.json', 'bun.lock', 'bun.lockb', 'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml']) {
		hash.update(filename);
		hash.update((await readOptional(path.join(ROOT, filename))) ?? '');
	}
	const dependenciesHash = hash.digest('hex');
	const marker = '/tmp/worker-ide-native-dependencies';
	const dependencies = path.join(ROOT, 'node_modules');
	const metadata = await lstat(dependencies).catch(() => {});
	if (metadata?.isSymbolicLink()) await rm(dependencies, { force: true });
	const previousMarker = await readOptional(marker);
	if (previousMarker?.toString() !== dependenciesHash) {
		execFileSync('bun', ['install', '--no-save'], { cwd: ROOT, stdio: 'inherit' });
		await writeFile(marker, dependenciesHash);
	}
}

async function flattenPlugins(options: PluginOption[]): Promise<Plugin[]> {
	const plugins: Plugin[] = [];
	for (const option of options) {
		const resolved = await option;
		if (!resolved) continue;
		if (Array.isArray(resolved)) {
			plugins.push(...(await flattenPlugins(resolved)));
			continue;
		}
		// The IDE owns Worker hosting and bindings; native Vite owns the frontend.
		if (!resolved.name.includes('cloudflare')) plugins.push(resolved);
	}
	return plugins;
}

async function loadConfiguration(command: 'serve' | 'build') {
	process.chdir(ROOT);
	const parent = pathToFileURL(path.join(ROOT, 'package.json')).href;
	const vite: typeof import('vite') = await import(import.meta.resolve('vite', parent));
	const loaded = await vite.loadConfigFromFile({ command, mode: command === 'serve' ? 'development' : 'production' }, undefined, ROOT);
	const manifest: unknown = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8'));
	const vinext = Boolean(
		manifest &&
		typeof manifest === 'object' &&
		['dependencies', 'devDependencies'].some((field) => {
			const dependencies: unknown = Reflect.get(manifest, field);
			return dependencies && typeof dependencies === 'object' && typeof Reflect.get(dependencies, 'vinext') === 'string';
		}),
	);
	const config: InlineConfig = {
		...loaded?.config,
		root: path.resolve(ROOT, loaded?.config.root ?? '.'),
		configFile: false,
		plugins: await flattenPlugins(loaded?.config.plugins ?? []),
	};
	if (vinext && !loaded) {
		const framework: typeof import('vinext') = await import(import.meta.resolve('vinext', parent));
		config.plugins = framework.default();
	}
	return { vite, config, vinext };
}

async function startPreview(origin: string, ideOrigin: string): Promise<void> {
	const { vite, config } = await loadConfiguration('serve');
	const url = new URL(origin);
	const configuration = createHash('sha256')
		.update(JSON.stringify({ origin, ideOrigin }))
		.update(await readFile(path.join(ROOT, 'package.json')));
	for (const file of [
		'bun.lock',
		'bun.lockb',
		'package-lock.json',
		'yarn.lock',
		'pnpm-lock.yaml',
		'vite.config.ts',
		'vite.config.js',
		'vite.config.mts',
		'vite.config.mjs',
		'vite.config.cts',
		'vite.config.cjs',
	])
		configuration.update((await readOptional(path.join(ROOT, file))) ?? '');
	const key = configuration.digest('hex');
	if (server && serverConfiguration === key) return;
	await server?.close();
	server = undefined;
	serverConfiguration = undefined;
	const next = await vite.createServer({
		...config,
		server: {
			...config.server,
			host: '0.0.0.0',
			port: PREVIEW_PORT,
			strictPort: true,
			open: false,
			allowedHosts: [url.hostname],
			fs: { strict: true, allow: [ROOT] },
			watch: { ...config.server?.watch, usePolling: true },
			hmr: {
				protocol: url.protocol === 'https:' ? 'wss' : 'ws',
				host: url.hostname,
				clientPort: Number(url.port) || (url.protocol === 'https:' ? 443 : 80),
				path: '/__native-hmr',
			},
		},
	});
	await next.listen();
	server = next;
	serverConfiguration = key;
}

async function collectFiles(directory: string, prefix = ''): Promise<Record<string, string>> {
	const files: Record<string, string> = {};
	for (const entry of await readdir(directory, { withFileTypes: true })) {
		const file = path.join(directory, entry.name);
		const name = `${prefix}${entry.name}`;
		if (entry.isDirectory()) Object.assign(files, await collectFiles(file, `${name}/`));
		else if (entry.isFile()) {
			const bytes = await readFile(file);
			files[name] = bytes.toString('base64');
		} else throw new Error('Build output must contain regular files');
	}
	return files;
}

async function build(identifier: string): Promise<void> {
	if (!/^[a-f\d-]{36}$/.test(identifier)) throw new Error('Invalid native build identifier');
	await prepare();
	const { vite, config, vinext } = await loadConfiguration('build');
	const output = path.join(ARTIFACTS, identifier);
	await mkdir(output, { recursive: true });
	let serverModules: Record<string, string> | undefined;
	let mainModule: string | undefined;
	let clientDirectory = path.join(output, 'client');
	if (vinext) {
		const builder = await vite.createBuilder({
			...config,
			plugins: [
				...(config.plugins ?? []),
				{
					name: 'worker-ide-worker-entry',
					enforce: 'post',
					config(inline) {
						inline.ssr ??= {};
						inline.ssr.external = [];
						inline.ssr.noExternal = true;
						for (const [name, environment] of Object.entries(inline.environments ?? {})) {
							if (name === 'client') continue;
							environment.resolve ??= {};
							environment.resolve.external = [];
							environment.resolve.noExternal = true;
						}
					},
					configEnvironment(name) {
						if (name !== 'rsc') return;
						const options = { input: { index: 'vinext/server/app-router-entry' } };
						return { build: { rollupOptions: options, rolldownOptions: options } };
					},
				},
			],
		});
		await builder.buildApp();
		const serverDirectory = path.resolve(builder.environments.rsc.config.root, builder.environments.rsc.config.build.outDir);
		clientDirectory = path.resolve(builder.environments.client.config.root, builder.environments.client.config.build.outDir);
		const esbuild: typeof import('esbuild') = await import('esbuild');
		await esbuild.build({
			entryPoints: [path.join(serverDirectory, 'index.js')],
			outdir: path.join(output, 'server'),
			bundle: true,
			splitting: true,
			format: 'esm',
			platform: 'neutral',
			conditions: ['workerd', 'worker'],
			mainFields: ['module', 'main'],
			external: ['node:*', 'cloudflare:*'],
			define: { 'process.env.NODE_ENV': '"production"', 'import.meta.url': '"file:///worker.js"' },
			banner: {
				js: "import { createRequire as createWorkerRequire } from 'node:module'; var require = createWorkerRequire('file:///worker.js');",
			},
		});
		const encoded = await collectFiles(path.join(output, 'server'));
		serverModules = Object.fromEntries(
			Object.entries(encoded).map(([name, bytes]) => [name, Buffer.from(bytes, 'base64').toString('utf8')]),
		);
		mainModule = 'index.js';
	} else {
		await vite.build({ ...config, build: { ...config.build, outDir: clientDirectory, emptyOutDir: true, write: true } });
	}
	const clientFiles = await collectFiles(clientDirectory);
	const size =
		Object.values(clientFiles).reduce((total, bytes) => total + Buffer.byteLength(bytes, 'base64'), 0) +
		Object.values(serverModules ?? {}).reduce((total, code) => total + Buffer.byteLength(code), 0);
	if (size > MAX_ARTIFACT_BYTES) throw new Error('Native build exceeds the 8 MiB artifact limit');
	await writeFile(`${output}.json`, JSON.stringify({ clientFiles, serverModules, mainModule }));
}

function serveManager(): void {
	createServer(async (request, response) => {
		try {
			const url = new URL(request.url ?? '/', 'http://container');
			if (request.method === 'GET' && url.pathname === '/artifact') {
				const identifier = url.searchParams.get('id') ?? '';
				if (!/^[a-f\d-]{36}$/.test(identifier)) throw new Error('Invalid artifact identifier');
				const filename = path.join(ARTIFACTS, `${identifier}.json`);
				const metadata = await stat(filename);
				if (metadata.size > MAX_ARTIFACT_BYTES * 2) throw new Error('Artifact response exceeds its limit');
				response.setHeader('Content-Type', 'application/json');
				createReadStream(filename).pipe(response);
				return;
			}
			if (request.method === 'POST' && url.pathname === '/sync') {
				request.setEncoding('utf8');
				let body = '';
				for await (const chunk of request) {
					if (typeof chunk !== 'string') throw new Error('Invalid source transfer');
					body += chunk;
					if (Buffer.byteLength(body) > 16 * 1024 * 1024) throw new Error('Source transfer exceeds its limit');
				}
				const entries: unknown = JSON.parse(body);
				if (!Array.isArray(entries) || !entries.every((entry) => isSourceEntry(entry))) throw new Error('Invalid native source entries');
				await syncSource(entries);
				response.end('ok');
				return;
			}
			if (request.method === 'POST' && url.pathname === '/start') {
				const origin = request.headers['x-preview-origin'];
				const ideOrigin = request.headers['x-ide-origin'];
				if (typeof origin !== 'string' || typeof ideOrigin !== 'string') throw new Error('Preview origins are required');
				starting ??= startPreview(origin, ideOrigin).finally(() => {
					starting = undefined;
				});
				await starting;
				response.end('ok');
				return;
			}
			response.writeHead(404).end();
		} catch (error) {
			console.error(error);
			response.writeHead(500).end(String(error));
		}
	}).listen(MANAGER_PORT, '0.0.0.0');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	try {
		switch (process.argv[2]) {
			case 'serve': {
				serveManager();
				break;
			}
			case 'build': {
				await build(process.env.WORKER_IDE_BUILD_ID ?? '');
				break;
			}
			case 'prepare': {
				await prepare();
				const response = await fetch(`http://127.0.0.1:${MANAGER_PORT}/start`, {
					method: 'POST',
					headers: {
						'x-preview-origin': process.env.WORKER_IDE_PREVIEW_ORIGIN ?? '',
						'x-ide-origin': process.env.WORKER_IDE_APP_ORIGIN ?? '',
					},
				});
				if (!response.ok) throw new Error(await response.text());

				break;
			}
			default: {
				throw new Error('Unknown native runtime operation');
			}
		}
	} catch (error) {
		console.error(error);
		process.exitCode = 1;
	}
}
